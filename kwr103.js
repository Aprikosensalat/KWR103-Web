// Treiber für das Labornetzteil KORAD KWR103 (KWR100-Serie) über die Web Serial API.
// Protokoll: ASCII-Befehle mit "\n", Antworten mit "\n", Standard 115200 Baud 8N1.
// Am Gerät geprüft (Firmware V1.8):
//   VSET:4.200 / VSET? -> "04.200"   ISET:0.500 / ISET? -> "00.500"
//   VOUT? / IOUT? -> "03.740" / "00.499"   OUT:1 / OUT:0 / OUT? -> "1"
//   STATUS? -> EIN ROHES BYTE + "\n" (kein Text!):
//       Bit0 1=CV 0=CC · Bit1 Ausgang · Bit2 Priorität · Bit4 Summer · Bit5 Tastensperre · Bit6 OVP aktiv · Bit7 OCP
//   OVP:60.500 / OVP:ON / OVP:OFF / OVP?   (Achtung: "OVP:0" setzt den WERT auf 0 V!)
//   OCP:15.500 / OCP?   (OCP:ON wird per Schnittstelle nicht wirksam – Schutz am Gerät aktivieren)
//   BEEP:1/0 · LOCK:1/0 · COMP:1/0, COMP? (Remote Sense) · RCL:1…5 / SAV:1…5 (M1–M5)

import { UsbSerialPort } from './usbserial.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const LIMITS = { V: 60, I: 15, P: 300 };

export class KWR103 {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.waiter = null; // { binary, resolve, reject, timer }
    this.buf = [];
    this.skipLF = false;
    this.queue = Promise.resolve();
    this.gap = 50; // ms Pause nach jedem Befehl
    this.timeout = 1000;
    this.onLog = () => {};
    this.onDisconnect = () => {};
    this._encoder = new TextEncoder();
  }

  /** Web Serial (Desktop) oder WebUSB (Android) verfügbar? */
  static supported() {
    return 'serial' in navigator || UsbSerialPort.supported();
  }

  get connected() {
    return this.port !== null;
  }

  /** usb=true: Verbindung über WebUSB (CDC-ACM), z. B. unter Android. */
  async connect(baudRate = 115200, { usb = false } = {}) {
    const port = usb ? await UsbSerialPort.request() : await navigator.serial.requestPort();
    await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
    this.port = port;
    this.writer = port.writable.getWriter();
    this.reader = port.readable.getReader();
    this.buf = [];
    this.skipLF = false;
    this._readLoop();
  }

  async disconnect() {
    const port = this.port;
    if (!port) return;
    this.port = null;
    this._rejectWaiter(new Error('Verbindung getrennt'));
    try { await this.reader?.cancel(); } catch {}
    try { this.reader?.releaseLock(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await port.close(); } catch {}
    this.reader = this.writer = null;
    this.onDisconnect();
  }

  async _readLoop() {
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        for (const b of value) this.buf.push(b);
        this._process();
      }
    } catch (e) {
      this.onLog('err', `Lesefehler: ${e.message}`);
    }
    if (this.port) await this.disconnect();
  }

  /** Zerlegt den Byte-Puffer in Antworten (Textzeilen oder ein rohes Statusbyte). */
  _process() {
    while (this.buf.length) {
      if (this.skipLF) {
        if (this.buf[0] === 0x0a) this.buf.shift();
        this.skipLF = false;
        continue;
      }
      if (this.waiter?.binary) {
        const byte = this.buf.shift();
        this.skipLF = true;
        this.onLog('rx', `0x${byte.toString(16).padStart(2, '0')}`);
        this._resolve(byte);
        continue;
      }
      const i = this.buf.indexOf(0x0a);
      if (i < 0) return;
      const bytes = this.buf.splice(0, i + 1).slice(0, -1);
      const line = String.fromCharCode(...bytes).replace(/\r$/, '').trim();
      if (!line) continue;
      this.onLog('rx', line);
      if (this.waiter) this._resolve(line);
    }
  }

  _resolve(value) {
    const w = this.waiter;
    this.waiter = null;
    clearTimeout(w.timer);
    w.resolve(value);
  }

  _rejectWaiter(err) {
    if (!this.waiter) return;
    const w = this.waiter;
    this.waiter = null;
    clearTimeout(w.timer);
    w.reject(err);
  }

  _wait(binary, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('Zeitüberschreitung – keine Antwort'));
      }, timeout);
      this.waiter = { binary, resolve, reject, timer };
    });
  }

  async _raw(cmd) {
    if (!this.writer) throw new Error('Nicht verbunden');
    this.onLog('tx', cmd);
    await this.writer.write(this._encoder.encode(cmd + '\n'));
  }

  _enqueue(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Befehl ohne Antwort senden. */
  write(cmd) {
    return this._enqueue(async () => {
      await this._raw(cmd);
      await sleep(this.gap);
    });
  }

  /** Abfrage senden; binary=true liefert das erste Antwortbyte als Zahl. */
  query(cmd, { binary = false, timeout = this.timeout } = {}) {
    return this._enqueue(async () => {
      // Reste früherer Antworten verwerfen, damit Antworten nicht verrutschen
      this.buf = [];
      this.skipLF = false;
      const answer = this._wait(binary, timeout);
      await this._raw(cmd);
      try {
        return await answer;
      } finally {
        await sleep(this.gap);
      }
    });
  }

  async queryNumber(cmd) {
    const r = await this.query(cmd);
    const v = parseFloat(r);
    if (Number.isNaN(v)) throw new Error(`Ungültige Antwort auf ${cmd}: ${r}`);
    return v;
  }

  // ---- Grundfunktionen ----

  identify() {
    return this.query('*IDN?');
  }

  setVoltage(v) {
    if (!(v >= 0 && v <= LIMITS.V)) throw new Error(`Spannung muss zwischen 0 und ${LIMITS.V} V liegen.`);
    return this.write(`VSET:${v.toFixed(3)}`);
  }

  setCurrent(i) {
    if (!(i >= 0 && i <= LIMITS.I)) throw new Error(`Strom muss zwischen 0 und ${LIMITS.I} A liegen.`);
    return this.write(`ISET:${i.toFixed(3)}`);
  }

  getVoltageSet() {
    return this.queryNumber('VSET?');
  }

  getCurrentSet() {
    return this.queryNumber('ISET?');
  }

  setOutput(on) {
    return this.write(`OUT:${on ? 1 : 0}`);
  }

  async getOutput() {
    return (await this.query('OUT?')).trim() === '1';
  }

  async measure() {
    const v = await this.queryNumber('VOUT?');
    const i = await this.queryNumber('IOUT?');
    return { v, i, p: v * i };
  }

  async status() {
    const s = await this.query('STATUS?', { binary: true });
    return {
      raw: s,
      cv: (s & 0x01) !== 0,
      output: (s & 0x02) !== 0,
      currentPriority: (s & 0x04) !== 0,
      beep: (s & 0x10) !== 0,
      lock: (s & 0x20) !== 0,
      ovp: (s & 0x40) !== 0,
      ocp: (s & 0x80) !== 0,
    };
  }

  // ---- Schutz ----

  setOVP(v) {
    if (!(v > 0 && v <= LIMITS.V + 1)) throw new Error('Ungültiger OVP-Wert.');
    return this.write(`OVP:${v.toFixed(3)}`);
  }

  getOVP() {
    return this.queryNumber('OVP?');
  }

  /** OVP ein/aus – nur mit ON/OFF, niemals 1/0 (das wäre ein Spannungswert). */
  enableOVP(on) {
    return this.write(`OVP:${on ? 'ON' : 'OFF'}`);
  }

  setOCP(i) {
    if (!(i > 0 && i <= LIMITS.I + 1)) throw new Error('Ungültiger OCP-Wert.');
    return this.write(`OCP:${i.toFixed(3)}`);
  }

  getOCP() {
    return this.queryNumber('OCP?');
  }

  // ---- System ----

  setBeep(on) {
    return this.write(`BEEP:${on ? 1 : 0}`);
  }

  setLock(on) {
    return this.write(`LOCK:${on ? 1 : 0}`);
  }

  setSense(on) {
    return this.write(`COMP:${on ? 1 : 0}`);
  }

  async getSense() {
    return (await this.query('COMP?')).trim() === '1';
  }

  /** M1–M5 abrufen (setzt VSET/ISET). */
  recall(m) {
    return this.write(`RCL:${m}`);
  }

  /** Aktuelle VSET/ISET in M1–M5 speichern. */
  save(m) {
    return this.write(`SAV:${m}`);
  }
}
