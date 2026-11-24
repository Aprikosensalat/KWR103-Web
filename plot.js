// Kleine, abhängigkeitsfreie Diagramme auf <canvas>:
//  - TimePlot: übereinanderliegende Zeitverläufe mit gemeinsamer Zeitachse und Fadenkreuz
//  - drawXY:   Punkte + Ausgleichsgerade (für die Innenwiderstandsmessung)

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function niceStep(range, count) {
  const raw = range / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

export function decimals(step) {
  return Math.max(0, Math.min(4, -Math.floor(Math.log10(step) + 1e-9)));
}

export function lowerBound(data, t) {
  let lo = 0, hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (data[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function prepareCanvas(canvas, height) {
  const dpr = window.devicePixelRatio || 1;
  canvas.style.height = height + 'px';
  const w = canvas.clientWidth;
  const pw = Math.round(w * dpr), ph = Math.round(height * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, height);
  ctx.font = '11px system-ui, sans-serif';
  return { ctx, w };
}

const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600].map((s) => s * 1000);
const GAP_MS = 15_000; // längere Lücken werden nicht verbunden

export class TimePlot {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{key:string,label:string,unit:string,color:string,digits:number,visible:boolean}[]} panels
   */
  constructor(canvas, panels) {
    this.canvas = canvas;
    this.panels = panels;
    this.data = [];
    this.windowMs = 5 * 60_000; // 0 = alles
    this.panelHeight = 140;
    this.hoverX = null;
    this._raf = 0;
    canvas.addEventListener('mousemove', (e) => {
      this.hoverX = e.clientX - canvas.getBoundingClientRect().left;
      this.requestDraw();
    });
    canvas.addEventListener('mouseleave', () => {
      this.hoverX = null;
      this.requestDraw();
    });
    new ResizeObserver(() => this.requestDraw()).observe(canvas);
  }

  setData(data) {
    this.data = data;
    this.requestDraw();
  }

  requestDraw() {
    if (!this._raf) {
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this.draw();
      });
    }
  }

  draw() {
    const visible = this.panels.filter((p) => p.visible);
    const axisH = 24;
    const height = Math.max(1, visible.length) * this.panelHeight + axisH;
    const { ctx, w } = prepareCanvas(this.canvas, height);
    const left = 60, right = 14;
    const pw = w - left - right;
    const grid = cssVar('--border'), text = cssVar('--muted'), fg = cssVar('--fg');
    const data = this.data;

    if (data.length < 1 || !visible.length || pw <= 0) {
      ctx.fillStyle = text;
      ctx.fillText(visible.length ? 'Noch keine Messwerte' : 'Keine Messgröße ausgewählt', left, 30);
      return;
    }

    const t1 = data[data.length - 1].t;
    let t0 = this.windowMs ? t1 - this.windowMs : data[0].t;
    if (t1 - t0 < 1000) t0 = t1 - 1000;
    const first = lowerBound(data, t0);
    const start = Math.max(0, first - 1);
    const end = data.length;
    const xOf = (t) => left + ((t - t0) / (t1 - t0)) * pw;

    // Fadenkreuz: nächster Messpunkt
    let hoverIdx = -1;
    if (this.hoverX !== null && this.hoverX >= left && this.hoverX <= left + pw) {
      const t = t0 + ((this.hoverX - left) / pw) * (t1 - t0);
      let i = lowerBound(data, t);
      if (i >= end || (i > first && t - data[i - 1].t < data[i].t - t)) i--;
      hoverIdx = Math.max(first, Math.min(end - 1, i));
    }

    visible.forEach((p, k) => {
      const top = k * this.panelHeight + 10;
      const bottom = (k + 1) * this.panelHeight - 6;
      const ph = bottom - top;
      const color = cssVar(p.color);

      let min = Infinity, max = -Infinity;
      for (let i = first; i < end; i++) {
        const v = data[i][p.key];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min === Infinity) return;
      const span = max - min;
      const pad = span < 1e-9 ? Math.max(Math.abs(max) * 0.05, 0.01) : span * 0.08;
      min -= pad;
      max += pad;
      const yOf = (v) => bottom - ((v - min) / (max - min)) * ph;

      // Gitter + Achsbeschriftung
      const step = niceStep(max - min, 4);
      const dec = decimals(step);
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.fillStyle = text;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
        const y = Math.round(yOf(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + pw, y);
        ctx.stroke();
        ctx.fillText(v.toFixed(dec), left - 6, y);
      }
      ctx.strokeRect(left + 0.5, top + 0.5, pw - 1, ph - 1);

      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      // Kurve
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, pw, ph);
      ctx.clip();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      if (end - start <= pw * 2) {
        let prevT = null;
        for (let i = start; i < end; i++) {
          const d = data[i];
          const x = xOf(d.t), y = yOf(d[p.key]);
          if (prevT === null || d.t - prevT > GAP_MS) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          prevT = d.t;
        }
        if (end - start === 1) ctx.arc(xOf(data[start].t), yOf(data[start][p.key]), 2, 0, 2 * Math.PI);
      } else {
        // viele Punkte: pro Pixelspalte Min/Max zeichnen
        let col = null, mn = 0, mx = 0, started = false;
        const flush = () => {
          const x = left + col + 0.5;
          if (!started) { ctx.moveTo(x, yOf(mn)); started = true; } else ctx.lineTo(x, yOf(mn));
          ctx.lineTo(x, yOf(mx));
        };
        for (let i = start; i < end; i++) {
          const v = data[i][p.key];
          const c = Math.floor(xOf(data[i].t) - left);
          if (c !== col) {
            if (col !== null) flush();
            col = c; mn = mx = v;
          } else {
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
        }
        if (col !== null) flush();
      }
      ctx.stroke();

      if (hoverIdx >= 0) {
        const d = data[hoverIdx];
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(xOf(d.t), yOf(d[p.key]), 3.5, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.restore();

      // Beschriftung (mit Hintergrund, damit sie über der Kurve lesbar bleibt)
      const tag = (txt, x, align, fill) => {
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.textAlign = align;
        ctx.textBaseline = 'top';
        const tw = ctx.measureText(txt).width;
        const bx = align === 'right' ? x - tw - 4 : x - 4;
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = cssVar('--card');
        ctx.fillRect(bx, top + 3, tw + 8, 18);
        ctx.globalAlpha = 1;
        ctx.fillStyle = fill;
        ctx.fillText(txt, x, top + 6);
        ctx.font = '11px system-ui, sans-serif';
      };
      tag(`${p.label} [${p.unit}]`, left + 8, 'left', color);
      if (hoverIdx >= 0) {
        tag(`${data[hoverIdx][p.key].toFixed(p.digits)} ${p.unit}`, left + pw - 8, 'right', fg);
      }
    });

    // Zeitachse
    const axisTop = visible.length * this.panelHeight;
    const tStep = TIME_STEPS.find((s) => (t1 - t0) / s <= pw / 85) ?? TIME_STEPS[TIME_STEPS.length - 1];
    const fmt = tStep >= 60_000 ? { hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit', second: '2-digit' };
    ctx.fillStyle = text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.strokeStyle = grid;
    for (let t = Math.ceil(t0 / tStep) * tStep; t <= t1; t += tStep) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 10);
      ctx.lineTo(x, axisTop - 6);
      ctx.stroke();
      ctx.fillText(new Date(t).toLocaleTimeString('de-DE', fmt), x, axisTop + 4);
    }

    if (hoverIdx >= 0) {
      const x = Math.round(xOf(data[hoverIdx].t)) + 0.5;
      ctx.strokeStyle = text;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 10);
      ctx.lineTo(x, axisTop - 6);
      ctx.stroke();
      ctx.setLineDash([]);
      const label = new Date(data[hoverIdx].t).toLocaleTimeString('de-DE');
      const tw = ctx.measureText(label).width + 10;
      const lx = Math.min(Math.max(x, left + tw / 2), left + pw - tw / 2);
      ctx.fillStyle = cssVar('--card');
      ctx.fillRect(lx - tw / 2, axisTop + 1, tw, 18);
      ctx.fillStyle = fg;
      ctx.textAlign = 'center';
      ctx.fillText(label, lx, axisTop + 4);
    }
  }
}

/** Streudiagramm U über I mit Ausgleichsgerade. */
export function drawXY(canvas, points, fit, { height = 220 } = {}) {
  const { ctx, w } = prepareCanvas(canvas, height);
  const left = 56, right = 14, top = 12, bottom = height - 34;
  const pw = w - left - right, ph = bottom - top;
  const grid = cssVar('--border'), text = cssVar('--muted');
  if (points.length < 1 || pw <= 0) return;

  const maxI = Math.max(...points.map((p) => p.i), 0.1) * 1.08;
  let minV = Math.min(...points.map((p) => p.v)), maxV = Math.max(...points.map((p) => p.v));
  const pad = Math.max((maxV - minV) * 0.12, 0.005);
  minV -= pad;
  maxV += pad;
  const xOf = (i) => left + (i / maxI) * pw;
  const yOf = (v) => bottom - ((v - minV) / (maxV - minV)) * ph;

  ctx.strokeStyle = grid;
  ctx.fillStyle = text;
  ctx.lineWidth = 1;
  const vs = niceStep(maxV - minV, 4), vd = decimals(vs);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = Math.ceil(minV / vs) * vs; v <= maxV; v += vs) {
    const y = Math.round(yOf(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + pw, y); ctx.stroke();
    ctx.fillText(v.toFixed(vd), left - 6, y);
  }
  const is = niceStep(maxI, 5), id = decimals(is);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= maxI; i += is) {
    const x = Math.round(xOf(i)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.fillText(i.toFixed(id), x, bottom + 4);
  }
  ctx.strokeRect(left + 0.5, top + 0.5, pw - 1, ph - 1);
  ctx.fillText('Strom [A]', left + pw / 2, bottom + 18);
  ctx.save();
  ctx.translate(12, top + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Spannung [V]', 0, -6);
  ctx.restore();

  if (fit) {
    ctx.strokeStyle = cssVar('--c-curr');
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(fit.v0));
    ctx.lineTo(xOf(maxI), yOf(fit.v0 - fit.r * maxI));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.fillStyle = cssVar('--c-volt');
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(xOf(p.i), yOf(p.v), 4, 0, 2 * Math.PI);
    ctx.fill();
  }
}
