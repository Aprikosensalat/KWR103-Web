// Serielle Verbindung über WebUSB – gedacht für Chrome unter Android: Dort unterstützt die Web Serial API
// nur Bluetooth, USB-Geräte sind aber über WebUSB erreichbar. Die Seite spricht das USB-Protokoll des
// Seriell-Chips dann selbst. Unterstützt:
//   - USB-CDC-ACM (Standard, z. B. KORAD KEL103/KWR103/KA3005P: VID 0x0416, PID 0x5011)  – am Gerät geprüft
//   - Prolific PL2303 (z. B. ITECH IT8514C+ über IT-E122)                               – nach Linux pl2303.c, ungetestet
//   - FTDI FT232 & Co. (z. B. R&S/HAMEG HO720/HO730 im HMP)                              – nach Linux ftdi_sio.c, ungetestet
// Die Klasse bildet die Teile der Web-Serial-Schnittstelle nach, die die Gerätetreiber nutzen:
// open({ baudRate }), readable, writable, close().
// Gemeinsam genutzt von KEL103-Web, KWR103-Web und Effizienzmessung-Web (Datei identisch halten).

const CLASS_COMM = 0x02;
const CLASS_DATA = 0x0a;
const CLASS_VENDOR = 0xff;
const SET_LINE_CODING = 0x20;
const SET_CONTROL_LINE_STATE = 0x22;

const VID_PROLIFIC = 0x067b;
const VID_FTDI = 0x0403;

export const USB_FILTERS = [
  { vendorId: 0x0416, productId: 0x5011 }, // KORAD (CDC)
  { classCode: CLASS_COMM },               // andere CDC-Geräte
  { vendorId: VID_PROLIFIC },              // PL2303 (z. B. ITECH IT-E122)
  { vendorId: VID_FTDI },                  // FTDI (z. B. HAMEG/R&S HO720/HO730)
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Line-Coding-Block (CDC und PL2303): Baudrate, Stoppbits, Parität, Datenbits. */
function lineCoding({ baudRate, stopBits, parity, dataBits }) {
  const lc = new DataView(new ArrayBuffer(7));
  lc.setUint32(0, baudRate, true);
  lc.setUint8(4, stopBits === 2 ? 2 : 0);
  lc.setUint8(5, { none: 0, odd: 1, even: 2 }[parity] ?? 0);
  lc.setUint8(6, dataBits);
  return lc.buffer;
}

// ---------- Chip-Strategien ----------

/** Standard USB-CDC-ACM. */
const CDC = {
  name: 'CDC',
  async setup(p, opts) {
    await p._classOut(SET_LINE_CODING, 0, lineCoding(opts));
    await p._classOut(SET_CONTROL_LINE_STATE, 0x03); // DTR + RTS
  },
  async teardown(p) {
    await p._classOut(SET_CONTROL_LINE_STATE, 0);
  },
  strip: (data) => data,
};

/**
 * Prolific PL2303 (Ablauf wie im Linux-Treiber pl2303.c).
 * Ältere Typen (HX/TA/TB) brauchen beim Start eine Folge von Herstellerbefehlen;
 * die neuere HXN-Familie (PID 0x23a3 … 0x23f3) nutzt andere Register.
 */
const PL2303 = {
  name: 'PL2303',
  isHxn: (dev) => dev.productId >= 0x23a3 && dev.productId <= 0x23f3 && (dev.productId & 0x0f) === 0x03,

  async vendorRead(p, value) {
    const request = this.hxn ? 0x81 : 0x01;
    const r = await p.device.controlTransferIn({ requestType: 'vendor', recipient: 'device', request, value, index: 0 }, 1);
    return r.data?.byteLength ? r.data.getUint8(0) : 0;
  },
  async vendorWrite(p, value, index) {
    const request = this.hxn ? 0x80 : 0x01;
    await p.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request, value, index });
  },

  async setup(p, opts) {
    this.hxn = this.isHxn(p.device);
    if (!this.hxn) {
      // Startsequenz der älteren Typen
      await this.vendorRead(p, 0x8484);
      await this.vendorWrite(p, 0x0404, 0);
      await this.vendorRead(p, 0x8484);
      await this.vendorRead(p, 0x8383);
      await this.vendorRead(p, 0x8484);
      await this.vendorWrite(p, 0x0404, 1);
      await this.vendorRead(p, 0x8484);
      await this.vendorRead(p, 0x8383);
      await this.vendorWrite(p, 0, 1);
      await this.vendorWrite(p, 1, 0);
      await this.vendorWrite(p, 2, 0x44);
      // Datenkanäle zurücksetzen
      await this.vendorWrite(p, 8, 0);
      await this.vendorWrite(p, 9, 0);
    } else {
      await this.vendorWrite(p, 0x07, 0x03); // HXN: Reset Up- und Downstream
    }
    await p._classOut(SET_LINE_CODING, 0, lineCoding(opts));
    await p._classOut(SET_CONTROL_LINE_STATE, 0x03); // DTR + RTS
    // keine Flusssteuerung
    if (!this.hxn) {
      await this.vendorWrite(p, 0, 0);
    } else {
      const reg = await this.vendorRead(p, 0x0a);
      await this.vendorWrite(p, 0x0a, (reg & ~0x1c) | 0x1c);
    }
  },
  async teardown(p) {
    await p._classOut(SET_CONTROL_LINE_STATE, 0);
  },
  strip: (data) => data, // PL2303 liefert reine Nutzdaten
};

/**
 * FTDI FT232/FT-X/FT2232 (Ablauf wie im Linux-Treiber ftdi_sio.c).
 * Jedes Bulk-IN-Paket beginnt mit zwei Statusbytes, die entfernt werden.
 */
const FTDI = {
  name: 'FTDI',

  /** Baudraten-Teiler für FT232BM/R/H (Basistakt 48 MHz, Achtelschritte); 9600 Baud -> 0x4138. */
  divisor(baud) {
    const divfrac = [0, 3, 2, 4, 1, 5, 6, 7];
    const div3 = Math.round(48_000_000 / (2 * baud));
    let d = (div3 >> 3) | (divfrac[div3 & 7] << 14);
    if (d === 1) d = 0;
    else if (d === 0x4001) d = 1;
    return d;
  },

  async ctrl(p, request, value, index = p._ftdiPort) {
    await p.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request, value, index });
  },

  async setup(p, opts) {
    p._ftdiPort = p._dataIface + 1; // Kanal A = 1, B = 2, …
    const multi = p.device.configuration.interfaces.length > 1;
    await this.ctrl(p, 0x00, 0); // Reset
    const d = this.divisor(opts.baudRate);
    // Teiler: unteres Wort im value, Bit 16 im index (bei Mehrkanal-Chips im oberen Byte, Kanal im unteren)
    const index = multi ? ((d >> 8) & 0xff00) | p._ftdiPort : (d >> 16) & 0xffff;
    await this.ctrl(p, 0x03, d & 0xffff, index);
    const parity = { none: 0, odd: 1, even: 2 }[opts.parity] ?? 0;
    await this.ctrl(p, 0x04, opts.dataBits | (parity << 8) | ((opts.stopBits === 2 ? 2 : 0) << 11)); // Datenformat
    await this.ctrl(p, 0x02, 0);      // keine Flusssteuerung
    await this.ctrl(p, 0x01, 0x0303); // DTR + RTS setzen
    await this.ctrl(p, 0x09, 4);      // Latenz 4 ms (schnelle Antworten)
  },
  async teardown(p) {
    await this.ctrl(p, 0x01, 0x0300); // DTR + RTS zurücknehmen
  },
  /** Zwei Statusbytes am Anfang jedes Pakets entfernen. */
  strip(data, packet) {
    if (data.length <= 2) return new Uint8Array(0);
    const parts = [];
    for (let i = 0; i < data.length; i += packet) parts.push(data.subarray(i + 2, Math.min(i + packet, data.length)));
    const res = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
    let o = 0;
    for (const x of parts) { res.set(x, o); o += x.length; }
    return res;
  },
};

function chipFor(device) {
  if (device.vendorId === VID_PROLIFIC) return Object.create(PL2303);
  if (device.vendorId === VID_FTDI) return Object.create(FTDI);
  return Object.create(CDC);
}

export class UsbSerialPort {
  constructor(device) {
    this.device = device;
    this.chip = chipFor(device);
    this.readable = null;
    this.writable = null;
    this._closed = true;
    this._onUsbDisconnect = (e) => {
      if (e.device === this.device) this._fail(new Error('USB-Gerät getrennt'));
    };
  }

  static supported() {
    return 'usb' in navigator;
  }

  /** Geräteauswahl des Browsers öffnen. */
  static async request() {
    return new UsbSerialPort(await navigator.usb.requestDevice({ filters: USB_FILTERS }));
  }

  async open({ baudRate = 115200, dataBits = 8, stopBits = 1, parity = 'none' } = {}) {
    const dev = this.device;
    await dev.open();
    if (!dev.configuration) await dev.selectConfiguration(1);

    // Daten-Interface (Bulk IN/OUT) und ggf. Steuer-Interface (CDC) suchen
    let data = null, comm = null;
    for (const iface of dev.configuration.interfaces) {
      const alt = iface.alternates[0];
      const bulkIn = alt.endpoints.find((e) => e.type === 'bulk' && e.direction === 'in');
      const bulkOut = alt.endpoints.find((e) => e.type === 'bulk' && e.direction === 'out');
      if (!data && bulkIn && bulkOut && (alt.interfaceClass === CLASS_DATA || alt.interfaceClass === CLASS_VENDOR)) {
        data = { iface, bulkIn, bulkOut };
      }
      if (!comm && alt.interfaceClass === CLASS_COMM) comm = iface;
    }
    if (!data) {
      await dev.close().catch(() => {});
      throw new Error('Kein serielles Daten-Interface am USB-Gerät gefunden.');
    }

    try {
      await dev.claimInterface(data.iface.interfaceNumber);
    } catch (e) {
      await dev.close().catch(() => {});
      throw new Error(`USB-Interface belegt (${e.message}). Unter Windows/Linux hält der COM-Port-Treiber das Gerät – dort „Seriell“ verwenden.`);
    }
    if (comm) {
      try { await dev.claimInterface(comm.interfaceNumber); } catch {}
    }
    this._dataIface = data.iface.interfaceNumber;
    this._commIface = comm ? comm.interfaceNumber : data.iface.interfaceNumber;
    this._epIn = data.bulkIn.endpointNumber;
    this._epOut = data.bulkOut.endpointNumber;
    this._packet = data.bulkIn.packetSize || 64;

    try {
      await this.chip.setup(this, { baudRate, dataBits, stopBits, parity });
    } catch (e) {
      await dev.close().catch(() => {});
      throw new Error(`${this.chip.name}: Einrichten fehlgeschlagen (${e.message})`);
    }
    await sleep(20);

    this._closed = false;
    navigator.usb.addEventListener('disconnect', this._onUsbDisconnect);

    this.readable = new ReadableStream({
      start: (ctrl) => { this._readCtrl = ctrl; },
      pull: async (ctrl) => {
        while (!this._closed) {
          let r;
          try {
            r = await dev.transferIn(this._epIn, this._packet * 8);
          } catch (e) {
            if (this._closed) return;
            throw e;
          }
          if (r.status === 'stall') {
            await dev.clearHalt('in', this._epIn).catch(() => {});
            continue;
          }
          if (r.data && r.data.byteLength) {
            const raw = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
            const bytes = this.chip.strip(raw, this._packet);
            if (bytes.length) {
              ctrl.enqueue(bytes.slice());
              return;
            }
          }
        }
        try { ctrl.close(); } catch {}
      },
      cancel: () => { this._closed = true; },
    }, { highWaterMark: 0 });

    this.writable = new WritableStream({
      write: async (chunk) => {
        if (this._closed) throw new Error('Port geschlossen');
        const r = await dev.transferOut(this._epOut, chunk);
        if (r.status === 'stall') {
          await dev.clearHalt('out', this._epOut).catch(() => {});
          throw new Error('USB-Schreibfehler (stall)');
        }
      },
    });
  }

  /** Klassen-Anfrage an das Interface (CDC-Line-Coding, auch vom PL2303 verstanden). */
  async _classOut(request, value, data) {
    try {
      await this.device.controlTransferOut(
        { requestType: 'class', recipient: 'interface', request, value, index: this._commIface }, data);
    } catch {
      // manche Geräte unterstützen die Anfrage nicht – unkritisch
    }
  }

  _fail(err) {
    if (this._closed) return;
    this._closed = true;
    try { this._readCtrl?.error(err); } catch {}
    navigator.usb.removeEventListener('disconnect', this._onUsbDisconnect);
  }

  async close() {
    this._closed = true;
    navigator.usb.removeEventListener('disconnect', this._onUsbDisconnect);
    const dev = this.device;
    if (!dev.opened) return;
    try { await this.chip.teardown(this); } catch {}
    try { await dev.releaseInterface(this._dataIface); } catch {}
    try { await dev.close(); } catch {}
  }
}
