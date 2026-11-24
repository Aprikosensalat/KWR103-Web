// ITECH IT8500+-Serie (IT8514C+). Nach dem Programmierhandbuch umgesetzt – nicht an der Hardware geprüft.
//   SYST:REM (Pflicht über RS-232/USB) · FUNC CURR · CURR x · CURR:RANG x · INP ON/OFF
//   MEAS:VOLT? · MEAS:CURR? · SYST:SENS ON/OFF · STAT:QUES:COND?
//   Fragwürdig-Register: Bit 0 VF, 1 OC, 3 OP, 4 OT, 8 Sense nicht angeschlossen, 11 ungeregelt, 13 OV

import { Sink } from './base.js';

// Betriebsart -> Funktionsname und Sollwert-Befehl
const MODES = { CC: 'CURR', CV: 'VOLT', CR: 'RES', CW: 'POW' };

const QUES_BITS = [
  [0, 'Über-/Verpolungsspannung'], [1, 'Überstrom'], [3, 'Überleistung'], [4, 'Übertemperatur'], [13, 'Überspannung'],
];

export class ITechSink extends Sink {
  async init() {
    await this.link.write('SYST:REM');
  }

  async release() {
    await this.link.write('SYST:LOC');
  }

  setCC() {
    return this.link.write('FUNC CURR');
  }

  /** Kleinsten Strombereich wählen, der den größten Messstrom abdeckt (bessere Auflösung). */
  prepare(iMax) {
    return this.link.write(`CURR:RANG ${Math.min(iMax * 1.05, this.limits.iMax).toFixed(3)}`);
  }

  setCurrent(i) {
    this._check(i, this.limits.iMax, 'Strom', 'A');
    return this.link.write(`CURR ${i.toFixed(4)}`);
  }

  setInput(on) {
    return this.link.write(`INP ${on ? 'ON' : 'OFF'}`);
  }

  async getInput() {
    return /^(1|ON)$/i.test((await this.link.query('INP?')).trim());
  }

  get modes() { return Object.keys(MODES); }

  setMode(mode) {
    if (!MODES[mode]) throw new Error(`Betriebsart ${mode} nicht unterstützt`);
    return this.link.write(`FUNC ${MODES[mode]}`);
  }

  async getMode() {
    const r = (await this.link.query('FUNC?')).trim().toUpperCase();
    return Object.keys(MODES).find((m) => r.startsWith(MODES[m])) ?? r;
  }

  setLevel(mode, value) {
    if (!MODES[mode]) throw new Error(`Betriebsart ${mode} nicht unterstützt`);
    if (!(Number.isFinite(value) && value >= 0)) throw new Error('Ungültiger Sollwert');
    return this.link.write(`${MODES[mode]} ${value}`);
  }

  getLevel(mode) {
    return this.link.queryNumber(`${MODES[mode]}?`);
  }

  async measure() {
    const v = await this.link.queryNumber('MEAS:VOLT?');
    const i = await this.link.queryNumber('MEAS:CURR?');
    return { v, i };
  }

  async status() {
    const q = await this.link.queryNumber('STAT:QUES:COND?');
    const fault = QUES_BITS.filter(([b]) => q & (1 << b)).map(([, t]) => t).join(', ') || null;
    return { fault, senseMissing: (q & (1 << 8)) !== 0, unregulated: (q & (1 << 11)) !== 0 };
  }

  setSense(on) {
    return this.link.write(`SYST:SENS ${on ? 'ON' : 'OFF'}`);
  }

  async getSense() {
    return /^(1|ON)$/i.test((await this.link.query('SYST:SENS?')).trim());
  }
}
