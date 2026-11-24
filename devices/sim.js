// Simulator: Netzteil, Last und ein DC/DC-Wandler-Modell – zum Ausprobieren und Testen ohne Hardware.
// Die Messwerte laufen mit einer Zeitkonstante auf den Zielwert zu und haben etwas Rauschen,
// damit die Einschwing-Erkennung wie an echter Hardware arbeitet.

import { Source, Sink } from './base.js';

const TAU_MS = 400;
const UVLO = 3.0; // unterhalb dieser Eingangsspannung schaltet der simulierte Wandler ab

/** Gemeinsamer Zustand von Quelle, Wandler und Last. */
export const simDut = {
  vset: 0, ilim: 1, srcOn: false,   // Quelle
  iset: 0, loadOn: false,           // Last
  vout: 5,                          // am „Poti“ eingestellte Ausgangsspannung
  srcSense: false, sinkSense: false,
  m: { vin: 0, iin: 0, vout: 0, iout: 0 }, t: 0,

  /** Zielwerte aus dem aktuellen Zustand (Wandler mit Verlusten, Strombegrenzung der Quelle). */
  target() {
    let vin = this.srcOn ? this.vset : 0;
    if (vin < UVLO) return { vin, iin: 0, vout: 0, iout: 0, cc: false };
    const iout = this.loadOn ? this.iset : 0;
    const vout = this.vout * (1 - 0.004 * iout);
    const pout = vout * iout;
    const loss = 0.04 + 0.0012 * vin * vin + 0.035 * iout + 0.06 * iout * iout;
    const iin = (pout + loss) / vin;
    if (iin > this.ilim) {
      // Quelle begrenzt: Eingang bricht ein, Wandler fällt aus
      return { vin: vin * 0.4, iin: this.ilim, vout: vout * 0.3, iout: Math.min(iout, 0.3 * iout), cc: true };
    }
    return { vin, iin, vout, iout, cc: false };
  },

  step() {
    const now = performance.now();
    const dt = this.t ? now - this.t : 1e9;
    this.t = now;
    const k = 1 - Math.exp(-dt / TAU_MS);
    const tg = this.target();
    for (const key of ['vin', 'iin', 'vout', 'iout']) this.m[key] += (tg[key] - this.m[key]) * k;
    this.cc = tg.cc;
  },

  read(side) {
    this.step();
    const n = () => 1 + (Math.random() - 0.5) * 0.0006;
    return side === 'src'
      ? { v: this.m.vin * n(), i: this.m.iin * n() }
      : { v: this.m.vout * n(), i: this.m.iout * n() };
  },
};

const tick = () => new Promise((r) => setTimeout(r, 20));

class SimMixin {
  static apply(cls) {
    return class extends cls {
      constructor(...a) { super(...a); this._on = false; }
      get connected() { return this._on; }
      async connect() { this._on = true; this.idn = `SIMULATOR ${this.info.name}`; }
      async disconnect() { if (this._on) { this._on = false; this.onDisconnect(); } }
      async console(cmd) { return `(Simulator) ${cmd}`; }
    };
  }
}

export class SimSource extends SimMixin.apply(Source) {
  async setVoltage(v) { this._check(v, this.limits.vMax, 'Spannung', 'V'); simDut.vset = v; await tick(); }
  async setCurrentLimit(i) { this._check(i, this.limits.iMax, 'Strom', 'A'); simDut.ilim = i; await tick(); }
  async setOutput(on) { simDut.srcOn = on; await tick(); }
  async measure() { await tick(); return simDut.read('src'); }
  async status() { simDut.step(); return { cc: simDut.cc, output: simDut.srcOn, fault: null }; }
  async getVoltageSet() { return simDut.vset; }
  async getCurrentSet() { return simDut.ilim; }
  async setSense(on) { simDut.srcSense = on; }
  async getSense() { return simDut.srcSense; }
}

export class SimSink extends SimMixin.apply(Sink) {
  async setCC() {}
  async setCurrent(i) { this._check(i, this.limits.iMax, 'Strom', 'A'); simDut.iset = i; await tick(); }
  async setInput(on) { simDut.loadOn = on; await tick(); }
  async getInput() { return simDut.loadOn; }
  async getLevel() { return simDut.iset; }
  async measure() { await tick(); return simDut.read('sink'); }
  async setSense(on) { simDut.sinkSense = on; }
  async getSense() { return simDut.sinkSense; }
}
