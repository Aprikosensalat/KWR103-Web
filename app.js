import { KWR103, LIMITS } from './kwr103.js';
import { TimePlot } from './plot.js';
import { RunStore, Recorder, runToCsv, fileName, makeZip } from './runs.js';
import { LogViewer } from './viewer.js';

const $ = (id) => document.getElementById(id);
const psu = new KWR103();
const store = new RunStore();
const storeOpened = store.open(); // sofort öffnen; Schreibzugriffe warten darauf
const rec = new Recorder(store, () => scheduleFilesRefresh());

const MAX_HISTORY = 500_000;

const state = {
  polling: true,
  pollTimer: null,
  outputOn: false,
  busy: false, // Verbindungsaufbau läuft
  history: [],
  energyWh: 0,
  chargeAh: 0,
  status: null, // letztes STATUS?-Ergebnis
  chg: null, // laufende Ladung, siehe startCharge()
};
const chgActive = () => state.chg?.running === true;
const avg = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
const near = (a, b) => Math.abs(a - b) <= Math.max(0.0015, Math.abs(b) * 1e-3);

function storageGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// ---------- Protokoll ----------
const logEl = $('log');
function log(kind, text) {
  const line = document.createElement('div');
  line.className = kind;
  const prefix = { tx: '→ ', rx: '← ', err: '! ', info: '· ' }[kind] ?? '';
  line.textContent = `${new Date().toLocaleTimeString()}  ${prefix}${text}`;
  logEl.appendChild(line);
  while (logEl.childElementCount > 500) logEl.firstChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
}
psu.onLog = (kind, text) => {
  // Routineabfragen nicht ins Log schreiben
  if (kind !== 'err' && /^(VOUT\?|IOUT\?|STATUS\?|OUT\?|0x[0-9a-f]{2}|\d+\.\d+|[01])$/.test(text)) return;
  log(kind, text);
};

// ---------- Reiter ----------
const tabButtons = [...document.querySelectorAll('[data-tab]')];
function showTab(name) {
  if (!tabButtons.some((b) => b.dataset.tab === name)) name = tabButtons[0].dataset.tab;
  for (const b of tabButtons) {
    const active = b.dataset.tab === name;
    b.setAttribute('aria-selected', String(active));
    $(`tab-${b.dataset.tab}`).hidden = !active;
  }
  storageSet('kwr103.tab', name);
}
for (const b of tabButtons) b.addEventListener('click', () => showTab(b.dataset.tab));

// ---------- UI-Zustand ----------
function updateControls() {
  const connected = psu.connected;
  const free = connected && !state.busy && !chgActive();
  $('btnConnect').textContent = connected ? 'Trennen' : 'Verbinden';
  $('status').textContent = connected ? 'verbunden' : 'getrennt';
  $('status').classList.toggle('on', connected);
  $('btnOutput').disabled = !connected || state.busy;
  for (const id of ['setV', 'setI', 'btnApply', 'btnMemRecall', 'btnMemSave', 'sysBeep', 'sysLock', 'sysSense',
    'btnOvpSet', 'ovpOn', 'btnOcpSet', 'btnChgStart', 'cmd', 'btnSend']) {
    $(id).disabled = !free;
  }
  $('btnPoll').disabled = !connected || state.busy;
  $('btnChgStop').disabled = !connected || !chgActive();
  for (const id of ['chgPreset', 'chgVend', 'chgI', 'chgIoff', 'chgToff', 'chgVmin', 'chgTmax']) $(id).disabled = chgActive();
  document.querySelector('[data-tab="charge"]').classList.toggle('running', chgActive());
  if (!connected) {
    $('idn').textContent = '—';
    $('devFlags').hidden = true;
    setOutputUI(false);
  }
}

function setOutputUI(on) {
  const was = state.outputOn;
  state.outputOn = on;
  const btn = $('btnOutput');
  btn.textContent = on ? 'Ausgang AUS' : 'Ausgang EIN';
  btn.classList.toggle('is-on', on);
  $('outputState').textContent = on ? 'Ausgang an' : 'Ausgang aus';
  $('outputState').classList.toggle('on', on);
  if (!on && rec.run?.endOnInputOff) rec.end('Ausgang aus');
  // Ausgang ohne Ladung eingeschaltet (Knopf oder am Gerät) -> eigene Datei „Manuell“
  if (on && !was && !rec.active && !chgActive() && !state.busy && psu.connected) {
    const set = $('curSet').textContent;
    rec.start('manual', `Manuell – ${set}`, { endOnInputOff: true, params: { Sollwerte: set } });
  }
}

function setFlag(id, on, onText, offText, onCls = 'on') {
  $(id).textContent = on ? onText : offText;
  $(id).className = `status ${on ? onCls : 'off'}`;
}

function renderStatus(st) {
  state.status = st;
  $('devFlags').hidden = false;
  if (st.output) setFlag('flagMode', true, st.cv ? 'CV (Spannung geregelt)' : 'CC (Strombegrenzung)', '', st.cv ? 'on' : 'warn');
  else setFlag('flagMode', false, '', 'Ausgang aus');
  setFlag('flagOvp', st.ovp, 'OVP aktiv', 'OVP aus');
  setFlag('flagLock', st.lock, 'Tasten gesperrt', 'Tasten frei', 'warn');
  $('sysBeep').checked = st.beep;
  $('sysLock').checked = st.lock;
  $('ovpOn').checked = st.ovp;
  if (st.output !== state.outputOn) setOutputUI(st.output);
}

async function refreshSetpoints() {
  const v = await psu.getVoltageSet();
  const i = await psu.getCurrentSet();
  $('curSet').textContent = `${v.toFixed(3)} V / ${i.toFixed(3)} A`;
  $('setV').value = v;
  $('setI').value = i;
  return { v, i };
}

async function refreshSense() {
  const on = await psu.getSense();
  $('sysSense').checked = on;
  setFlag('flagSense', on, 'Remote Sense an', 'Remote Sense aus');
}

// ---------- Verbindung ----------
async function connect() {
  try {
    await psu.connect(Number($('baud').value), { usb: $('transport').value === 'usb' });
  } catch (e) {
    if (e.name !== 'NotFoundError') log('err', `Verbinden fehlgeschlagen: ${e.message}`);
    return;
  }
  log('info', 'Port geöffnet');
  state.busy = true; // Bedienung sperren, bis der Gerätezustand eingelesen ist
  updateControls();
  try {
    $('idn').textContent = await psu.identify();
    await refreshSetpoints();
    $('ovpV').value = await psu.getOVP();
    $('ocpI').value = await psu.getOCP();
    await refreshSense();
    const st = await psu.status();
    state.outputOn = st.output; // ohne „Manuell“-Datei für einen schon laufenden Ausgang
    renderStatus(st);
    setOutputUI(st.output);
  } catch (e) {
    log('err', `${e.message} – richtiger Port gewählt? Baudrate am Gerät prüfen.`);
  }
  state.busy = false;
  updateControls();
  schedulePoll(0);
}

async function disconnect() {
  stopPoll();
  if ($('offOnDisconnect').checked && psu.connected) {
    try { await psu.setOutput(false); } catch {}
  }
  await psu.disconnect();
}

psu.onDisconnect = () => {
  stopPoll();
  if (chgActive()) {
    finishCharge($('offOnDisconnect').checked
      ? 'Verbindung getrennt – Ausgang ausgeschaltet'
      : 'Verbindung getrennt – Ausgang bleibt an, Ladung wird nicht mehr überwacht!', 'fail');
  }
  rec.end('Verbindung getrennt');
  updateControls();
  log('info', 'Port geschlossen');
};

$('btnConnect').addEventListener('click', () => (psu.connected ? disconnect() : connect()));

// ---------- Grundsteuerung ----------
$('btnOutput').addEventListener('click', async () => {
  if (chgActive()) return stopCharge();
  try {
    await psu.setOutput(!state.outputOn);
    const st = await psu.status();
    renderStatus(st);
  } catch (e) {
    log('err', e.message);
  }
});

async function applySetpoints() {
  const v = Number($('setV').value);
  const i = Number($('setI').value);
  try {
    if (v * i > LIMITS.P) log('info', `Hinweis: ${v} V × ${i} A = ${(v * i).toFixed(0)} W – das Netzteil begrenzt auf ${LIMITS.P} W.`);
    await psu.setVoltage(v);
    await psu.setCurrent(i);
    rec.event(`Sollwerte ${v} V / ${i} A`);
    await refreshSetpoints();
  } catch (e) {
    log('err', e.message);
  }
}
$('btnApply').addEventListener('click', applySetpoints);
for (const id of ['setV', 'setI']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') applySetpoints(); });

// ---------- Messung / Aufzeichnung ----------
function schedulePoll(delay = Number($('interval').value)) {
  clearTimeout(state.pollTimer);
  if (state.polling && psu.connected) state.pollTimer = setTimeout(poll, delay);
}
function stopPoll() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

async function poll() {
  if (state.busy) return schedulePoll();
  const started = performance.now();
  try {
    const m = await psu.measure();
    const st = await psu.status();
    renderStatus(st);
    if (chgActive()) {
      // erst bewerten, dann Zeile schreiben, dann reagieren (damit die letzte Zeile in der Datei landet)
      const step = chargeEvaluate(m, st);
      addSample(m, step.extra);
      await chargeApply(step.action);
    } else {
      addSample(m);
    }
  } catch (e) {
    if (psu.connected) log('err', e.message);
  }
  const elapsed = performance.now() - started;
  schedulePoll(Math.max(0, Number($('interval').value) - elapsed));
}

function addSample({ v, i, p }, extra = {}) {
  const t = Date.now();
  const prev = state.history[state.history.length - 1];
  if (prev) {
    const dtH = (t - prev.t) / 3_600_000;
    state.energyWh += ((p + prev.p) / 2) * dtH;
    state.chargeAh += ((i + prev.i) / 2) * dtH;
  }
  state.history.push({ t, v, i, p, test: rec.run?.meta.name ?? '' });
  if (state.history.length > MAX_HISTORY) state.history.splice(0, MAX_HISTORY / 10);
  rec.add(t, v, i, p, extra);

  $('mV').textContent = v.toFixed(3);
  $('mI').textContent = i.toFixed(3);
  $('mP').textContent = p.toFixed(2);
  $('samples').textContent = state.history.length;
  $('energy').textContent = state.energyWh.toFixed(3);
  $('charge').textContent = state.chargeAh.toFixed(3);
  plot.requestDraw();
}

$('btnPoll').addEventListener('click', () => {
  state.polling = !state.polling;
  $('btnPoll').textContent = state.polling ? 'Pause' : 'Fortsetzen';
  state.polling ? schedulePoll(0) : stopPoll();
});
$('interval').addEventListener('change', () => schedulePoll());

$('btnClear').addEventListener('click', () => {
  state.history = [];
  state.energyWh = state.chargeAh = 0;
  $('samples').textContent = '0';
  $('energy').textContent = $('charge').textContent = '0.000';
  plot.setData(state.history);
});

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

const csvFormat = () => $('csvFormat').value;
$('csvFormat').value = storageGet('kwr103.csv') ?? 'de';
$('csvFormat').addEventListener('change', () => storageSet('kwr103.csv', csvFormat()));

$('btnCsv').addEventListener('click', () => {
  if (!state.history.length) return;
  const meta = {
    name: 'Gesamtverlauf', startT: state.history[0].t, endT: state.history[state.history.length - 1].t,
    params: {}, extraCols: [{ key: 'test', text: true }], noInfo: true,
  };
  downloadBlob(new Blob([runToCsv(meta, state.history, csvFormat())], { type: 'text/csv' }), fileName(meta));
});

// ---------- Verlaufsdiagramm ----------
const plot = new TimePlot($('plot'), [
  { key: 'v', label: 'Spannung', unit: 'V', color: '--c-volt', digits: 3, visible: true },
  { key: 'i', label: 'Strom', unit: 'A', color: '--c-curr', digits: 3, visible: true },
  { key: 'p', label: 'Leistung', unit: 'W', color: '--c-pow', digits: 2, visible: true },
]);
plot.setData(state.history);
for (const cb of document.querySelectorAll('[data-series]')) {
  cb.addEventListener('change', () => {
    plot.panels.find((p) => p.key === cb.dataset.series).visible = cb.checked;
    plot.requestDraw();
  });
}
$('window').addEventListener('change', () => {
  plot.windowMs = Number($('window').value);
  plot.requestDraw();
});

// ---------- Batterie laden ----------
const PRESETS = {
  liion: { vEnd: 4.2, vMin: 2.5 },
  lifepo4: { vEnd: 3.65, vMin: 2.0 },
  lead12: { vEnd: 14.4, vMin: 10.5 },
};
$('chgPreset').addEventListener('change', () => {
  const p = PRESETS[$('chgPreset').value];
  if (!p) return;
  $('chgVend').value = p.vEnd;
  $('chgVmin').value = p.vMin;
});
for (const id of ['chgVend', 'chgVmin']) $(id).addEventListener('input', () => { $('chgPreset').value = ''; });

// Ladeparameter im Browser merken
const CHG_FIELDS = ['chgVend', 'chgI', 'chgIoff', 'chgToff', 'chgVmin', 'chgTmax'];
for (const [id, v] of Object.entries(storageGet('kwr103.charge') ?? {})) if ($(id)) $(id).value = v;
for (const id of CHG_FIELDS) {
  $(id).addEventListener('change', () => storageSet('kwr103.charge', Object.fromEntries(CHG_FIELDS.map((f) => [f, $(f).value]))));
}

const BATT_DETECT_MS = 2000; // so lange muss der Spannungseinbruch stabil sein
const IGNORE_AFTER_START_MS = 5000; // Anlaufzeit, in der der Abschaltstrom nicht geprüft wird
const CHG_COLS = [
  { key: 'geladen_mAh', digits: 2 },
  { key: 'geladen_Wh', digits: 4 },
  { key: 'ladezeit_min', digits: 3 },
  { key: 'modus', text: true },
];

function chgMsg(text, cls = '') {
  const el = $('chgMsg');
  el.hidden = !text;
  el.textContent = text;
  el.className = `hint ${cls}`;
}

function setChgState(text, cls) {
  $('chgState').textContent = text;
  $('chgState').className = `status ${cls}`;
}

function readChargeForm() {
  const f = (id) => Number($(id).value);
  const p = { vEnd: f('chgVend'), iCharge: f('chgI'), iOff: f('chgIoff'), tOff: f('chgToff'), vMin: f('chgVmin'), tMax: f('chgTmax') };
  const check = (ok, msg) => { if (!ok) throw new Error(msg); };
  check(p.vEnd > 0 && p.vEnd <= LIMITS.V, `Die Ladeschlussspannung muss zwischen 0 und ${LIMITS.V} V liegen.`);
  check(p.iCharge >= 0.01 && p.iCharge <= LIMITS.I, `Der Ladestrom muss zwischen 0,01 und ${LIMITS.I} A liegen.`);
  check(p.vEnd * p.iCharge <= LIMITS.P, `Ladeschlussspannung × Ladestrom übersteigt ${LIMITS.P} W.`);
  check(p.iOff >= 0.01, 'Der Abschaltstrom muss mindestens 0,01 A sein (Messgenauigkeit des Netzteils ±3 mA).');
  check(p.iOff < p.iCharge, 'Der Abschaltstrom muss kleiner als der Ladestrom sein.');
  check(p.tOff >= 0 && p.tOff <= 3600, 'Die Abschaltdauer muss zwischen 0 und 3600 s liegen.');
  check(p.vMin >= 0 && p.vMin < p.vEnd, 'Die Mindestspannung muss unter der Ladeschlussspannung liegen.');
  check(p.tMax > 0 && p.tMax <= 100, 'Die maximale Ladezeit muss zwischen 0 und 100 h liegen.');
  return p;
}

const fmtNum = (x, d) => x.toFixed(d).replace('.', ',');
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function renderCharge() {
  const c = state.chg;
  if (!c) return;
  const now = c.endT ?? Date.now();
  const phaseText = {
    wait: 'Warte auf Batterie',
    charge: c.mode === 'CV' ? 'Laden (CV)' : 'Laden (CC)',
    done: 'beendet',
  }[c.phase];
  $('cPhase').textContent = phaseText;
  $('cVbat').textContent = c.vBat === null ? '—' : `${fmtNum(c.vBat, 3)} V`;
  $('cTime').textContent = c.chargeStartT ? fmtDur(now - c.chargeStartT) : '—';
  $('cAh').textContent = c.ah < 1 ? `${fmtNum(c.ah * 1000, 1)} mAh` : `${fmtNum(c.ah, 4)} Ah`;
  $('cWh').textContent = `${fmtNum(c.wh, 3)} Wh`;
  $('cBelow').textContent = c.phase === 'charge' && c.belowSince !== null
    ? `${Math.round((Date.now() - c.belowSince) / 1000)} / ${c.params.tOff} s`
    : '—';
}

async function startCharge() {
  let p;
  try {
    p = readChargeForm();
  } catch (e) {
    chgMsg(e.message, 'err');
    return;
  }
  state.busy = true;
  updateControls();
  try {
    if (state.outputOn) {
      await psu.setOutput(false);
      setOutputUI(false);
    }
    // CV = Ladeschlussspannung, Strombegrenzung 1 mA
    await psu.setVoltage(p.vEnd);
    await psu.setCurrent(0.001);
    const set = await refreshSetpoints();
    if (!near(set.v, p.vEnd) || !near(set.i, 0.001)) {
      throw new Error(`Das Netzteil hat die Werte nicht übernommen (gelesen: ${set.v} V / ${set.i} A).`);
    }
    if ($('chgClear').checked) $('btnClear').click();

    state.chg = {
      running: true, phase: 'wait', params: p, startT: Date.now(), endT: null,
      waitCond: null, waitSince: 0, waitV: [],
      vBat: null, chargeStartT: null, lastT: null, lastI: 0, lastP: 0, prevI: 0,
      ah: 0, wh: 0, belowSince: null, mode: 'CC', vLast: null,
    };
    rec.start('charge', `Ladung – ${p.vEnd} V / ${p.iCharge} A`, {
      params: {
        Ladeschlussspannung: `${p.vEnd} V`,
        Ladestrom: `${p.iCharge} A`,
        Abschaltstrom: `${p.iOff} A`,
        Abschaltdauer: `${p.tOff} s`,
        Mindestspannung: `${p.vMin} V`,
        'Max. Ladezeit': `${p.tMax} h`,
      },
      extraCols: CHG_COLS,
    });
    rec.setPhase('Warte auf Batterie');
    await psu.setOutput(true);
    const st = await psu.status();
    renderStatus(st);
    if (!st.output) throw new Error('Der Ausgang ließ sich nicht einschalten.');
    setChgState('wartet', 'run');
    chgMsg(`Ausgang an: ${p.vEnd} V mit 1 mA Strombegrenzung. Jetzt die Batterie anschließen (Plus an Plus) …`);
    log('info', `Ladung vorbereitet: ${p.vEnd} V, warte auf Batterie`);
  } catch (e) {
    chgMsg(e.message, 'err');
    log('err', `Ladung: ${e.message}`);
    try { await psu.setOutput(false); } catch {}
    if (chgActive()) finishCharge(`Fehler: ${e.message}`, 'fail');
  }
  state.busy = false;
  updateControls();
  renderCharge();
  schedulePoll(0);
}

/** Bewertet einen Messwert während der Ladung. Liefert Zusatzspalten und ggf. eine Aktion. */
function chargeEvaluate(m, st) {
  const c = state.chg;
  const p = c.params;
  const now = Date.now();
  let action = null;

  if (!st.output) {
    action = { type: 'abort', reason: 'Ausgang wurde ausgeschaltet (am Gerät oder durch eine Schutzschaltung)' };
  } else if (c.phase === 'wait') {
    // Batterie erkannt: Spannung bricht unter die Ladeschlussspannung ein, Netzteil in Strombegrenzung (1 mA)
    const tol = Math.max(0.05, p.vEnd * 0.01);
    const cond = m.v < p.vEnd - tol && !st.cv ? 'below' : m.v > p.vEnd + tol ? 'above' : null;
    if (cond !== c.waitCond) {
      c.waitCond = cond;
      c.waitSince = now;
      c.waitV = [];
    }
    if (cond) c.waitV.push(m.v);
    if (cond && now - c.waitSince >= BATT_DETECT_MS && c.waitV.length >= 2) {
      const vb = avg(c.waitV);
      c.vBat = vb;
      if (cond === 'above') {
        action = { type: 'refuse', reason: `Batteriespannung ${vb.toFixed(3)} V liegt über der Ladeschlussspannung ${p.vEnd} V` };
      } else if (vb < p.vMin) {
        action = { type: 'refuse', reason: `Batteriespannung ${vb.toFixed(3)} V liegt unter der Mindestspannung ${p.vMin} V` };
      } else {
        action = { type: 'startCharge', vBat: vb };
      }
    }
  } else if (c.phase === 'charge') {
    if (c.lastT !== null) {
      const dtH = (now - c.lastT) / 3_600_000;
      c.ah += ((m.i + c.lastI) / 2) * dtH;
      c.wh += ((m.p + c.lastP) / 2) * dtH;
    }
    c.lastT = now;
    c.lastI = m.i;
    c.lastP = m.p;
    const mode = st.cv ? 'CV' : 'CC';
    if (mode !== c.mode) rec.event(`Wechsel zu ${mode}`);
    c.mode = mode;
    rec.setPhase(`Laden ${mode}`);

    if (now - c.chargeStartT >= IGNORE_AFTER_START_MS) {
      if (m.i < p.iOff) {
        if (c.belowSince === null) c.belowSince = now;
        if (c.prevI > 3 * p.iOff) rec.event('Strom plötzlich abgefallen – Batterie getrennt?');
      } else {
        c.belowSince = null;
      }
      if (c.belowSince !== null && now - c.belowSince >= p.tOff * 1000) {
        action = { type: 'finish', reason: `Ladestrom ${p.tOff} s unter ${p.iOff} A – Ladung beendet`, cls: 'done' };
      }
    }
    c.prevI = m.i;
    if (!action && now - c.chargeStartT >= p.tMax * 3_600_000) {
      action = { type: 'finish', reason: `Maximale Ladezeit ${p.tMax} h erreicht – Ladung abgebrochen`, cls: 'fail' };
    }
  }
  c.vLast = m.v;

  const extra = {
    geladen_mAh: c.ah * 1000,
    geladen_Wh: c.wh,
    ladezeit_min: c.chargeStartT ? (now - c.chargeStartT) / 60000 : 0,
    modus: st.output ? (st.cv ? 'CV' : 'CC') : 'aus',
  };
  renderCharge();
  return { extra, action };
}

async function chargeApply(action) {
  if (!action || !chgActive()) return;
  const c = state.chg;
  try {
    if (action.type === 'startCharge') {
      await psu.setCurrent(c.params.iCharge);
      const set = await refreshSetpoints();
      if (!near(set.i, c.params.iCharge)) throw new Error(`Ladestrom nicht übernommen (gelesen ${set.i} A).`);
      c.phase = 'charge';
      c.chargeStartT = Date.now();
      rec.setParam('Batteriespannung bei Start', `${action.vBat.toFixed(3)} V`);
      rec.event(`Batterie erkannt (${action.vBat.toFixed(3)} V) – Laden mit ${c.params.iCharge} A`);
      rec.setPhase('Laden CC');
      setChgState('lädt', 'run');
      chgMsg(`Batterie erkannt (${action.vBat.toFixed(3)} V). Laden mit ${c.params.iCharge} A bis ${c.params.vEnd} V …`, 'ok');
      log('info', `Batterie erkannt: ${action.vBat.toFixed(3)} V – Laden gestartet`);
    } else if (action.type === 'refuse') {
      await psu.setOutput(false);
      finishCharge(`Ladung verweigert: ${action.reason}`, 'fail');
    } else if (action.type === 'finish') {
      await psu.setOutput(false);
      finishCharge(action.reason, action.cls);
    } else if (action.type === 'abort') {
      finishCharge(action.reason, 'fail');
    }
  } catch (e) {
    log('err', `Ladung: ${e.message}`);
    try { await psu.setOutput(false); } catch {}
    finishCharge(`Fehler: ${e.message}`, 'fail');
  }
  renderCharge();
  try { renderStatus(await psu.status()); } catch {}
}

function finishCharge(reason, cls) {
  const c = state.chg;
  if (!c?.running) return;
  c.running = false;
  c.phase = 'done';
  c.endT = Date.now();
  const results = {
    'Ergebnis geladen': `${(c.ah * 1000).toFixed(1)} mAh`,
    'Ergebnis Energie': `${c.wh.toFixed(4)} Wh`,
    'Ergebnis Ladezeit': c.chargeStartT ? fmtDur(c.endT - c.chargeStartT) : '—',
    'Spannung zuletzt': c.vLast === null ? '—' : `${c.vLast.toFixed(3)} V`,
  };
  if (rec.run?.meta.type === 'charge') rec.end(reason, results);
  setChgState(cls === 'done' ? 'fertig' : cls === 'off' ? 'abgebrochen' : 'beendet', cls);
  chgMsg(`${reason} (${new Date().toLocaleTimeString()}). Geladen: ${results['Ergebnis geladen']}, ${results['Ergebnis Energie']}.`,
    cls === 'done' ? 'ok' : cls === 'off' ? '' : 'err');
  log('info', `Ladung beendet: ${reason}`);
  renderCharge();
  updateControls();
}

async function stopCharge() {
  if (!chgActive()) return;
  try {
    await psu.setOutput(false);
  } catch (e) {
    log('err', e.message);
  }
  finishCharge('Vom Benutzer abgebrochen', 'off');
  try { renderStatus(await psu.status()); } catch {}
}

$('btnChgStart').addEventListener('click', startCharge);
$('btnChgStop').addEventListener('click', stopCharge);
setInterval(() => { if (chgActive()) renderCharge(); }, 1000);

// ---------- Schutz ----------
const protMsg = (t) => { $('protMsg').textContent = t; };

$('btnOvpSet').addEventListener('click', async () => {
  try {
    await psu.setOVP(Number($('ovpV').value));
    $('ovpV').value = await psu.getOVP();
    protMsg(`OVP-Spannung ${$('ovpV').value} V gesetzt.`);
  } catch (e) {
    protMsg(e.message);
  }
});
$('ovpOn').addEventListener('change', async () => {
  try {
    await psu.enableOVP($('ovpOn').checked);
    renderStatus(await psu.status());
    protMsg(`OVP ${state.status.ovp ? 'aktiv' : 'aus'}.`);
  } catch (e) {
    protMsg(e.message);
  }
});
$('btnOcpSet').addEventListener('click', async () => {
  try {
    await psu.setOCP(Number($('ocpI').value));
    $('ocpI').value = await psu.getOCP();
    protMsg(`OCP-Strom ${$('ocpI').value} A gesetzt (aktivieren nur am Gerät).`);
  } catch (e) {
    protMsg(e.message);
  }
});

// ---------- Speicher & System ----------
const memMsg = (t) => { $('memMsg').textContent = t; };
$('btnMemRecall').addEventListener('click', async () => {
  const m = Number($('memSlot').value);
  try {
    await psu.recall(m);
    const set = await refreshSetpoints();
    rec.event(`M${m} abgerufen`);
    memMsg(`M${m} abgerufen: ${set.v.toFixed(3)} V / ${set.i.toFixed(3)} A.`);
  } catch (e) {
    memMsg(e.message);
  }
});
$('btnMemSave').addEventListener('click', async () => {
  const m = Number($('memSlot').value);
  if (!confirm(`Aktuelle Sollwerte (${$('curSet').textContent}) in M${m} speichern?`)) return;
  try {
    await psu.save(m);
    memMsg(`Sollwerte in M${m} gespeichert.`);
  } catch (e) {
    memMsg(e.message);
  }
});
$('sysBeep').addEventListener('change', async () => {
  try { await psu.setBeep($('sysBeep').checked); renderStatus(await psu.status()); } catch (e) { log('err', e.message); }
});
$('sysLock').addEventListener('change', async () => {
  try { await psu.setLock($('sysLock').checked); renderStatus(await psu.status()); } catch (e) { log('err', e.message); }
});
$('sysSense').addEventListener('change', async () => {
  const want = $('sysSense').checked;
  try {
    if (state.outputOn) {
      alert('Remote Sense bitte nur bei ausgeschaltetem Ausgang umschalten.');
      $('sysSense').checked = !want;
      return;
    }
    if (want && !confirm('Remote Sense einschalten?\n\nNur wenn die Sense-Leitungen (Rückseite, SENSE) am Verbraucher angeschlossen sind.')) {
      $('sysSense').checked = false;
      return;
    }
    await psu.setSense(want);
    await refreshSense();
  } catch (e) {
    log('err', e.message);
  }
});

// ---------- Messdateien ----------
let fileList = [];
const selectedFiles = new Set();
let filesTimer = null;

function scheduleFilesRefresh() {
  if (filesTimer) return;
  filesTimer = setTimeout(() => { filesTimer = null; refreshFiles(); }, 200);
}

async function refreshFiles() {
  try {
    fileList = await store.list();
  } catch (e) {
    log('err', `Messdateien nicht lesbar: ${e.message}`);
    fileList = [];
  }
  const active = rec.run?.meta;
  if (active) {
    fileList = fileList.filter((m) => m.id !== active.id);
    fileList.push(active);
  }
  fileList.sort((a, b) => b.startT - a.startT);
  for (const id of [...selectedFiles]) if (!fileList.some((m) => m.id === id)) selectedFiles.delete(id);
  renderFiles();
}

function renderFiles() {
  const tbody = $('filesTable').tBodies[0];
  tbody.innerHTML = '';
  const activeId = rec.run?.meta.id;
  for (const meta of fileList) {
    const tr = tbody.insertRow();
    const isActive = meta.id === activeId;
    tr.classList.toggle('active', isActive);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedFiles.has(meta.id);
    cb.setAttribute('aria-label', `${meta.name} auswählen`);
    cb.addEventListener('change', () => {
      cb.checked ? selectedFiles.add(meta.id) : selectedFiles.delete(meta.id);
      updateFileButtons();
    });
    tr.insertCell().appendChild(cb);

    const name = tr.insertCell();
    const title = document.createElement('span');
    title.className = 'fname';
    title.textContent = meta.name;
    const sub = document.createElement('span');
    sub.className = 'fsub';
    sub.textContent = isActive ? 'läuft …' : meta.endT ? meta.endReason || '' : 'nicht abgeschlossen (Seite geschlossen oder Absturz)';
    name.append(title, sub);

    tr.insertCell().textContent = new Date(meta.startT).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' });
    const endT = meta.endT ?? (isActive ? Date.now() : meta.lastT ?? meta.startT);
    tr.insertCell().textContent = fmtDur(endT - meta.startT);
    tr.insertCell().textContent = meta.count.toLocaleString('de-DE');

    const actions = tr.insertCell();
    const view = document.createElement('button');
    view.textContent = 'Ansehen';
    view.title = 'Im Diagramm ansehen (Zoom, Cursor)';
    view.addEventListener('click', () => viewer.open(meta).catch((e) => log('err', `Messdatei nicht lesbar: ${e.message}`)));
    const dl = document.createElement('button');
    dl.textContent = 'CSV';
    dl.title = 'Als CSV herunterladen';
    dl.addEventListener('click', () => downloadFiles([meta.id]));
    const del = document.createElement('button');
    del.textContent = 'Löschen';
    del.disabled = isActive;
    del.addEventListener('click', () => deleteFiles([meta.id]));
    actions.append(view, dl, del);
  }
  $('filesEmpty').hidden = fileList.length > 0;
  $('filesInfo').textContent = `${fileList.length} Datei${fileList.length === 1 ? '' : 'en'}` +
    (store.persistent ? '' : ' · nur bis zum Neuladen (Browser-Speicher nicht verfügbar)');
  updateFileButtons();
}

function updateFileButtons() {
  const n = selectedFiles.size;
  $('btnFilesDl').disabled = n === 0;
  $('btnFilesDl').textContent = n ? `${n} ausgewählte herunterladen` : 'Ausgewählte herunterladen';
  $('btnFilesDel').disabled = n === 0;
  $('btnFilesAll').disabled = fileList.length === 0;
  $('filesAllCb').checked = n > 0 && n === fileList.length;
  $('filesAllCb').indeterminate = n > 0 && n < fileList.length;
}

async function fileCsv(meta) {
  if (meta.id === rec.run?.meta.id) await rec.flushNow();
  return runToCsv(meta, await store.rows(meta.id), csvFormat());
}

async function downloadFiles(ids) {
  const metas = fileList.filter((m) => ids.includes(m.id));
  if (!metas.length) return;
  try {
    if (metas.length === 1) {
      downloadBlob(new Blob([await fileCsv(metas[0])], { type: 'text/csv' }), fileName(metas[0]));
      return;
    }
    const files = [];
    for (const meta of metas) files.push({ name: fileName(meta), data: await fileCsv(meta) });
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    downloadBlob(makeZip(files), `kwr103_messdateien_${stamp}_${metas.length}.zip`);
  } catch (e) {
    log('err', `Download fehlgeschlagen: ${e.message}`);
  }
}

async function deleteFiles(ids) {
  const activeId = rec.run?.meta.id;
  const del = ids.filter((id) => id !== activeId);
  if (!del.length) return;
  if (!confirm(`${del.length === 1 ? 'Messdatei' : `${del.length} Messdateien`} endgültig löschen?`)) return;
  for (const id of del) {
    try { await store.remove(id); } catch (e) { log('err', e.message); }
    selectedFiles.delete(id);
    if (viewer.id === id) viewer.close();
  }
  refreshFiles();
}

// ---------- Betrachter für Messdateien ----------
const viewer = new LogViewer($('viewerCard'), {
  load: async (meta) => {
    if (meta.id === rec.run?.meta.id) await rec.flushNow();
    return store.rows(meta.id);
  },
});
// laufende Aufzeichnung im Betrachter regelmäßig nachladen
setInterval(() => {
  if (viewer.id && viewer.id === rec.run?.meta.id) viewer.reload().catch(() => {});
}, 5000);

$('filesAllCb').addEventListener('change', () => {
  if ($('filesAllCb').checked) fileList.forEach((m) => selectedFiles.add(m.id));
  else selectedFiles.clear();
  renderFiles();
});
$('btnFilesDl').addEventListener('click', () => downloadFiles([...selectedFiles]));
$('btnFilesAll').addEventListener('click', () => downloadFiles(fileList.map((m) => m.id)));
$('btnFilesDel').addEventListener('click', () => deleteFiles([...selectedFiles]));
setInterval(() => { if (rec.active) renderFiles(); }, 2000);

// ---------- Konsole ----------
$('consoleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cmd = $('cmd').value.trim();
  if (!cmd) return;
  $('cmd').value = '';
  try {
    if (/^STATUS/i.test(cmd)) {
      const s = await psu.query(cmd, { binary: true });
      log('info', `${cmd} = 0x${s.toString(16).padStart(2, '0')} (Bits ${s.toString(2).padStart(8, '0')})`);
    } else if (cmd.endsWith('?')) {
      log('info', `${cmd} = ${await psu.query(cmd)}`);
    } else {
      await psu.write(cmd);
    }
  } catch (err) {
    log('err', err.message);
  }
});

// ---------- Start ----------
if (!KWR103.supported()) {
  $('unsupported').hidden = false;
  $('btnConnect').disabled = true;
}
// Schnittstelle: Web Serial am Desktop, WebUSB unter Android (dort kann Web Serial nur Bluetooth)
{
  const hasSerial = 'serial' in navigator, hasUsb = 'usb' in navigator;
  const android = /Android/i.test(navigator.userAgent);
  for (const opt of $('transport').options) opt.hidden = opt.value === 'usb' ? !hasUsb : !hasSerial;
  const saved = storageGet('kwr103.transport');
  $('transport').value = (saved === 'usb' && hasUsb) || (saved === 'serial' && hasSerial) ? saved
    : (android || !hasSerial) && hasUsb ? 'usb' : 'serial';
  $('transport').addEventListener('change', () => storageSet('kwr103.transport', $('transport').value));
}
showTab(storageGet('kwr103.tab') ?? 'charge');
updateControls();
storeOpened.then(() => {
  navigator.storage?.persist?.().catch(() => {});
  refreshFiles();
});
window.addEventListener('beforeunload', () => {
  if (psu.connected && $('offOnDisconnect').checked) psu.setOutput(false);
});
