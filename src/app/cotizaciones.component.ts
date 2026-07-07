import { Component, computed, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

import { PANEL_LIDER } from './market.config';

interface TableTile {
  kind: 'table';
  id: string;
  label: string;
  statusId: string;  // feed id para status()/errors()
  detailId: string;  // id que se emite en "Ver todo"
  rows: any[];
  height: number;    // altura estimada en px, para el auto-balanceo de columnas
}

interface DolarTile {
  kind: 'dolar';
  id: 'dolar';
  label: string;
  height: number;
}

type AnyTile = TableTile | DolarTile;

interface DolarRow {
  casa: string;
  label: string;
  compra: number | null;
  venta: number | null;
  updated: string;
}

interface TileSpec {
  id: string;
  label: string;
  topN: number;
}

const TOP_MD = 10;
const TOP_SM = 6;
const TOP_LETRAS = 10; // Letras tiene ~27 símbolos reales; sube el resumen sin llegar a listar todo (eso es "Ver todo").

// Estimación de altura (px) para el auto-balanceo de columnas: cabecera fija +
// una fila por ítem. No necesita ser exacta — solo proporcional, para que el
// greedy reparta por peso visual real y no por cantidad nominal de filas.
const HEADER_H = 40;
const ROW_H = 30;
const DOLAR_ROW_H = 50; // filas de Dólar son más altas (dos líneas por casa).

// Resto de los casilleros de mini-tabla (Panel Líder/Panel General se arman
// aparte a partir del feed 'acciones', ver `tileMap`). Mismos ids que PANELS
// en app.ts. El orden acá es solo el desempate cuando dos casilleros dan la
// misma altura estimada — quien decide dónde va cada uno es el auto-balanceo
// de `columns`, no esta lista.
const OTHER_TILES: TileSpec[] = [
  { id: 'cedears',  label: 'CEDEARs',      topN: TOP_MD },
  { id: 'bonos',    label: 'Bonos',        topN: TOP_SM },
  { id: 'ons',      label: 'Obligaciones', topN: TOP_SM },
  { id: 'opciones', label: 'Opciones',     topN: TOP_SM },
  { id: 'usa',      label: 'Acciones USA', topN: TOP_SM },
  { id: 'letras',   label: 'Letras',       topN: TOP_LETRAS },
];

// Orden y etiqueta de casas para el casillero Dólar (fuente: dolarapi.com).
const DOLAR_CASAS: { casa: string; label: string }[] = [
  { casa: 'oficial',         label: 'Oficial' },
  { casa: 'blue',            label: 'Blue' },
  { casa: 'bolsa',           label: 'MEP' },
  { casa: 'contadoconliqui', label: 'CCL' },
  { casa: 'mayorista',       label: 'Mayorista' },
  { casa: 'cripto',          label: 'Cripto' },
  { casa: 'tarjeta',         label: 'Tarjeta' },
];

function byVolumeDesc(rows: any[]): any[] {
  return [...rows].sort((a, b) => (+b?.v || 0) - (+a?.v || 0));
}

// Top N por volumen; si el feed no trae volumen útil (fuera de rueda, o
// símbolos de Opciones con book chato), cae a las primeras N sin ordenar.
function topN(rows: any[], n: number): any[] {
  const sorted = byVolumeDesc(rows);
  const hasVolume = sorted.some((r) => (+r?.v || 0) > 0);
  return (hasVolume ? sorted : rows).slice(0, n);
}

@Component({
  selector: 'app-cotizaciones',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './cotizaciones.component.html',
  styleUrl: './cotizaciones.component.css',
})
export class CotizacionesComponent {
  data = input.required<Record<string, any[]>>();
  errors = input.required<Record<string, string | null>>();
  status = input.required<(id: string) => string>();
  openDetail = output<string>();

  // Precio "Último": px_bid, con fallback al cierre anterior si viene en 0
  // (fuera de horario de rueda).
  lastPrice = (row: any): number => {
    const px = +row?.px_bid;
    return px > 0 ? px : (+row?.c || 0);
  };

  pctDay = (row: any): number => +row?.pct_change || 0;

  st = (id: string): string => this.status()(id);

  // Un casillero de mini-tabla por id, con su altura estimada según la
  // cantidad REAL de filas que trajo el feed (nunca inventadas). Panel Líder
  // y Panel General se derivan del mismo feed 'acciones' (ver
  // market.config.ts): Líder = los 21 tickers oficiales de PANEL_LIDER, sin
  // recorte ni agregado; General = todo lo demás (incluye tickers no
  // listados en ninguna constante, como fallback), recortado a top N.
  private tableTiles = computed<TableTile[]>(() => {
    const acciones = this.data()['acciones'] ?? [];
    const liderSet = new Set(PANEL_LIDER);
    const liderRows = byVolumeDesc(acciones.filter((r) => liderSet.has(r?.symbol)));
    const generalRows = topN(acciones.filter((r) => !liderSet.has(r?.symbol)), TOP_MD);

    const tiles: TableTile[] = [
      { kind: 'table', id: 'panel-lider', label: 'Panel Líder', statusId: 'acciones', detailId: 'acciones', rows: liderRows, height: HEADER_H + liderRows.length * ROW_H },
      { kind: 'table', id: 'panel-general', label: 'Panel General', statusId: 'acciones', detailId: 'acciones', rows: generalRows, height: HEADER_H + generalRows.length * ROW_H },
    ];
    for (const t of OTHER_TILES) {
      const rows = topN(this.data()[t.id] ?? [], t.topN);
      tiles.push({ kind: 'table', id: t.id, label: t.label, statusId: t.id, detailId: t.id, rows, height: HEADER_H + rows.length * ROW_H });
    }
    return tiles;
  });

  dolarRows = computed<DolarRow[]>(() => {
    const rows = this.data()['dolar'] ?? [];
    const byCasa = new Map(rows.map((r) => [String(r?.casa ?? '').toLowerCase(), r]));
    return DOLAR_CASAS.map(({ casa, label }) => {
      const r = byCasa.get(casa);
      const ts = r?.fechaActualizacion ? new Date(r.fechaActualizacion) : null;
      const updated = ts && !isNaN(ts.getTime())
        ? ts.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
        : '—';
      return {
        casa,
        label,
        compra: r?.compra != null ? +r.compra : null,
        venta: r?.venta != null ? +r.venta : null,
        updated,
      };
    });
  });

  private dolarTile = computed<DolarTile>(() => ({
    kind: 'dolar',
    id: 'dolar',
    label: 'Dólar',
    height: HEADER_H + DOLAR_CASAS.length * DOLAR_ROW_H,
  }));

  // ── Auto-balanceo de columnas (masonry, greedy) ───────────────────────────
  // Nada de posiciones fijas ("columna 1 = Panel Líder, columna 2 = [...]").
  // Se ordenan los 9 casilleros por altura estimada (real, según filas que
  // trajo cada feed) de mayor a menor, y cada uno se asigna a la columna que
  // en ese momento acumula MENOS altura (long-processing-time / greedy bin
  // balancing). Así el reparto se recalcula solo con cualquier combinación
  // real de filas por categoría — no hay que retocarlo a mano.
  columns = computed<AnyTile[][]>(() => {
    const items: AnyTile[] = [...this.tableTiles(), this.dolarTile()]
      .sort((a, b) => b.height - a.height);

    const cols: AnyTile[][] = [[], [], []];
    const colHeights = [0, 0, 0];
    for (const item of items) {
      let shortest = 0;
      for (let i = 1; i < cols.length; i++) {
        if (colHeights[i] < colHeights[shortest]) shortest = i;
      }
      cols[shortest].push(item);
      colHeights[shortest] += item.height;
    }
    return cols;
  });

  fmt(v: number | null | undefined, dec = 2): string {
    if (v == null || !isFinite(v)) return '–';
    return v.toLocaleString('es-AR', { maximumFractionDigits: dec, minimumFractionDigits: dec });
  }
}
