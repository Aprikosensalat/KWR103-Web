// Serielle Verbindung zu einem Messgerät: Port öffnen (Web Serial oder WebUSB-CDC),
// Befehlswarteschlange mit Pause, Antworten als Textzeile oder als rohes Byte.

import { UsbSerialPort } from './usbserial.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function serialSupported() {
  return 'serial' in navigator;
}
export function usbSupported() {
  return UsbSerialPort.supported();
}

export class SerialLink {
  /**
   * @param {{ gap?: number, timeout?: number, eol?: string }} opts
   *   gap: Pause nach jedem Befehl (ms), timeout: Wartezeit auf eine Antwort (ms), eol: Zeilenende beim Senden
   */
  constructor({ gap = 50, timeout = 1000, eol = '\n' } = {}) {
    this.gap = gap;
    this.timeout = timeout;
    this.eol = eol;
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.waiter = null; // { binary, resolve, reject, timer }
    this.buf = [];
    this.skipLF = false;
    this.queue = Promise.resolve();
    this.onLog = () => {};
    this.onDisconnect = () => {};
    this._encoder = new TextEncoder();
  }

  get connected() {
    return this.port !== null;
  }

  /** Öffnet den Port; usb=true nutzt WebUSB (Android), sonst Web Serial. */
  async open({ usb = false, baudRate = 115200, flowControl = 'none' } = {}) {
    const port = usb ? await UsbSerialPort.request() : await navigator.serial.requestPort();
    await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl });
    this.port = port;
    this.writer = port.writable.getWriter();
    this.reader = port.readable.getReader();
    this.buf = [];
    this.skipLF = false;
    this._readLoop();
  }

  async close() {
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
    if (this.port) await this.close();
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
      const line = new TextDecoder().decode(new Uint8Array(bytes)).replace(/\r$/, '').trim();
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
    await this.writer.write(this._encoder.encode(cmd + this.eol));
  }

  _enqueue(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Befehl ohne Antwort. */
  write(cmd) {
    return this._enqueue(async () => {
      await this._raw(cmd);
      await sleep(this.gap);
    });
  }

  /** Abfrage; binary=true liefert das erste Antwortbyte als Zahl. */
  query(cmd, { binary = false, timeout = this.timeout } = {}) {
    return this._enqueue(async () => {
      this.buf = []; // Reste früherer Antworten verwerfen
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

  /** Abfrage mit Zahlenantwort; Einheiten wie „12.3V“ werden ignoriert. */
  async queryNumber(cmd) {
    const r = await this.query(cmd);
    const v = parseFloat(r);
    if (Number.isNaN(v)) throw new Error(`Ungültige Antwort auf ${cmd}: ${r}`);
    return v;
  }
}
