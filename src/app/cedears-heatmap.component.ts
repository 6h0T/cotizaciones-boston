import { Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

import { cedearMeta } from './cedears-meta';

/**
 * Mapa de calor de CEDEARs (treemap anidado estilo finviz): contenedores por
 * SECTOR (con barra de título), celdas con área = CAPITALIZACIÓN BURSÁTIL
 * aproximada (ver cedears-meta.ts) y color = variación % diaria en una escala
 * DIVERGENTE binned (rojo → gris neutro → verde) derivada de los tokens
 * semánticos de la app y validada: luminancia monótona por brazo y contraste
 * de texto ≥ 5:1 en todos los bins (los bins pálidos quedan por debajo de 3:1
 * contra la superficie a propósito — el canal de lectura es el label directo
 * en la celda y la tabla CEDEARs, no el color).
 *
 * Dos modos: compacto (card del mosaico, top N por cap) y `full` (vista
 * "Ver todo": todos los CEDEARs mapeados, lienzo grande).
 */

const COMPACT_MAX = 55;
// Lienzos nominales para el squarify (solo definen proporciones; se proyecta
// a % del contenedor real).
const COMPACT_W = 1000, COMPACT_H = 430;
const FULL_W = 1400, FULL_H = 780;
const SECTOR_HEAD = 15; // alto de la barra de título del sector (px nominales)

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
  sector: string;
  capBn: number;
  last: number;
  pct: number;
  vol: number;
  // posición/tamaño en % del área INTERNA del sector
  x: number; y: number; w: number; h: number;
  bg: string;
  fg: string;
  fsSym: number;
  showSym: boolean;
  showPct: boolean;
}

interface HeatSector {
  name: string;
  // posición/tamaño en % del lienzo del mapa
  x: number; y: number; w: number; h: number;
  headPct: number; // alto de la barra de título en % del alto del sector
  cells: HeatCell[];
}

@Component({
  selector: 'app-cedears-heatmap',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (sectors().length) {
      <div class="map" (mousemove)="onMove($event)" (mouseleave)="hovered.set(null)">
        @for (s of sectors(); track s.name) {
          <div
            class="sector"
            [style.left.%]="s.x" [style.top.%]="s.y"
            [style.width.%]="s.w" [style.height.%]="s.h"
          >
            <div class="sector-head" [style.height.%]="s.headPct"><span>{{ s.name }}</span></div>
            <div class="sector-body">
              @for (c of s.cells; track c.symbol) {
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
            </div>
          </div>
        }

        @if (hovered(); as hc) {
          <div class="tip" [style.left.px]="tipX()" [style.top.px]="tipY()">
            <b>{{ hc.symbol }}</b>
            <span class="sec">{{ hc.sector }} · cap. {{ fmtCap(hc.capBn) }}</span>
            <span class="num">Último {{ fmt(hc.last) }}</span>
            <span class="num" [style.color]="hc.pct >= 0 ? '#7ee2a5' : '#f1a3a3'">{{ fmtPct(hc.pct) }} hoy</span>
            <span class="num vol">Vol. {{ fmtVol(hc.vol) }}</span>
          </div>
        }
      </div>

      <div class="legend">
        <span class="cap">% Día</span>
        @for (l of legend; track l.label) {
          <span class="key"><i [style.background]="l.bg"></i>{{ l.label }}</span>
        }
        <span class="cap area">área = capitalización bursátil · agrupado por sector</span>
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
      background: var(--surface-3);
    }
    :host(.full) .map { height: max(600px, calc(100vh - 230px)); }

    .sector {
      position: absolute;
      display: flex; flex-direction: column;
      /* 1px por sector = 2px de separación efectiva entre sectores */
      border: 1px solid var(--surface-3);
      overflow: hidden;
    }
    .sector-head {
      flex-shrink: 0;
      display: flex; align-items: center;
      min-height: 12px;
      padding: 0 5px;
      background: var(--ink-2);
      overflow: hidden;
    }
    .sector-head span {
      color: #f3f2f0;
      font-size: 8.5px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .07em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sector-body { position: relative; flex: 1; min-height: 0; }

    .cell {
      position: absolute;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 1px;
      border: 1px solid var(--surface-3);
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
    .tip .sec { color: #b9b9bf; font-size: 10.5px; }
    .tip .vol { color: #b9b9bf; }

    .legend {
      display: flex; align-items: center; flex-wrap: wrap; gap: 10px;
      padding: 8px 14px;
      border-top: 1px solid var(--line);
      background: var(--surface);
      font-size: 10.5px; color: var(--ink-3);
    }
    .legend .cap { font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
    .legend .area { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 500; }
    .legend .key { display: inline-flex; align-items: center; gap: 4px; font-family: var(--font-mono); }
    .legend .key i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }

    .empty { text-align: center; color: var(--ink-3); font-size: 12.5px; padding: 24px; }
  `],
  host: { '[class.full]': 'full()' },
})
export class CedearsHeatmapComponent {
  rows = input.required<any[]>();
  full = input<boolean>(false);

  hovered = signal<HeatCell | null>(null);
  private mouse = signal<{ x: number; y: number; maxX: number; maxY: number }>({ x: 0, y: 0, maxX: 1000, maxY: 430 });

  legend = BIN_BG.map((bg, i) => ({ bg, label: BIN_LABELS[i] }));

  sectors = computed<HeatSector[]>(() => {
    const W = this.full() ? FULL_W : COMPACT_W;
    const H = this.full() ? FULL_H : COMPACT_H;

    // Solo entran los tickers con sector/cap mapeados (excluye variantes USD
    // comprimidas y duplicados B3/ADR — ver cedears-meta.ts).
    let items = (this.rows() ?? [])
      .map((r) => ({ r, meta: cedearMeta(String(r?.symbol ?? '')) }))
      .filter((x): x is { r: any; meta: NonNullable<ReturnType<typeof cedearMeta>> } => !!x.meta)
      .sort((a, b) => b.meta.capBn - a.meta.capBn);
    if (!this.full()) items = items.slice(0, COMPACT_MAX);
    if (!items.length) return [];

    // Agrupar por sector, ordenados por cap total descendente.
    const bySector = new Map<string, typeof items>();
    for (const it of items) {
      const arr = bySector.get(it.meta.sector);
      if (arr) arr.push(it); else bySector.set(it.meta.sector, [it]);
    }
    const groups = [...bySector.entries()]
      .map(([name, list]) => ({ name, list, cap: list.reduce((a, x) => a + x.meta.capBn, 0) }))
      .sort((a, b) => b.cap - a.cap);

    // Nivel 1: treemap de sectores (peso = cap total del sector).
    const totalCap = groups.reduce((a, g) => a + g.cap, 0);
    const sectorRects = squarify(groups.map((g) => (g.cap / totalCap) * W * H), 0, 0, W, H);

    return groups.map((g, gi) => {
      const sr = sectorRects[gi];
      // Nivel 2: treemap de empresas dentro del área útil del sector (debajo
      // de la barra de título).
      const innerH = Math.max(sr.h - SECTOR_HEAD, 4);
      const capSum = g.cap;
      const cellRects = squarify(g.list.map((x) => (x.meta.capBn / capSum) * sr.w * innerH), 0, 0, sr.w, innerH);

      const cells: HeatCell[] = g.list.map((x, i) => {
        const rc = cellRects[i];
        const pct = +x.r?.pct_change || 0;
        const bin = binFor(pct);
        const px = +x.r?.px_bid;
        const last = px > 0 ? px : (+x.r?.c || 0);
        const fsSym = Math.max(9, Math.min(17, Math.sqrt(rc.w * rc.h) / 5.5));
        return {
          symbol: String(x.r?.symbol ?? ''),
          sector: g.name,
          capBn: x.meta.capBn,
          last,
          pct,
          vol: +x.r?.v || 0,
          x: (rc.x / sr.w) * 100, y: (rc.y / innerH) * 100,
          w: (rc.w / sr.w) * 100, h: (rc.h / innerH) * 100,
          bg: BIN_BG[bin],
          fg: BIN_FG[bin],
          fsSym,
          showSym: rc.w > 32 && rc.h > 14,
          showPct: rc.w > 32 && rc.h > 32,
        };
      });

      return {
        name: g.name,
        x: (sr.x / W) * 100, y: (sr.y / H) * 100,
        w: (sr.w / W) * 100, h: (sr.h / H) * 100,
        headPct: (SECTOR_HEAD / sr.h) * 100,
        cells,
      };
    });
  });

  // Tooltip pegado al cursor, clampeado para no salirse del mapa.
  tipX = computed(() => Math.min(this.mouse().x + 14, this.mouse().maxX - 190));
  tipY = computed(() => Math.min(this.mouse().y + 14, this.mouse().maxY - 105));

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

  fmtCap(bn: number): string {
    if (bn >= 1000) return `USD ${(bn / 1000).toLocaleString('es-AR', { maximumFractionDigits: 1 })} T`;
    return `USD ${bn.toLocaleString('es-AR', { maximumFractionDigits: 0 })} B`;
  }

  fmtVol(v: number): string {
    if (v >= 1e9) return `${(v / 1e9).toLocaleString('es-AR', { maximumFractionDigits: 1 })} MM M`;
    if (v >= 1e6) return `${(v / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 })} M`;
    return v.toLocaleString('es-AR', { maximumFractionDigits: 0 });
  }
}
