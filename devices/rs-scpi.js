// Rohde & Schwarz Netzteile NGP800 und HMP (gemeinsamer SCPI-Befehlssatz).
// Nach Handbuch umgesetzt (HMP SCPI Programmers Manual, NGP800 User Manual) – nicht an der Hardware geprüft.
//   INST:NSEL n · VOLT x · CURR x · OUTP:SEL ON/OFF · OUTP:GEN ON · MEAS:VOLT? · MEAS:CURR?
//   STAT:QUES:INST:ISUM<n>:COND?  Bit 0 = CC, Bit 1 = CV · SYST:REM / SYST:LOC

import { Source } from './base.js';

export class RsScpiSource extends Source {
  async init() {
    await this.link.write('SYST:REM');
    await this.select();
  }

  async release() {
    await this.link.write('SYST:LOC');
  }

  /** Kanal wählen; alle folgenden Befehle betreffen diesen Kanal. */
  select() {
    return this.link.write(`INST:NSEL ${this.channel}`);
  }

  setVoltage(v) {
    this._check(v, this.limits.vMax, 'Spannung', 'V');
    return this.link.write(`VOLT ${v.toFixed(3)}`);
  }

  setCurrentLimit(i) {
    this._check(i, this.limits.iMax, 'Strom', 'A');
    return this.link.write(`CURR ${i.toFixed(4)}`);
  }

  async setOutput(on) {
    await this.select();
    if (on) {
      await this.link.write('OUTP:SEL ON');
      await this.link.write('OUTP:GEN ON');
    } else {
      await this.link.write('OUTP:SEL OFF');
    }
  }

  getVoltageSet() { return this.link.queryNumber('VOLT?'); }
  getCurrentSet() { return this.link.queryNumber('CURR?'); }
  async getOutput() { return /^(1|ON)$/i.test((await this.link.query('OUTP?')).trim()); }

  async measure() {
    const v = await this.link.queryNumber('MEAS:VOLT?');
    const i = await this.link.queryNumber('MEAS:CURR?');
    return { v, i };
  }

  async status() {
    const c = await this.link.queryNumber(`STAT:QUES:INST:ISUM${this.channel}:COND?`);
    return { cc: (c & 1) !== 0, fault: await this.faults() };
  }

  /** Geräteabhängige Schutzabfragen; null = kein Fehler. */
  async faults() {
    return null;
  }
}

/** R&S NGP800: Remote Sense per VOLT:SENS AUTO|EXT (EXT = Sense-Relais fest ein). */
export class NGP800Source extends RsScpiSource {
  setSense(on) {
    return this.link.write(`VOLT:SENS ${on ? 'EXT' : 'AUTO'}`);
  }

  async getSense() {
    return /EXT/i.test(await this.link.query('VOLT:SENS?'));
  }

  async faults() {
    const ovp = (await this.link.query('VOLT:PROT:TRIP?')).trim() === '1';
    return ovp ? 'OVP ausgelöst' : null;
  }
}

/** R&S HMP2020/2030/4030/4040: Sense nur über die Klemmen am Gerät; elektronische Sicherung und OVP abfragbar. */
export class HmpSource extends RsScpiSource {
  async faults() {
    if ((await this.link.query('FUSE:TRIP?')).trim() === '1') return 'Sicherung ausgelöst';
    if ((await this.link.query('VOLT:PROT:TRIP?')).trim() === '1') return 'OVP ausgelöst';
    return null;
  }
}
