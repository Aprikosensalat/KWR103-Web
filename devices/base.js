// Gemeinsame Basis aller Geräte. Ein neues Gerät erweitert Source (Netzteil) oder Sink (Last)
// und wird in devices/index.js registriert.

import { SerialLink } from '../link/serial-link.js';

export class Instrument {
  /**
   * @param {object} info     Eintrag aus der Registry (DeviceInfo)
   * @param {{ channel?: number }} opts
   */
  constructor(info, { channel = 1 } = {}) {
    this.info = info;
    this.channel = channel;
    this.idn = '';
    this.link = new SerialLink({ gap: info.gapMs ?? 50, timeout: info.timeoutMs ?? 1000, eol: info.eol ?? '\n' });
    this.onDisconnect = () => {};
    this.link.onDisconnect = () => this.onDisconnect();
  }

  get connected() {
    return this.link.connected;
  }

  /** Grenzen des gewählten Kanals: { vMax, iMax, pMax } */
  get limits() {
    const ch = this.info.channels[this.channel - 1] ?? this.info.channels[0];
    return { vMax: ch.vMax, iMax: ch.iMax, pMax: ch.pMax ?? this.info.pMax };
  }

  get senseControl() {
    return !!this.info.senseControl;
  }

  async connect({ usb = false, baudRate = this.info.defaultBaud } = {}) {
    await this.link.open({ usb, baudRate, flowControl: this.info.flowControl ?? 'none' });
    try {
      this.idn = await this.identify();
      await this.init();
    } catch (e) {
      await this.link.close();
      throw e;
    }
  }

  async disconnect() {
    if (!this.connected) return;
    try { await this.release(); } catch {}
    await this.link.close();
  }

  identify() {
    return this.link.query('*IDN?');
  }

  /** Stimmt die Geräteantwort mit dem gewählten Modell überein? */
  idnMatches() {
    return !this.info.idnMatch || this.info.idnMatch.test(this.idn);
  }

  /** Nach dem Verbinden (z. B. Fernsteuermodus, Kanal wählen). */
  async init() {}

  /** Vor dem Trennen (z. B. zurück in den Lokalbetrieb). */
  async release() {}

  async setSense(_on) {
    throw new Error('Remote Sense ist bei diesem Gerät nicht per Befehl schaltbar.');
  }

  /** true/false, oder null wenn nicht abfragbar. */
  async getSense() {
    return null;
  }

  /** Beliebiger Befehl aus der Konsole. */
  async console(cmd) {
    return cmd.includes('?') ? this.link.query(cmd) : this.link.write(cmd).then(() => '');
  }

  _check(value, max, what, unit) {
    if (!(Number.isFinite(value) && value >= 0 && value <= max)) {
      throw new Error(`${what} ${value} ${unit} außerhalb 0…${max} ${unit}`);
    }
  }
}

/** Netzteil am Eingang des Wandlers. */
export class Source extends Instrument {
  async setVoltage(_v) { throw new Error('nicht implementiert'); }
  async setCurrentLimit(_i) { throw new Error('nicht implementiert'); }
  async setOutput(_on) { throw new Error('nicht implementiert'); }
  /** @returns {Promise<{ v: number, i: number }>} */
  async measure() { throw new Error('nicht implementiert'); }
  /** @returns {Promise<{ cc: boolean|null, output?: boolean, fault: string|null }>} */
  async status() { return { cc: null, fault: null }; }
  // Optional (für die Steuerungsseiten): getVoltageSet(), getCurrentSet(), getOutput()
  /** Sicher abschalten. */
  safeOff() { return this.setOutput(false); }
}

/** Elektronische Last am Ausgang des Wandlers. */
export class Sink extends Instrument {
  /** Konstantstrombetrieb einstellen. */
  async setCC() { throw new Error('nicht implementiert'); }
  async setCurrent(_i) { throw new Error('nicht implementiert'); }
  async setInput(_on) { throw new Error('nicht implementiert'); }
  /** @returns {Promise<{ v: number, i: number }>} */
  async measure() { throw new Error('nicht implementiert'); }
  /** @returns {Promise<{ fault: string|null, senseMissing?: boolean }>} */
  async status() { return { fault: null }; }
  /** Vor dem Messlauf: z. B. passenden Strombereich nach dem größten Strom wählen. */
  async prepare(_iMax) {}
  /** Unterstützte Betriebsarten; Geräte mit mehr als CC überschreiben modes, setMode, getMode, setLevel, getLevel. */
  get modes() { return ['CC']; }
  // Optional: getInput()
  safeOff() { return this.setInput(false); }
}
