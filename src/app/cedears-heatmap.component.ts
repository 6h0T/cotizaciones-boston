import { Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

import { dropUsdVariants } from './market.config';

/**
 * Mapa de calor de CEDEARs (treemap estilo finviz): área = volumen operado,
 * color = variación % diaria en una escala DIVERGENTE binned (rojo → gris
 * neutro → verde) derivada de los tokens semánticos de la app y validada:
 * luminancia monótona por brazo y contraste de texto ≥ 5:1 en todos los bins
 * (los bins pálidos quedan por debajo de 3:1 contra la superficie a propósito
 * — el canal de lectura es el label directo en la celda y la tabla CEDEARs
 * del mosaico, no el color).
 */

const MAX_CELLS = 40;
// Lienzo nominal para el squarify (solo define proporciones; se proyecta a %).
const W = 1000;
const H = 430;

// Umbrales de % diario y color por bin: ≤-3, -3..-1, -1..-0,25, ±0,25,
// +0,25..+1, +1..+3, ≥+3.
const BIN_EDGES = [-3, -1, -0.25, 0.25, 1, 3];
const BIN_BG = ['#be1f1f', '#d96f6f', '#edb5b5', '#dedcd7', '#a8dabb', '#58b183', '#15803d'];
const BIN_FG = ['#ffffff', '#1a1a1d', '#1a1a1d', '#1a1a1d', '#1a1a1d', '#1a1a1d', '#ffffff'];
const BIN_LABELS = ['≤ −3', '−3…−1', '−1…−0,25', '±0,25', '+0,25…+1', '+1…+3', '≥ +3'];

function binFor(pct: number): number {
  let i = 0;
  while (i < BIN_EDGES.length && pct > BIN_EDGES[i]) i++;
  return i;
}

interface Rect { x: number; y: number; w: number; h: number; }

// Treemap squarified clásico: tiras a lo largo del lado corto del rectángulo
// libre, eligiendo cuántos ítems entran en cada tira para minimizar el peor
// aspect ratio. Espera áreas ordenadas de mayor a menor.
function squarify(areas: number[], x0: number, y0: number, w0: number, h0: number): Rect[] {
  const out: Rect[] = [];
  let x = x0, y = y0, w = w0, h = h0, i = 0;
  while (i < areas.length) {
    const column = w >= h; // columna vertical si el ancho libre domina
    const side = column ? h : w;
    let best = Infinity;
    let count = 1;
    let chosenSum = areas[i];
    let sum = 0;
    for (let j = i; j < areas.length; j++) {
      sum += areas[j];
      const thk = sum / side;
      let worst = 0;
      for (let k = i; k <= j; k++) {
        const len = areas[k] / thk;
        worst = Math.max(worst, len / thk, thk / len);
      }
      if (worst <= best) { best = worst; count = j - i + 1; chosenSum = sum; }
      else break;
    }
    const thk = chosenSum / side;
    let off = 0;
    for (let k = i; k < i + count; k++) {
      const len = areas[k] / thk;
      out.push(column ? { x, y: y + off, w: thk, h: len } : { x: x + off, y, w: len, h: thk });
      off += len;
    }
    if (column) { x += thk; w -= thk; } else { y += thk; h -= thk; }
    i += count;
  }
  return out;
}

interface HeatCell {
  symbol: string;
  last: number;
  pct: number;
  vol: number;
  // posición/tamaño en % del contenedor
  x: number; y: number; w: number; h: number;
  bg: string;
  fg: string;
  fsSym: number;   // font-size del ticker, escalado al área de la celda
  showSym: boolean;
  showPct: boolean;
}

@Component({
  selector: 'app-cedears-heatmap',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (cells().length) {
      <div class="map" (mousemove)="onMove($event)" (mouseleave)="hovered.set(null)">
        @for (c of cells(); track c.symbol) {
          <div
            class="cell"
            [style.left.%]="c.x" [style.top.%]="c.y"
            [style.width.%]="c.w" [style.height.%]="c.h"
            [style.background]="c.bg" [style.color]="c.fg"
            [class.hover]="hovered()?.symbol === c.symbol"
            (mouseenter)="hovered.set(c)"
          >
            @if (c.showSym) {
              <span class="sym" [style.font-size.px]="c.fsSym">{{ c.symbol }}</span>
              @if (c.showPct) {
                <span class="pct num" [style.font-size.px]="c.fsSym - 2">{{ fmtPct(c.pct) }}</span>
              }
            }
          </div>
        }

        @if (hovered(); as hc) {
          <div class="tip" [style.left.px]="tipX()" [style.top.px]="tipY()">
            <b>{{ hc.symbol }}</b>
            <span class="num">Último {{ fmt(hc.last) }}</span>
            <span class="num" [style.color]="hc.pct >= 0 ? 'var(--pos)' : 'var(--neg)'">{{ fmtPct(hc.pct) }} hoy</span>
            <span class="num vol">Vol. {{ fmtVol(hc.vol) }}</span>
          </div>
        }
      </div>

      <div class="legend">
        <span class="cap">% Día</span>
        @for (l of legend; track l.label) {
          <span class="key"><i [style.background]="l.bg"></i>{{ l.label }}</span>
        }
        <span class="cap area">área = volumen</span>
      </div>
    } @else {
      <div class="empty">Sin datos.</div>
    }
  `,
  styles: [`
    :host { display: block; }
    .map {
      position: relative;
      height: 430px;
      overflow: hidden;
      background: var(--surface);
    }
    .cell {
      position: absolute;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 1px;
      /* 1px por celda = 2px de separación efectiva entre rellenos vecinos */
      border: 1px solid var(--surface);
      border-radius: 3px;
      overflow: hidden;
      cursor: default;
    }
    .cell.hover { filter: brightness(1.06); box-shadow: inset 0 0 0 2px rgba(26,26,29,.35); }
    .sym { font-family: var(--font-ui); font-weight: 700; line-height: 1.05; letter-spacing: .01em; }
    .pct { line-height: 1.05; }
    .num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

    .tip {
      position: absolute; z-index: 3;
      display: flex; flex-direction: column; gap: 2px;
      padding: 8px 10px;
      background: var(--ink); color: #fdfdfc;
      border-radius: var(--r-sm);
      font-size: 11.5px; line-height: 1.25;
      pointer-events: none;
      box-shadow: var(--shadow);
      white-space: nowrap;
    }
    .tip b { font-family: var(--font-display); font-size: 12.5px; }
    .tip .vol { color: #b9b9bf; }

    .legend {
      display: flex; align-items: center; flex-wrap: wrap; gap: 10px;
      padding: 8px 14px;
      border-top: 1px solid var(--line);
      font-size: 10.5px; color: var(--ink-3);
    }
    .legend .cap { font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
    .legend .area { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 500; }
    .legend .key { display: inline-flex; align-items: center; gap: 4px; font-family: var(--font-mono); }
    .legend .key i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }

    .empty { text-align: center; color: var(--ink-3); font-size: 12.5px; padding: 24px; }
  `],
})
export class CedearsHeatmapComponent {
  rows = input.required<any[]>();

  hovered = signal<HeatCell | null>(null);
  private mouse = signal<{ x: number; y: number; maxX: number; maxY: number }>({ x: 0, y: 0, maxX: W, maxY: H });

  legend = BIN_BG.map((bg, i) => ({ bg, label: BIN_LABELS[i] }));

  cells = computed<HeatCell[]>(() => {
    const all = dropUsdVariants(this.rows() ?? []);
    const withVol = all
      .filter((r) => +r?.v > 0)
      .sort((a, b) => (+b?.v || 0) - (+a?.v || 0));
    // Fuera de rueda no hay volumen: celdas iguales con los primeros N.
    const top = (withVol.length ? withVol : all).slice(0, MAX_CELLS);
    if (!top.length) return [];

    const weights = withVol.length ? top.map((r) => +r.v) : top.map(() => 1);
    const total = weights.reduce((a, b) => a + b, 0);
    const areas = weights.map((v) => (v / total) * W * H);
    const rects = squarify(areas, 0, 0, W, H);

    return top.map((r, i) => {
      const rc = rects[i];
      const pct = +r?.pct_change || 0;
      const bin = binFor(pct);
      const px = +r?.px_bid;
      const last = px > 0 ? px : (+r?.last > 0 ? +r.last : (+r?.c || 0));
      const fsSym = Math.max(9, Math.min(16, Math.sqrt(rc.w * rc.h) / 5.5));
      return {
        symbol: String(r?.symbol ?? ''),
        last,
        pct,
        vol: +r?.v || 0,
        x: (rc.x / W) * 100, y: (rc.y / H) * 100,
        w: (rc.w / W) * 100, h: (rc.h / H) * 100,
        bg: BIN_BG[bin],
        fg: BIN_FG[bin],
        fsSym,
        showSym: rc.w > 34 && rc.h > 16,
        showPct: rc.w > 34 && rc.h > 34,
      };
    });
  });

  // Tooltip pegado al cursor, clampeado para no salirse del mapa.
  tipX = computed(() => Math.min(this.mouse().x + 14, this.mouse().maxX - 170));
  tipY = computed(() => Math.min(this.mouse().y + 14, this.mouse().maxY - 92));

  onMove(e: MouseEvent) {
    const el = e.currentTarget as HTMLElement;
    const b = el.getBoundingClientRect();
    this.mouse.set({ x: e.clientX - b.left, y: e.clientY - b.top, maxX: b.width, maxY: b.height });
  }

  fmt(v: number): string {
    if (!isFinite(v)) return '–';
    return v.toLocaleString('es-AR', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  }

  fmtPct(v: number): string {
    const s = v > 0 ? '+' : '';
    return `${s}${v.toLocaleString('es-AR', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}%`;
  }

  fmtVol(v: number): string {
    if (v >= 1e9) return `${(v / 1e9).toLocaleString('es-AR', { maximumFractionDigits: 1 })} MM M`;
    if (v >= 1e6) return `${(v / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 })} M`;
    return v.toLocaleString('es-AR', { maximumFractionDigits: 0 });
  }
}
