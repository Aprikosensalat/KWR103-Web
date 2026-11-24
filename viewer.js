// Betrachter für gespeicherte Messdateien: Zoom, Verschieben und zwei Messcursor (A/B).
// Gemeinsam genutzt von KEL103-Web und KWR103-Web (Datei identisch halten).

import { niceStep, decimals, lowerBound, prepareCanvas } from './plot.js';

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const pad = (n) => String(n).padStart(2, '0');

const TIME_STEPS = [
  10, 20, 50, 100, 200, 500,
  1e3, 2e3, 5e3, 10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3,
  3600e3, 7200e3, 10800e3, 21600e3, 43200e3, 86400e3,
];
const MIN_SPAN = 50; // ms, stärkster Zoom
const EXTRA_COLORS = ['--c-ext1', '--c-ext2', '--c-ext3', '--c-ext4'];

/** Relative Zeit als h:mm:ss bzw. m:ss, bei kleinen Schritten mit Nachkommastellen. */
export function fmtRel(ms, step = 1000) {
  const neg = ms < 0;
  const frac = step < 100 ? 2 : step < 1000 ? 1 : 0;
  const q = 10 ** (3 - frac);
  let rest = Math.round(Math.abs(ms) / q) * q;
  const h = Math.floor(rest / 3600e3); rest -= h * 3600e3;
  const m = Math.floor(rest / 60e3); rest -= m * 60e3;
  const s = (rest / 1000).toFixed(frac).padStart(frac ? frac + 3 : 2, '0');
  return (neg ? '−' : '') + (h ? `${h}:${pad(m)}:${s}` : `${m}:${s}`);
}

const fmtNum = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');

const LABELS = { kapazitaet: 'Kapazität', geladen: 'Geladen', eta: 'η' };
const UNITS = { pct: '%' };

/** Spaltenname -> Bezeichnung und Einheit (z. B. geladen_mAh -> „Geladen“, „mAh“). */
function describeCol(key) {
  const m = key.match(/^(.*)_([A-Za-zΩ]+)$/);
  const raw = m ? m[1] : key;
  const name = LABELS[raw] ?? raw.replace(/_/g, ' ');
  const unit = m ? UNITS[m[2]] ?? m[2] : '';
  return { label: name.charAt(0).toUpperCase() + name.slice(1), unit };
}

export class LogViewer {
  /**
   * @param {HTMLElement} root   leeres Element, das der Betrachter füllt
   * @param {{ load: (meta) => Promise<object[]> }} opts  liefert die Messwerte einer Datei
   */
  constructor(root, { load }) {
    this.root = root;
    this.load = load;
    this.meta = null;
    this.rows = [];
    this.series = [];
    this.v0 = this.v1 = 0; // sichtbarer Zeitbereich (absolute ms)
    this.cur = { a: null, b: null }; // Zeilenindex der Cursor
    this.hoverX = null;
    this.drag = null;
    this.panelHeight = 130;
    this.topPad = 16;
    this.left = 64;
    this.right = 14;
    this._raf = 0;
    this._readoutKey = '';
    this._build();
  }

  get id() {
    return this.meta?.id ?? null;
  }

  _build() {
    this.root.innerHTML = `
      <div class="card-head">
        <div class="lv-title"><h2>Messdatei ansehen</h2><span class="lv-name"></span></div>
        <div class="row tight">
          <button data-act="reload" title="Messwerte neu laden (bei laufender Aufzeichnung)">Neu laden</button>
          <button data-act="close">Schließen</button>
        </div>
      </div>
      <div class="row tight lv-series"></div>
      <div class="row tight lv-tools">
        <button data-act="zin" title="Hineinzoomen (+)">+</button>
        <button data-act="zout" title="Herauszoomen (−)">−</button>
        <button data-act="left" title="Nach links (←)">◀</button>
        <button data-act="right" title="Nach rechts (→)">▶</button>
        <button data-act="all" title="Gesamte Datei (Pos1)">Alles</button>
        <button data-act="zab" title="Bereich zwischen Cursor A und B">Auf A–B zoomen</button>
        <button data-act="clear" title="Cursor entfernen (Esc)">Cursor löschen</button>
        <span class="muted small lv-range"></span>
      </div>
      <canvas class="lv-plot" tabindex="0" aria-label="Diagramm der Messdatei"></canvas>
      <p class="muted small lv-help">
        Klick: Cursor A bzw. B setzen (Cursor lassen sich ziehen) · Mausrad: zoomen ·
        Ziehen: Bereich vergrößern · Umschalt + Ziehen oder rechte Maustaste: verschieben
      </p>
      <p class="small lv-hover"></p>
      <div class="table-wrap"><table class="grid-table lv-table"><thead></thead><tbody></tbody></table></div>
      <p class="small lv-calc"></p>`;
    const q = (s) => this.root.querySelector(s);
    this.canvas = q('.lv-plot');
    this.el = {
      name: q('.lv-name'), series: q('.lv-series'), range: q('.lv-range'),
      hover: q('.lv-hover'), table: q('.lv-table'), calc: q('.lv-calc'),
    };

    this.root.querySelector('.card-head').addEventListener('click', (e) => this._action(e.target.dataset.act));
    q('.lv-tools').addEventListener('click', (e) => this._action(e.target.dataset.act));

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', () => { this.drag = null; this.requestDraw(); });
    c.addEventListener('pointerleave', () => { if (!this.drag) { this.hoverX = null; this.requestDraw(); } });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      if (!this.rows.length) return;
      e.preventDefault();
      const f = Math.exp(Math.max(-1, Math.min(1, e.deltaY / 300)));
      this.zoomAt(this._tOf(this._x(e)), f);
    }, { passive: false });
    c.addEventListener('keydown', (e) => {
      const map = { ArrowLeft: 'left', ArrowRight: 'right', '+': 'zin', '-': 'zout', Home: 'all', Escape: 'clear' };
      if (map[e.key]) { e.preventDefault(); this._action(map[e.key]); }
    });
    new ResizeObserver(() => this.requestDraw()).observe(c);
  }

  // ---------- Öffnen / Schließen ----------

  async open(meta) {
    this.meta = meta;
    this.cur = { a: null, b: null };
    this.root.hidden = false;
    this.el.name.textContent = `${meta.name} · ${new Date(meta.startT).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' })}`;
    this._buildSeries();
    await this.reload(true);
    this.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async reload(resetView = false) {
    if (!this.meta) return;
    const wasAll = resetView || (this.rows.length && this.v0 <= this._dataT0() && this.v1 >= this._dataT1());
    this.rows = await this.load(this.meta);
    if (wasAll || !this.rows.length) this._showAll();
    else this._clampView();
    for (const k of ['a', 'b']) if (this.cur[k] !== null && this.cur[k] >= this.rows.length) this.cur[k] = null;
    this._gap = this._gapMs();
    this._readoutKey = '';
    this.requestDraw();
  }

  close() {
    this.meta = null;
    this.rows = [];
    this.root.hidden = true;
  }

  _buildSeries() {
    const old = new Map(this.series.map((s) => [s.key, s.visible]));
    // meta.baseLabels: andere Namen für die Grundspalten (z. B. ['Vout', 'Iout', 'Pout'])
    const bl = this.meta.baseLabels ?? ['Spannung', 'Strom', 'Leistung'];
    const base = [
      { key: 'v', label: bl[0], unit: 'V', color: '--c-volt', digits: 3 },
      { key: 'i', label: bl[1], unit: 'A', color: '--c-curr', digits: 3 },
      { key: 'p', label: bl[2], unit: 'W', color: '--c-pow', digits: 2 },
    ];
    // Zahlenspalten der Datei (z. B. kapazitaet_mAh); reine Zeitspalten weglassen
    const extra = (this.meta.extraCols ?? [])
      .filter((c) => !c.text && !/zeit_(min|s|h)$/.test(c.key))
      .map((c, k) => ({ key: c.key, ...describeCol(c.key), color: EXTRA_COLORS[k % EXTRA_COLORS.length], digits: c.digits ?? 3, hidden: c.hidden }));
    // extraCols[].hidden: Spalte zunächst ausgeblendet
    this.series = [...base, ...extra].map((s) => ({ ...s, visible: old.get(s.key) ?? !s.hidden }));

    this.el.series.innerHTML = '';
    for (const s of this.series) {
      const lab = document.createElement('label');
      lab.className = 'check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = s.visible;
      cb.addEventListener('change', () => { s.visible = cb.checked; this._readoutKey = ''; this.requestDraw(); });
      const sw = document.createElement('span');
      sw.className = 'lv-swatch';
      sw.style.background = `var(${s.color})`;
      lab.append(cb, sw, ` ${s.label}`);
      this.el.series.append(lab);
    }
  }

  // ---------- Sichtbereich ----------

  _dataT0() { return this.rows.length ? this.rows[0].t : 0; }
  _dataT1() {
    if (!this.rows.length) return 1000;
    return Math.max(this.rows[this.rows.length - 1].t, this.rows[0].t + 1000);
  }

  _showAll() {
    this.v0 = this._dataT0();
    this.v1 = this._dataT1();
  }

  _clampView() {
    const d0 = this._dataT0(), d1 = this._dataT1();
    let span = Math.min(Math.max(this.v1 - this.v0, MIN_SPAN), d1 - d0);
    let v0 = Math.max(d0, Math.min(this.v0, d1 - span));
    this.v0 = v0;
    this.v1 = v0 + span;
  }

  setView(v0, v1) {
    this.v0 = v0;
    this.v1 = v1;
    this._clampView();
    this.requestDraw();
  }

  zoomAt(t, factor) {
    const span = (this.v1 - this.v0) * factor;
    const r = (t - this.v0) / (this.v1 - this.v0);
    this.setView(t - r * span, t - r * span + span);
  }

  _action(act) {
    if (!act) return;
    const span = this.v1 - this.v0, mid = (this.v0 + this.v1) / 2;
    switch (act) {
      case 'close': this.close(); break;
      case 'reload': this.reload().catch((e) => console.error(e)); break;
      case 'zin': this.zoomAt(mid, 0.5); break;
      case 'zout': this.zoomAt(mid, 2); break;
      case 'left': this.setView(this.v0 - span * 0.25, this.v1 - span * 0.25); break;
      case 'right': this.setView(this.v0 + span * 0.25, this.v1 + span * 0.25); break;
      case 'all': this._showAll(); this.requestDraw(); break;
      case 'zab': {
        const { a, b } = this.cur;
        if (a === null || b === null || a === b) break;
        const ta = this.rows[a].t, tb = this.rows[b].t;
        const m = Math.abs(tb - ta) * 0.05;
        this.setView(Math.min(ta, tb) - m, Math.max(ta, tb) + m);
        break;
      }
      case 'clear': this.cur = { a: null, b: null }; this.requestDraw(); break;
    }
  }

  // ---------- Maus / Touch ----------

  _x(e) { return e.clientX - this.canvas.getBoundingClientRect().left; }
  _pw() { return this.canvas.clientWidth - this.left - this.right; }
  _tOf(x) { return this.v0 + ((x - this.left) / this._pw()) * (this.v1 - this.v0); }
  _xOf(t) { return this.left + ((t - this.v0) / (this.v1 - this.v0)) * this._pw(); }

  /** Index des Messwerts, der t am nächsten liegt. */
  _nearest(t) {
    const d = this.rows;
    let i = lowerBound(d, t);
    if (i >= d.length) i = d.length - 1;
    else if (i > 0 && t - d[i - 1].t < d[i].t - t) i--;
    return i;
  }

  _down(e) {
    if (!this.rows.length) return;
    this.canvas.focus({ preventScroll: true });
    this.canvas.setPointerCapture(e.pointerId);
    const x = this._x(e);
    if (e.button === 2 || e.button === 1 || e.shiftKey) {
      this.drag = { mode: 'pan', x0: x, v0: this.v0, v1: this.v1 };
      return;
    }
    for (const k of ['a', 'b']) {
      const i = this.cur[k];
      if (i !== null && Math.abs(this._xOf(this.rows[i].t) - x) <= 6) {
        this.drag = { mode: 'cursor', key: k };
        return;
      }
    }
    this.drag = { mode: 'select', x0: x, x1: x };
  }

  _move(e) {
    const x = this._x(e);
    this.hoverX = x;
    const d = this.drag;
    if (d?.mode === 'pan') {
      const dt = ((x - d.x0) / this._pw()) * (d.v1 - d.v0);
      this.setView(d.v0 - dt, d.v1 - dt);
      return;
    }
    if (d?.mode === 'cursor') this.cur[d.key] = this._nearest(this._tOf(x));
    if (d?.mode === 'select') d.x1 = x;
    this.requestDraw();
  }

  _up(e) {
    const d = this.drag;
    this.drag = null;
    if (d?.mode === 'select') {
      if (Math.abs(d.x1 - d.x0) < 5) this._placeCursor(this._tOf(d.x0));
      else {
        const ta = this._tOf(Math.min(d.x0, d.x1)), tb = this._tOf(Math.max(d.x0, d.x1));
        this.setView(ta, tb);
      }
    }
    if (e.pointerType !== 'mouse') this.hoverX = null;
    this.requestDraw();
  }

  /** Erst A, dann B setzen; danach wird der näher liegende Cursor versetzt. */
  _placeCursor(t) {
    const i = this._nearest(t);
    const { a, b } = this.cur;
    if (a === null) this.cur.a = i;
    else if (b === null) this.cur.b = i;
    else {
      const da = Math.abs(this.rows[a].t - t), db = Math.abs(this.rows[b].t - t);
      if (da <= db) this.cur.a = i; else this.cur.b = i;
    }
  }

  // ---------- Zeichnen ----------

  requestDraw() {
    if (!this._raf) {
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        if (!this.root.hidden && this.meta) this.draw();
      });
    }
  }

  /** Lücken in der Aufzeichnung (Pause, Abbruch) nicht verbinden. */
  _gapMs() {
    const d = this.rows;
    if (d.length < 3) return Infinity;
    const diffs = [];
    const step = Math.max(1, Math.floor(d.length / 400));
    for (let i = step; i < d.length; i += step) diffs.push((d[i].t - d[i - step].t) / step);
    diffs.sort((x, y) => x - y);
    return Math.max(15_000, diffs[diffs.length >> 1] * 5);
  }

  draw() {
    const vis = this.series.filter((s) => s.visible);
    const axisH = 26, top0 = this.topPad, ph0 = this.panelHeight;
    const height = top0 + Math.max(1, vis.length) * ph0 + axisH;
    const { ctx, w } = prepareCanvas(this.canvas, height);
    const left = this.left, pw = w - left - this.right;
    const grid = cssVar('--border'), text = cssVar('--muted'), fg = cssVar('--fg'), card = cssVar('--card');
    const data = this.rows, base = this.meta.startT;
    const t0 = this.v0, t1 = this.v1;
    const xOf = (t) => left + ((t - t0) / (t1 - t0)) * pw;

    this.el.range.textContent = data.length
      ? `Ausschnitt ${fmtRel(t0 - base)} – ${fmtRel(t1 - base)} (${fmtRel(t1 - t0, t1 - t0 < 10e3 ? 10 : 1000)})`
      : '';
    if (!data.length || !vis.length || pw <= 0) {
      ctx.fillStyle = text;
      ctx.fillText(data.length ? 'Keine Messgröße ausgewählt' : 'Die Datei enthält keine Messwerte', left, 30);
      this._renderReadout();
      return;
    }

    const first = lowerBound(data, t0);
    const last = lowerBound(data, t1 + 1e-6); // exklusiv
    const start = Math.max(0, first - 1), end = Math.min(data.length, last + 1);
    const yFrom = first < last ? first : start, yTo = first < last ? last : end;

    const hoverIdx = this.hoverX !== null && !this.drag && this.hoverX >= left && this.hoverX <= left + pw
      ? this._nearest(this._tOf(this.hoverX)) : -1;
    const marks = [
      ...(this.cur.a !== null ? [{ i: this.cur.a, name: 'A', color: cssVar('--cur-a') }] : []),
      ...(this.cur.b !== null ? [{ i: this.cur.b, name: 'B', color: cssVar('--cur-b') }] : []),
    ];

    vis.forEach((s, k) => {
      const top = top0 + k * ph0 + 4, bottom = top0 + (k + 1) * ph0 - 6, ph = bottom - top;
      const color = cssVar(s.color);
      let min = Infinity, max = -Infinity;
      for (let i = yFrom; i < yTo; i++) {
        const v = data[i][s.key];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min === Infinity) { min = 0; max = 1; }
      const span = max - min;
      const padY = span < 1e-9 ? Math.max(Math.abs(max) * 0.05, 0.01) : span * 0.08;
      min -= padY; max += padY;
      const yOf = (v) => bottom - ((v - min) / (max - min)) * ph;

      // Gitter
      const step = niceStep(max - min, 4), dec = decimals(step);
      ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.fillStyle = text;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
        const y = Math.round(yOf(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + pw, y); ctx.stroke();
        ctx.fillText(v.toFixed(dec), left - 6, y);
      }
      ctx.strokeRect(left + 0.5, top + 0.5, pw - 1, ph - 1);

      // Kurve
      ctx.save();
      ctx.beginPath(); ctx.rect(left, top, pw, ph); ctx.clip();
      ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
      ctx.beginPath();
      if (end - start <= pw * 2) {
        let prevT = null;
        for (let i = start; i < end; i++) {
          const d = data[i], x = xOf(d.t), y = yOf(d[s.key]);
          if (prevT === null || d.t - prevT > this._gap) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          prevT = d.t;
        }
        ctx.stroke();
        if (end - start <= pw / 6) { // wenige Punkte: Messpunkte markieren
          ctx.fillStyle = color;
          for (let i = start; i < end; i++) {
            ctx.beginPath(); ctx.arc(xOf(data[i].t), yOf(data[i][s.key]), 2.2, 0, 2 * Math.PI); ctx.fill();
          }
        }
      } else {
        // pro Pixelspalte Min/Max
        let col = null, mn = 0, mx = 0, started = false, prevT = null;
        const flush = () => {
          const x = left + col + 0.5;
          if (!started) { ctx.moveTo(x, yOf(mn)); started = true; } else ctx.lineTo(x, yOf(mn));
          ctx.lineTo(x, yOf(mx));
        };
        for (let i = start; i < end; i++) {
          const d = data[i], v = d[s.key];
          const c = Math.floor(xOf(d.t) - left);
          if (prevT !== null && d.t - prevT > this._gap) { if (col !== null) flush(); col = null; started = false; }
          prevT = d.t;
          if (c !== col) {
            if (col !== null) flush();
            col = c; mn = mx = v;
          } else {
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
        }
        if (col !== null) flush();
        ctx.stroke();
      }

      // Punkte an Cursor und Zeiger
      for (const m of marks) {
        const d = data[m.i];
        ctx.fillStyle = m.color;
        ctx.beginPath(); ctx.arc(xOf(d.t), yOf(d[s.key]), 4, 0, 2 * Math.PI); ctx.fill();
      }
      if (hoverIdx >= 0) {
        const d = data[hoverIdx];
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(xOf(d.t), yOf(d[s.key]), 3.5, 0, 2 * Math.PI); ctx.fill();
      }
      ctx.restore();

      const tag = (txt, x, align, fill) => {
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.textAlign = align; ctx.textBaseline = 'top';
        const tw = ctx.measureText(txt).width;
        const bx = align === 'right' ? x - tw - 4 : x - 4;
        ctx.globalAlpha = 0.85; ctx.fillStyle = card; ctx.fillRect(bx, top + 3, tw + 8, 18);
        ctx.globalAlpha = 1; ctx.fillStyle = fill; ctx.fillText(txt, x, top + 6);
        ctx.font = '11px system-ui, sans-serif';
      };
      tag(`${s.label}${s.unit ? ` [${s.unit}]` : ''}`, left + 8, 'left', color);
      if (hoverIdx >= 0) tag(`${fmtNum(data[hoverIdx][s.key], s.digits)} ${s.unit}`, left + pw - 8, 'right', fg);
    });

    // Zeitachse (relativ zum Start der Datei)
    const axisTop = top0 + vis.length * ph0;
    const tStep = TIME_STEPS.find((st) => (t1 - t0) / st <= pw / 90) ?? TIME_STEPS[TIME_STEPS.length - 1];
    ctx.fillStyle = text; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.strokeStyle = grid; ctx.lineWidth = 1;
    for (let r = Math.ceil((t0 - base) / tStep) * tStep; r + base <= t1; r += tStep) {
      const x = Math.round(xOf(r + base)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, top0 + 4); ctx.lineTo(x, axisTop - 6); ctx.stroke();
      ctx.fillText(fmtRel(r, tStep), x, axisTop + 4);
    }

    // Auswahlrechteck beim Ziehen
    if (this.drag?.mode === 'select' && Math.abs(this.drag.x1 - this.drag.x0) >= 5) {
      const xa = Math.max(left, Math.min(this.drag.x0, this.drag.x1));
      const xb = Math.min(left + pw, Math.max(this.drag.x0, this.drag.x1));
      ctx.fillStyle = cssVar('--accent'); ctx.globalAlpha = 0.15;
      ctx.fillRect(xa, top0, xb - xa, axisTop - top0 - 6);
      ctx.globalAlpha = 1;
    }

    // Cursorlinien
    const vline = (x, color, dash, label) => {
      if (x < left - 1 || x > left + pw + 1) return;
      ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(x, top0); ctx.lineTo(x, axisTop - 6); ctx.stroke();
      ctx.setLineDash([]);
      if (label) {
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(label, x, 1);
        ctx.font = '11px system-ui, sans-serif';
      }
    };
    for (const m of marks) vline(Math.round(xOf(data[m.i].t)) + 0.5, m.color, [], m.name);

    if (hoverIdx >= 0) {
      const x = Math.round(xOf(data[hoverIdx].t)) + 0.5;
      vline(x, text, [4, 3]);
      const label = fmtRel(data[hoverIdx].t - base, tStep < 1000 ? tStep : 1000);
      const tw = ctx.measureText(label).width + 10;
      const lx = Math.min(Math.max(x, left + tw / 2), left + pw - tw / 2);
      ctx.fillStyle = card; ctx.fillRect(lx - tw / 2, axisTop + 1, tw, 18);
      ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(label, lx, axisTop + 4);
      const d = data[hoverIdx];
      this.el.hover.textContent = `Zeiger: ${fmtRel(d.t - base, 10)} · ${new Date(d.t).toLocaleTimeString('de-DE')}` +
        (d.info ? ` · ${d.info}` : '');
    } else {
      this.el.hover.textContent = ' ';
    }

    this._renderReadout();
  }

  // ---------- Messwerttabelle ----------

  _renderReadout() {
    const { a, b } = this.cur;
    const vis = this.series.filter((s) => s.visible);
    const key = `${this.rows.length}|${this.v0}|${this.v1}|${a}|${b}|${vis.map((s) => s.key)}`;
    if (key === this._readoutKey) return;
    this._readoutKey = key;

    const data = this.rows, base = this.meta?.startT ?? 0;
    const thead = this.el.table.tHead, tbody = this.el.table.tBodies[0];
    thead.innerHTML = ''; tbody.innerHTML = '';
    this.el.calc.textContent = '';
    if (!data.length) return;

    // Statistik zwischen den Cursorn, sonst über den sichtbaren Ausschnitt
    const both = a !== null && b !== null;
    let i0, i1;
    if (both) { i0 = Math.min(a, b); i1 = Math.max(a, b) + 1; }
    else { i0 = lowerBound(data, this.v0); i1 = Math.max(i0 + 1, lowerBound(data, this.v1 + 1e-6)); i1 = Math.min(i1, data.length); }
    const statLabel = both ? 'zwischen A und B' : 'im Ausschnitt';

    const hr = thead.insertRow();
    for (const h of ['', 'Cursor A', 'Cursor B', 'Δ (B − A)', `Min ${statLabel}`, `Max ${statLabel}`, `Mittel ${statLabel}`]) {
      const th = document.createElement('th');
      th.textContent = h;
      hr.append(th);
    }
    const row = (label, cells, color) => {
      const tr = tbody.insertRow();
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = label;
      if (color) th.style.color = `var(${color})`;
      tr.append(th);
      for (const c of cells) tr.insertCell().textContent = c;
    };

    const ra = a !== null ? data[a] : null, rb = b !== null ? data[b] : null;
    row('Zeit', [
      ra ? fmtRel(ra.t - base, 10) : '—', rb ? fmtRel(rb.t - base, 10) : '—',
      both ? fmtRel(rb.t - ra.t, 10) : '—', '', '', '',
    ]);
    for (const s of vis) {
      let mn = Infinity, mx = -Infinity, sum = 0, n = 0;
      for (let i = i0; i < i1; i++) {
        const v = data[i][s.key];
        if (typeof v !== 'number' || Number.isNaN(v)) continue;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        sum += v; n++;
      }
      const f = (v) => (v === undefined || v === null ? '—' : `${fmtNum(v, s.digits)} ${s.unit}`);
      row(s.label, [
        ra ? f(ra[s.key]) : '—', rb ? f(rb[s.key]) : '—',
        both ? f(rb[s.key] - ra[s.key]) : '—',
        n ? f(mn) : '—', n ? f(mx) : '—', n ? f(sum / n) : '—',
      ], s.color);
    }

    // Abgeleitete Werte
    const parts = [];
    let ah = 0, wh = 0;
    for (let i = i0 + 1; i < i1; i++) {
      const p = data[i - 1], c = data[i], dt = c.t - p.t;
      if (dt <= 0 || dt > this._gap) continue;
      ah += ((p.i + c.i) / 2) * dt / 3600e3;
      wh += ((p.p + c.p) / 2) * dt / 3600e3;
    }
    parts.push(`Ladung ${statLabel}: ${fmtNum(ah * 1000, 2)} mAh`, `Energie: ${fmtNum(wh, 4)} Wh`);
    if (both) {
      const dI = rb.i - ra.i, dU = rb.v - ra.v;
      if (Math.abs(dI) >= 0.005) parts.push(`Widerstand |ΔU/ΔI|: ${fmtNum(Math.abs(dU / dI) * 1000, 1)} mΩ`);
    }
    if (ra?.info || rb?.info) parts.push(`Info A: ${ra?.info || '—'} · Info B: ${rb?.info || '—'}`);
    this.el.calc.textContent = parts.join(' · ');
  }
}
