// Adapter für KEL103-Web und KWR103-Web: Ein Gerät aus der Registry bekommt die Schnittstelle der
// dortigen Originaltreiber (KEL103 bzw. KWR103), aber nur die Grundfunktionen. Sonderfunktionen
// (Batterietest, Dynamik, Laden, …) bleiben dem Originalgerät vorbehalten.
// Gemeinsam genutzt von Effizienzmessung-Web, KEL103-Web und KWR103-Web (Datei identisch halten).

import { registry } from './index.js';
import { serialSupported, usbSupported } from '../link/serial-link.js';

class Adapter {
  constructor(id, { channel = 1 } = {}) {
    this.info = registry.info(id);
    this.dev = registry.create(id, { channel });
  }

  static supported() {
    return serialSupported() || usbSupported();
  }

  get connected() { return this.dev.connected; }
  set onLog(fn) { this.dev.link.onLog = fn; }
  set onDisconnect(fn) { this.dev.onDisconnect = fn; }
  get limits() { return this.dev.limits; }
  get senseControl() { return this.dev.senseControl; }

  async connect(baudRate, { usb = false } = {}) {
    await this.dev.connect({ usb, baudRate: baudRate || this.info.defaultBaud });
  }

  disconnect() { return this.dev.disconnect(); }
  async identify() { return this.dev.idn; }
  query(cmd, opts) { return this.dev.link.query(cmd, opts); }
  write(cmd) { return this.dev.link.write(cmd); }
  setSense(on) { return this.dev.setSense(on); }
  async getSense() { return this.senseControl ? this.dev.getSense() : null; }
}

/** Netzteil mit der Schnittstelle von KWR103 (kwr103.js). */
export class GenericSource extends Adapter {
  constructor(id, opts) {
    super(id, opts);
    this._v = null;
    this._i = null;
    this._out = false;
  }

  async setVoltage(v) { await this.dev.setVoltage(v); this._v = v; }
  async setCurrent(i) { await this.dev.setCurrentLimit(i); this._i = i; }
  async setOutput(on) { await this.dev.setOutput(on); this._out = on; }
  async getVoltageSet() { return this.dev.getVoltageSet ? this.dev.getVoltageSet() : this._v; }
  async getCurrentSet() { return this.dev.getCurrentSet ? this.dev.getCurrentSet() : this._i; }

  async measure() {
    const { v, i } = await this.dev.measure();
    return { v, i, p: v * i };
  }

  /** { cv, output, fault } – OVP, Tastensperre usw. gibt es nur beim Originalgerät (null). */
  async status() {
    const st = await this.dev.status();
    let output = st.output;
    if (output === undefined) output = this.dev.getOutput ? await this.dev.getOutput() : this._out;
    this._out = output;
    return { cv: st.cc == null ? true : !st.cc, output, fault: st.fault ?? null, ovp: null, lock: null, beep: null };
  }
}

/** Elektronische Last mit der Schnittstelle von KEL103 (kel103.js). */
export class GenericLoad extends Adapter {
  constructor(id, opts) {
    super(id, opts);
    this._mode = 'CC';
    this._in = false;
    this._set = {};
  }

  get modes() { return this.dev.modes; }

  /** Größter Sollwert je Betriebsart. */
  modeMax(mode) {
    const l = this.dev.limits;
    return { CC: l.iMax, CV: l.vMax, CR: 10000, CW: l.pMax }[mode];
  }

  async connect(baudRate, opts) {
    await super.connect(baudRate, opts);
    this._in = this.dev.getInput ? await this.dev.getInput() : false;
    if (this.dev.getMode) this._mode = await this.dev.getMode();
    else if (!this._in) await this.dev.setCC(); // nur CC: beim Verbinden sicher einstellen
  }

  async setInput(on) { await this.dev.setInput(on); this._in = on; }

  async getInput() {
    if (this.dev.getInput) this._in = await this.dev.getInput();
    return this._in;
  }

  async setMode(mode) {
    if (!this.modes.includes(mode)) throw new Error(`${this.info.name} unterstützt ${mode} nicht.`);
    if (this.dev.setMode) await this.dev.setMode(mode);
    else await this.dev.setCC();
    this._mode = mode;
  }

  async getMode() {
    if (this.dev.getMode) this._mode = await this.dev.getMode();
    return this._mode;
  }

  async setSetpoint(mode, value) {
    const max = this.modeMax(mode);
    if (!(value >= 0 && value <= max)) throw new Error(`Wert außerhalb 0…${max}`);
    if (this.dev.setLevel) await this.dev.setLevel(mode, value);
    else await this.dev.setCurrent(value);
    this._set[mode] = value;
  }

  async getSetpoint(mode) {
    if (this.dev.getLevel) return this.dev.getLevel(mode);
    return this._set[mode] ?? 0;
  }

  async measureVI() {
    const { v, i } = await this.dev.measure();
    return { v, i, p: v * i };
  }

  measure() { return this.measureVI(); }

  /** Wie KEL103.status(); nur Remote Sense ist allgemein verfügbar. */
  async status() {
    return { beep: null, baud: null, lock: null, extTrigger: null, sense: await this.getSense() };
  }

  async limits() {
    const l = this.dev.limits;
    return { V: [0, l.vMax], I: [0, l.iMax], R: [0, this.modeMax('CR')], P: [0, l.pMax] };
  }
}
