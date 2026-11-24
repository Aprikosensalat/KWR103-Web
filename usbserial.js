// Serielle Verbindung über WebUSB für USB-CDC-ACM-Geräte (virtueller COM-Port).
// Gedacht für Chrome unter Android: Dort unterstützt die Web Serial API nur Bluetooth,
// USB-Geräte sind aber über WebUSB erreichbar. KEL103 und KWR103 melden sich als
// CDC-ACM (VID 0x0416, PID 0x5011).
// Die Klasse bildet die Teile der Web-Serial-Schnittstelle nach, die die Gerätetreiber nutzen:
// open({ baudRate }), readable, writable, close().
// Gemeinsam genutzt von KEL103-Web und KWR103-Web (Datei identisch halten).

const CLASS_COMM = 0x02;
const CLASS_DATA = 0x0a;
const SET_LINE_CODING = 0x20;
const SET_CONTROL_LINE_STATE = 0x22;

export const USB_FILTERS = [
  { vendorId: 0x0416, productId: 0x5011 }, // KORAD KEL103 / KWR103
  { classCode: CLASS_COMM },               // andere CDC-Geräte
];

export class UsbSerialPort {
  constructor(device) {
    this.device = device;
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

    // Daten-Interface (Bulk IN/OUT) und Steuer-Interface (CDC) suchen
    let data = null, comm = null;
    for (const iface of dev.configuration.interfaces) {
      const alt = iface.alternates[0];
      const bulkIn = alt.endpoints.find((e) => e.type === 'bulk' && e.direction === 'in');
      const bulkOut = alt.endpoints.find((e) => e.type === 'bulk' && e.direction === 'out');
      if (!data && bulkIn && bulkOut && (alt.interfaceClass === CLASS_DATA || alt.interfaceClass === 0xff)) {
        data = { iface, alt, bulkIn, bulkOut };
      }
      if (!comm && alt.interfaceClass === CLASS_COMM) comm = iface;
    }
    if (!data) {
      await dev.close().catch(() => {});
      throw new Error('Kein serielles Daten-Interface (CDC) am USB-Gerät gefunden.');
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

    // Schnittstellenparameter setzen (virtuelle COM-Ports ignorieren die Baudrate meist)
    const lc = new DataView(new ArrayBuffer(7));
    lc.setUint32(0, baudRate, true);
    lc.setUint8(4, stopBits === 2 ? 2 : 0);
    lc.setUint8(5, { none: 0, odd: 1, even: 2 }[parity] ?? 0);
    lc.setUint8(6, dataBits);
    await this._control(SET_LINE_CODING, 0, lc.buffer);
    await this._control(SET_CONTROL_LINE_STATE, 0x03, undefined); // DTR + RTS

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
            ctrl.enqueue(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength).slice());
            return;
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

  async _control(request, value, data) {
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
    try { await this._control(SET_CONTROL_LINE_STATE, 0, undefined); } catch {}
    try { await dev.releaseInterface(this._dataIface); } catch {}
    try { await dev.close(); } catch {}
  }
}
