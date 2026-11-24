// Geräte-Registry: Jeder Eintrag erscheint im Dropdown „Quelle“ bzw. „Senke“.
// Neues Gerät: Klasse in einer eigenen Datei (erweitert Source oder Sink) und hier eine Zeile register(...).
//
// DeviceInfo:
//   id, name, kind ('source' | 'sink'), idnMatch (RegExp für *IDN?),
//   channels: [{ vMax, iMax }] je Kanal, pMax (W),
//   baudRates, defaultBaud, gapMs (Pause nach jedem Befehl),
//   senseControl (Remote Sense per Befehl schaltbar), senseHint (Hinweis, falls nicht),
//   usbCdc (über WebUSB unter Android nutzbar), accI: [relativ, absolut A] Genauigkeit der Strommessung,
//   sim (Simulator ohne seriellen Port)

import { KWR103Source, KA3005PSource, KEL103Sink } from './korad.js';
import { NGP800Source, HmpSource } from './rs-scpi.js';
import { ITechSink } from './itech.js';
import { SimSource, SimSink } from './sim.js';

class DeviceRegistry {
  constructor() {
    this.entries = new Map();
  }

  register(info, factory) {
    if (this.entries.has(info.id)) throw new Error(`Gerät ${info.id} doppelt registriert`);
    this.entries.set(info.id, { info: Object.freeze(info), factory });
  }

  list(kind) {
    return [...this.entries.values()].map((e) => e.info).filter((i) => i.kind === kind);
  }

  info(id) {
    return this.entries.get(id)?.info ?? null;
  }

  create(id, options = {}) {
    const e = this.entries.get(id);
    if (!e) throw new Error(`Unbekanntes Gerät ${id}`);
    return e.factory(e.info, options);
  }
}

export const registry = new DeviceRegistry();

const ch = (n, vMax, iMax) => Array.from({ length: n }, () => ({ vMax, iMax }));
const KORAD_BAUD = [9600, 19200, 38400, 57600, 115200];
const RS_BAUD = [9600, 19200, 38400, 57600, 115200];

// ---------- Quellen ----------
registry.register({
  id: 'kwr103', name: 'KORAD KWR103', kind: 'source', idnMatch: /KWR10/,
  channels: ch(1, 60, 15), pMax: 300, baudRates: KORAD_BAUD, defaultBaud: 115200, gapMs: 50,
  senseControl: true, usbCdc: true, accI: [0.001, 0.003],
}, (info, o) => new KWR103Source(info, o));

registry.register({
  id: 'ka3005p', name: 'KORAD KA3005P', kind: 'source', idnMatch: /KA3005P/,
  channels: ch(1, 30, 5), pMax: 150, baudRates: [9600], defaultBaud: 9600, gapMs: 50,
  senseControl: false, senseHint: 'Das KA3005P hat keinen Remote-Sense-Eingang.',
  usbCdc: true, accI: [0.002, 0.01], // Messgenauigkeit Datenblatt-Näherung, Auflösung 1 mA / 10 mV
}, (info, o) => new KA3005PSource(info, o));

const ngp = (id, name, channels, pMax) => registry.register({
  id, name, kind: 'source', idnMatch: new RegExp(name.split(' ').pop()),
  channels, pMax, baudRates: RS_BAUD, defaultBaud: 115200, gapMs: 30,
  senseControl: true, usbCdc: true, accI: [0.0005, 0.002],
  note: 'Am Gerät USB-Klasse „CDC“ einstellen (Netzwerkverbindungen → USB Class), danach Neustart.',
}, (info, o) => new NGP800Source(info, o));
ngp('ngp802', 'R&S NGP802', ch(2, 32, 20), 400);
ngp('ngp822', 'R&S NGP822', ch(2, 64, 10), 400);
ngp('ngp804', 'R&S NGP804', ch(4, 32, 20), 800);
ngp('ngp814', 'R&S NGP814', [...ch(2, 32, 20), ...ch(2, 64, 10)], 800);
ngp('ngp824', 'R&S NGP824', ch(4, 64, 10), 800);

const hmp = (id, name, channels, pMax) => registry.register({
  id, name, kind: 'source', idnMatch: new RegExp(name.split(' ').pop()),
  channels, pMax, baudRates: RS_BAUD, defaultBaud: 9600, gapMs: 100,
  senseControl: false, senseHint: 'Remote Sense beim HMP über die Sense-Klemmen am Gerät (kein Befehl).',
  usbCdc: false, accI: [0.001, 0.002],
  note: 'Schnittstelle am Gerät: MENU → INTERFACE (USB-VCP oder RS-232); Baudrate wie am Gerät eingestellt.',
}, (info, o) => new HmpSource(info, o));
hmp('hmp2020', 'R&S HMP2020', [{ vMax: 32, iMax: 10 }, { vMax: 32, iMax: 5 }], 188);
hmp('hmp2030', 'R&S HMP2030', ch(3, 32, 5), 188);
hmp('hmp4030', 'R&S HMP4030', ch(3, 32, 10), 384);
hmp('hmp4040', 'R&S HMP4040', ch(4, 32, 10), 384);

registry.register({
  id: 'sim-source', name: 'Simulator (ohne Gerät)', kind: 'source', sim: true,
  channels: ch(1, 60, 15), pMax: 300, baudRates: [], defaultBaud: 0, senseControl: true, accI: [0.001, 0.003],
}, (info, o) => new SimSource(info, o));

// ---------- Senken ----------
registry.register({
  id: 'kel103', name: 'KORAD KEL103', kind: 'sink', idnMatch: /KEL10/,
  channels: ch(1, 120, 30), pMax: 300, baudRates: KORAD_BAUD, defaultBaud: 115200, gapMs: 50,
  senseControl: true, usbCdc: true, accI: [0.001, 0.01],
}, (info, o) => new KEL103Sink(info, o));

registry.register({
  id: 'it8514c', name: 'ITECH IT8514C+', kind: 'sink', idnMatch: /IT8514C/,
  channels: ch(1, 120, 240), pMax: 1500, baudRates: [4800, 9600, 19200, 38400], defaultBaud: 9600, gapMs: 50,
  senseControl: true, usbCdc: false, accI: [0.001, 0.01],
  note: 'USB = Prolific-Seriell-Wandler (Treiber IT-E122); Baudrate am Gerät: Shift + 8. Nicht gleichzeitig DB9 und USB anschließen.',
}, (info, o) => new ITechSink(info, o));

registry.register({
  id: 'sim-sink', name: 'Simulator (ohne Gerät)', kind: 'sink', sim: true,
  channels: ch(1, 120, 30), pMax: 300, baudRates: [], defaultBaud: 0, senseControl: true, accI: [0.001, 0.01],
}, (info, o) => new SimSink(info, o));
