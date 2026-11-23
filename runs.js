// Messdateien: Speicherung im Browser (IndexedDB), Aufzeichnung je Test, CSV- und ZIP-Erzeugung.

const DB_NAME = 'kwr103';
const DB_VERSION = 1;
const CHUNK = 500; // Messwerte je gespeichertem Block
const FLUSH_MS = 5000;

/** Ablage der Messdateien. Fällt auf Arbeitsspeicher zurück, wenn IndexedDB nicht verfügbar ist. */
export class RunStore {
  constructor() {
    this.db = null;
    this.mem = new Map(); // id -> { meta, chunks: Map(idx -> rows) }
    this.ready = Promise.resolve();
  }

  /** Öffnet die Datenbank. Alle Zugriffe warten darauf, damit nichts nur im Arbeitsspeicher landet. */
  open() {
    this.ready = (async () => {
      try {
        this.db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(DB_NAME, DB_VERSION);
          req.onupgradeneeded = () => {
            const db = req.result;
            db.createObjectStore('runs', { keyPath: 'id' });
            db.createObjectStore('chunks', { keyPath: ['run', 'idx'] });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      } catch {
        this.db = null;
      }
    })();
    return this.ready.then(() => this.db !== null);
  }

  get persistent() {
    return this.db !== null;
  }

  _mem(id) {
    if (!this.mem.has(id)) this.mem.set(id, { meta: null, chunks: new Map() });
    return this.mem.get(id);
  }

  _req(storeName, mode, op) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, mode);
      const req = op(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }

  async putMeta(meta) {
    await this.ready;
    if (!this.db) { this._mem(meta.id).meta = { ...meta }; return; }
    await this._req('runs', 'readwrite', (s) => s.put({ ...meta }));
  }

  async putChunk(id, idx, rows) {
    await this.ready;
    if (!this.db) { this._mem(id).chunks.set(idx, rows); return; }
    await this._req('chunks', 'readwrite', (s) => s.put({ run: id, idx, rows }));
  }

  async list() {
    await this.ready;
    if (!this.db) return [...this.mem.values()].map((x) => x.meta).filter(Boolean);
    return this._req('runs', 'readonly', (s) => s.getAll());
  }

  async rows(id) {
    await this.ready;
    if (!this.db) {
      const m = this.mem.get(id);
      return m ? [...m.chunks.entries()].sort((a, b) => a[0] - b[0]).flatMap((e) => e[1]) : [];
    }
    const chunks = await this._req('chunks', 'readonly', (s) => s.getAll(IDBKeyRange.bound([id, 0], [id, Infinity])));
    return chunks.sort((a, b) => a.idx - b.idx).flatMap((c) => c.rows);
  }

  async remove(id) {
    await this.ready;
    if (!this.db) { this.mem.delete(id); return; }
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction(['runs', 'chunks'], 'readwrite');
      tx.objectStore('runs').delete(id);
      tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
}

/**
 * Zeichnet genau eine laufende Messdatei auf.
 * meta: { id, type, name, params, extraCols, startT, endT, endReason, count }
 */
export class Recorder {
  constructor(store, onChange = () => {}) {
    this.store = store;
    this.onChange = onChange;
    this.run = null;
  }

  get active() {
    return this.run !== null;
  }

  /** Startet eine neue Datei (eine laufende wird vorher abgeschlossen). */
  start(type, name, { params = {}, extraCols = [], endOnInputOff = false } = {}) {
    if (this.run) this._finish(this.run, 'neuer Ablauf gestartet');
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const r = {
      meta: { id, type, name, params, extraCols, startT: Date.now(), endT: null, endReason: null, count: 0 },
      endOnInputOff, idx: 0, buf: [], dirty: true, phase: '', events: [], writing: Promise.resolve(),
    };
    r.timer = setInterval(() => this._flush(r), FLUSH_MS);
    this.run = r;
    this._flush(r);
    this.onChange();
    return r.meta;
  }

  /** Fügt einen Messwert hinzu; extra enthält testspezifische Spalten (z. B. kapazitaet_mAh). */
  add(t, v, i, p, extra = {}) {
    const r = this.run;
    if (!r) return;
    const info = [r.phase, ...r.events].filter(Boolean).join(' | ');
    r.events = [];
    r.buf.push({ t, v, i, p, ...extra, info });
    r.meta.count++;
    r.meta.lastT = t;
    r.dirty = true;
    if (r.buf.length >= CHUNK) this._flush(r);
  }

  /** Einmaliges Ereignis, erscheint in der Spalte „info“ des nächsten Messwerts. */
  event(text) {
    this.run?.events.push(text);
  }

  /** Dauerhafte Phase (z. B. „Puls 2 A“), erscheint in jeder Zeile bis zur nächsten Änderung. */
  setPhase(text) {
    if (this.run) this.run.phase = text;
  }

  setParam(key, value) {
    if (this.run) { this.run.meta.params[key] = value; this.run.dirty = true; }
  }

  /** Schließt die laufende Datei ab. */
  end(reason = '', params = {}) {
    const r = this.run;
    if (!r) return Promise.resolve();
    this.run = null;
    Object.assign(r.meta.params, params);
    const done = this._finish(r, reason);
    this.onChange();
    return done;
  }

  /** Schreibt den aktuellen Stand der laufenden Datei sofort. */
  flushNow() {
    return this.run ? this._flush(this.run) : Promise.resolve();
  }

  _finish(r, reason) {
    clearInterval(r.timer);
    r.meta.endT = Date.now();
    r.meta.endReason = reason;
    r.dirty = true;
    return this._flush(r).then(async () => {
      if (r.meta.count === 0) await this.store.remove(r.meta.id).catch(() => {});
      this.onChange();
    });
  }

  _flush(r) {
    // Schreibvorgänge je Datei nacheinander ausführen
    r.writing = r.writing.then(async () => {
      if (!r.dirty) return;
      r.dirty = false;
      const idx = r.idx;
      const rows = r.buf.slice();
      if (r.buf.length >= CHUNK) {
        r.idx++;
        r.buf = [];
      }
      try {
        await this.store.putChunk(r.meta.id, idx, rows);
        await this.store.putMeta(r.meta);
      } catch (e) {
        console.error('Messdatei konnte nicht gespeichert werden', e);
      }
    });
    return r.writing.then(() => this.onChange());
  }
}

// ---------- CSV ----------

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function formatTime(t, fmt) {
  const d = new Date(t);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const ms = pad(d.getMilliseconds(), 3);
  return fmt === 'de'
    ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${time},${ms}`
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}.${ms}`;
}

/**
 * Erzeugt eine CSV-Datei.
 * fmt 'de': Semikolon, Dezimalkomma (deutsches Excel); 'int': Komma, Dezimalpunkt.
 */
export function runToCsv(meta, rows, fmt = 'de') {
  const de = fmt === 'de';
  const sep = de ? ';' : ',';
  const num = (x, digits) => (typeof x !== 'number' || Number.isNaN(x) ? '' : de ? x.toFixed(digits).replace('.', ',') : x.toFixed(digits));
  const text = (s) => {
    const str = String(s ?? '');
    return str.includes(sep) || /["\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const extra = meta.extraCols ?? [];
  // Kopf: Bezeichnung in Spalte A, Wert in Spalte B (bei „Ende“ der Grund in Spalte C)
  const head = (key, ...values) => [text(`# ${key}`), ...values.map(text)].join(sep);
  // im deutschen Format Dezimalpunkte in Parameterwerten als Komma schreiben („0.5 A“ -> „0,5 A“)
  const localize = (v) => (de ? String(v).replace(/(\d)\.(\d)/g, '$1,$2') : String(v));
  const lines = [];
  lines.push(head('Test', meta.name));
  lines.push(head('Start', formatTime(meta.startT, fmt)));
  if (meta.endT) lines.push(head('Ende', formatTime(meta.endT, fmt), ...(meta.endReason ? [meta.endReason] : [])));
  for (const [k, v] of Object.entries(meta.params ?? {})) lines.push(head(k, localize(v)));
  lines.push('');
  const header = ['zeit', 'zeit_s', 'spannung_V', 'strom_A', 'leistung_W', ...extra.map((c) => c.key)];
  if (!meta.noInfo) header.push('info');
  lines.push(header.join(sep));
  const t0 = meta.startT;
  for (const r of rows) {
    const cells = [
      formatTime(r.t, fmt), num((r.t - t0) / 1000, 3), num(r.v, 4), num(r.i, 4), num(r.p, 4),
      ...extra.map((c) => (c.text ? text(r[c.key]) : num(r[c.key], c.digits ?? 3))),
    ];
    if (!meta.noInfo) cells.push(text(r.info));
    lines.push(cells.join(sep));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function fileName(meta) {
  const d = new Date(meta.startT);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const slug = meta.name
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^A-Za-z0-9.]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return `kwr103_${stamp}_${slug}.csv`;
}

// ---------- ZIP (unkomprimiert, ohne externe Bibliothek) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files: [{ name, data: string }] -> Blob (application/zip) */
export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const used = new Set();

  for (const f of files) {
    let fname = f.name;
    for (let k = 2; used.has(fname); k++) fname = f.name.replace(/(\.\w+)?$/, `_${k}$1`);
    used.add(fname);
    const name = enc.encode(fname);
    const data = enc.encode(f.data);
    const crc = crc32(data);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // Dateiname in UTF-8
    lh.setUint16(8, 0, true); // keine Kompression
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh, name, data);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch, name);

    offset += 30 + name.length + data.length;
  }

  const cdSize = central.reduce((s, x) => s + x.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
