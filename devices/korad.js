// KORAD KWR103 (Netzteil) und KORAD KEL103 (Last) – Befehle am Gerät geprüft
// (siehe KWR103-Web und KEL103-Web).

import { Source, Sink } from './base.js';

/** KORAD KWR103: VSET/ISET/OUT, STATUS? liefert ein rohes Byte (Bit 0 = CV). */
export class KWR103Source extends Source {
  setVoltage(v) {
    this._check(v, this.limits.vMax, 'Spannung', 'V');
    return this.link.write(`VSET:${v.toFixed(3)}`);
  }

  setCurrentLimit(i) {
    this._check(i, this.limits.iMax, 'Strom', 'A');
    return this.link.write(`ISET:${i.toFixed(3)}`);
  }

  setOutput(on) {
    return this.link.write(`OUT:${on ? 1 : 0}`);
  }

  async measure() {
    const v = await this.link.queryNumber('VOUT?');
    const i = await this.link.queryNumber('IOUT?');
    return { v, i };
  }

  async status() {
    const s = await this.link.query('STATUS?', { binary: true });
    return { cc: (s & 0x01) === 0 && (s & 0x02) !== 0, output: (s & 0x02) !== 0, fault: null };
  }

  getVoltageSet() { return this.link.queryNumber('VSET?'); }
  getCurrentSet() { return this.link.queryNumber('ISET?'); }

  setSense(on) {
    return this.link.write(`COMP:${on ? 1 : 0}`);
  }

  async getSense() {
    return (await this.link.query('COMP?')).trim() === '1';
  }
}

/** KORAD KEL103: :FUNC CC, :CURR x A, :INP ON/OFF, :MEAS:VOLT?/CURR?, :SYST:COMP (Sense). */
export class KEL103Sink extends Sink {
  setCC() {
    return this.link.write(':FUNC CC');
  }

  setCurrent(i) {
    this._check(i, this.limits.iMax, 'Strom', 'A');
    return this.link.write(`:CURR ${Number(i.toFixed(4))}A`);
  }

  setInput(on) {
    return this.link.write(`:INP ${on ? 'ON' : 'OFF'}`);
  }

  async measure() {
    const v = await this.link.queryNumber(':MEAS:VOLT?');
    const i = await this.link.queryNumber(':MEAS:CURR?');
    return { v, i };
  }

  setSense(on) {
    return this.link.write(`:SYST:COMP ${on ? 'ON' : 'OFF'}`);
  }

  async getSense() {
    return (await this.link.query(':SYST:COMP?')).toUpperCase() === 'ON';
  }
}

/**
 * KORAD KA3005P (30 V / 5 A), am Gerät geprüft (Firmware V5.8, 9600 Baud):
 *   VSET1:1.00 / VSET1? -> "01.00" · ISET1:0.050 / ISET1? -> "0.050" · OUT1 / OUT0 (ohne Doppelpunkt)
 *   VOUT1? / IOUT1? · STATUS? -> rohes Byte: Bit 0 = CV (1) / CC (0), Bit 6 = Ausgang ein
 *   Antworten enden nur dann mit "\n", wenn der Befehl mit "\n" gesendet wurde. Kein Remote Sense.
 */
export class KA3005PSource extends Source {
  setVoltage(v) {
    this._check(v, this.limits.vMax, 'Spannung', 'V');
    return this.link.write(`VSET1:${v.toFixed(2)}`);
  }

  setCurrentLimit(i) {
    this._check(i, this.limits.iMax, 'Strom', 'A');
    return this.link.write(`ISET1:${i.toFixed(3)}`);
  }

  setOutput(on) {
    return this.link.write(on ? 'OUT1' : 'OUT0');
  }

  async measure() {
    const v = await this.link.queryNumber('VOUT1?');
    const i = await this.link.queryNumber('IOUT1?');
    return { v, i };
  }

  async status() {
    const s = await this.link.query('STATUS?', { binary: true });
    const output = (s & 0x40) !== 0;
    return { cc: output && (s & 0x01) === 0, output, fault: null };
  }

  getVoltageSet() { return this.link.queryNumber('VSET1?'); }
  getCurrentSet() { return this.link.queryNumber('ISET1?'); }
}
