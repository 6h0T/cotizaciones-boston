import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { catchError, of } from 'rxjs';

import {
  PANEL_LIDER,
  bondType,
  noteType,
  BOND_TYPE_ORDER,
  NOTE_TYPE_ORDER,
  bondHistoryUrl,
  REGION_ORDER,
  dropUsdVariants,
} from './market.config';
import { CedearsHeatmapComponent } from './cedears-heatmap.component';

interface TileGroup {
  label: string; // '' = casillero sin agrupación (una sola tabla corrida)
  rows: any[];
}

interface TableTile {
  kind: 'table';
  id: string;
  label: string;
  statusId: string;  // feed id para status()/errors()
  detailId: string;  // id que se emite en "Ver todo"
  groups: TileGroup[];
  count: number;     // filas totales (para el estado vacío)
  withHist: boolean; // muestra columnas % Sem. / % Año (bonos y letras)
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

// Cierres de referencia para variación semanal/anual (histórico data912).
// null = sin dato (ticker sin histórico, o serie más corta que la ventana).
interface HistRefs {
  w: number | null;
  y: number | null;
}

const TOP_MD = 10;
const TOP_SM = 6;
const GROUP_TOP = 4; // filas por grupo en los casilleros agrupados (Bonos/Letras)

// Estimación de altura (px) para el auto-balanceo de columnas: cabecera fija +
// una fila por ítem. No necesita ser exacta — solo proporcional, para que el
// greedy reparta por peso visual real y no por cantidad nominal de filas.
const HEADER_H = 40;
const ROW_H = 30;
const DOLAR_ROW_H = 50; // filas de Dólar son más altas (dos líneas por casa).

// Resto de los casilleros de mini-tabla (Panel Líder/Panel General se arman
// aparte a partir del feed 'acciones'; Bonos/Letras se arman agrupados por
// tipo, ver `groupedTile`). Mismos ids que PANELS en app.ts. El orden acá es
// solo el desempate cuando dos casilleros dan la misma altura estimada —
// quien decide dónde va cada uno es el auto-balanceo de `columns`.
const OTHER_TILES: TileSpec[] = [
  { id: 'cedears',  label: 'CEDEARs',                  topN: TOP_MD },
  { id: 'ons',      label: 'Obligaciones Negociables', topN: TOP_SM },
  { id: 'opciones', label: 'Opciones',                 topN: TOP_SM },
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

// Cierre más reciente cuya fecha sea <= hoy - daysBack (la serie viene
// ordenada ascendente por fecha).
function refClose(hist: { date: string; c: number }[], daysBack: number): number | null {
  const target = Date.now() - daysBack * 86_400_000;
  let ref: number | null = null;
  for (const h of hist) {
    if (new Date(`${h.date}T00:00:00`).getTime() > target) break;
    ref = +h.c;
  }
  return ref && ref > 0 ? ref : null;
}

function refsFromHistory(res: any): HistRefs {
  if (!Array.isArray(res) || !res.length) return { w: null, y: null };
  return { w: refClose(res, 7), y: refClose(res, 365) };
}

@Component({
  selector: 'app-cotizaciones',
  standalone: true,
  imports: [CommonModule, CedearsHeatmapComponent],
  templateUrl: './cotizaciones.component.html',
  styleUrl: './cotizaciones.component.css',
})
export class CotizacionesComponent {
  private http = inject(HttpClient);

  data = input.required<Record<string, any[]>>();
  errors = input.required<Record<string, string | null>>();
  status = input.required<(id: string) => string>();
  openDetail = output<string>();

  // Cierres de referencia por símbolo para % Sem. / % Año. Se piden una sola
  // vez por símbolo y sesión (el histórico es diario, no cambia intradía) y
  // solo para los símbolos visibles en los casilleros agrupados.
  private histRefs = signal<Record<string, HistRefs>>({});
  private histRequested = new Set<string>();

  constructor() {
    effect(() => {
      for (const sym of this.histSymbols()) {
        if (!sym || this.histRequested.has(sym)) continue;
        this.histRequested.add(sym);
        this.http.get<any>(bondHistoryUrl(sym)).pipe(
          catchError(() => of(null))
        ).subscribe((res) => {
          this.histRefs.update((m) => ({ ...m, [sym]: refsFromHistory(res) }));
        });
      }
    });
  }

  // Precio "Último": px_bid, con fallback a `last` (filas Yahoo: índices y
  // ETFs) y al cierre anterior si viene en 0 (fuera de horario de rueda).
  lastPrice = (row: any): number => {
    const px = +row?.px_bid;
    if (px > 0) return px;
    const last = +row?.last;
    return last > 0 ? last : (+row?.c || 0);
  };

  pctDay = (row: any): number => +row?.pct_change || 0;

  // Variación % contra el cierre de hace ~7/~365 días; null = sin histórico.
  // Las filas Yahoo (índices/ETFs) ya vienen con pct_week/pct_year resueltos;
  // para bonos/letras se calcula acá contra el histórico data912.
  pctWeek = (row: any): number | null =>
    row?.pct_week !== undefined ? row.pct_week : this.histPct(row, 'w');
  pctYear = (row: any): number | null =>
    row?.pct_year !== undefined ? row.pct_year : this.histPct(row, 'y');

  private histPct(row: any, k: keyof HistRefs): number | null {
    const ref = this.histRefs()[String(row?.symbol ?? '')]?.[k];
    const last = this.lastPrice(row);
    if (!ref || !(last > 0)) return null;
    return (last / ref - 1) * 100;
  }

  pctClass = (v: number | null): string => (v == null ? '' : v >= 0 ? 'pos' : 'neg');
  fmtPct = (v: number | null): string => (v == null ? '—' : `${this.fmt(v)}%`);

  st = (id: string): string => this.status()(id);

  // Casillero agrupado por tipo (Bonos / Letras): sin campo de categoría en
  // los feeds, se clasifica por patrón de ticker (ver market.config.ts) y se
  // muestran los GROUP_TOP más operados de cada grupo.
  private groupedTile(id: 'bonos' | 'letras', label: string): TableTile {
    const all = dropUsdVariants(this.data()[id] ?? []);
    const classify = id === 'bonos' ? bondType : noteType;
    const order = id === 'bonos' ? BOND_TYPE_ORDER : NOTE_TYPE_ORDER;

    const byType = new Map<string, any[]>();
    for (const r of all) {
      const t = classify(String(r?.symbol ?? ''));
      const arr = byType.get(t);
      if (arr) arr.push(r); else byType.set(t, [r]);
    }
    const groups: TileGroup[] = order
      .filter((t) => byType.get(t)?.length)
      .map((t) => ({ label: t, rows: topN(byType.get(t)!, GROUP_TOP) }));
    const count = groups.reduce((n, g) => n + g.rows.length, 0);

    return {
      kind: 'table', id, label, statusId: id, detailId: id,
      groups, count, withHist: true,
      // +1 fila por subtítulo de grupo.
      height: HEADER_H + (count + groups.length) * ROW_H,
    };
  }

  // Casillero de Índices: grupos por región (EEUU/Europa/Asia), en el orden
  // y con las etiquetas de INDEX_SPECS — sin recorte por volumen (no aplica).
  private regionTile(id: string, label: string): TableTile {
    const rows = this.data()[id] ?? [];
    const groups: TileGroup[] = REGION_ORDER
      .map((reg) => ({ label: reg, rows: rows.filter((r) => r?.region === reg) }))
      .filter((g) => g.rows.length);
    const count = groups.reduce((n, g) => n + g.rows.length, 0);
    return {
      kind: 'table', id, label, statusId: id, detailId: id,
      groups, count, withHist: true,
      height: HEADER_H + (count + groups.length) * ROW_H,
    };
  }

  // Un casillero de mini-tabla por id, con su altura estimada según la
  // cantidad REAL de filas que trajo el feed (nunca inventadas). Panel Líder
  // y Panel General se derivan del mismo feed 'acciones' (ver
  // market.config.ts): Líder = los 21 tickers oficiales de PANEL_LIDER, sin
  // recorte ni agregado; General = todo lo demás (incluye tickers no
  // listados en ninguna constante, como fallback), recortado a top N.
  private tableTiles = computed<TableTile[]>(() => {
    const acciones = dropUsdVariants(this.data()['acciones'] ?? []);
    const liderSet = new Set(PANEL_LIDER);
    const liderRows = byVolumeDesc(acciones.filter((r) => liderSet.has(r?.symbol)));
    const generalRows = topN(acciones.filter((r) => !liderSet.has(r?.symbol)), TOP_MD);

    const flatTile = (id: string, label: string, statusId: string, detailId: string, rows: any[], withHist = false): TableTile => ({
      kind: 'table', id, label, statusId, detailId,
      groups: [{ label: '', rows }], count: rows.length, withHist,
      height: HEADER_H + rows.length * ROW_H,
    });

    const tiles: TableTile[] = [
      flatTile('panel-lider', 'Panel Líder', 'acciones', 'acciones', liderRows),
      flatTile('panel-general', 'Panel General', 'acciones', 'acciones', generalRows),
      this.groupedTile('bonos', 'Bonos'),
      this.groupedTile('letras', 'Letras'),
      this.regionTile('indices', 'Índices'),
      flatTile('etfs', 'ETFs', 'etfs', 'etfs', this.data()['etfs'] ?? [], true),
    ];
    for (const t of OTHER_TILES) {
      const rows = topN(this.data()[t.id] ?? [], t.topN);
      tiles.push(flatTile(t.id, t.label, t.id, t.id, rows));
    }
    return tiles;
  });

  // Símbolos visibles que necesitan histórico data912 (solo bonos/letras —
  // índices y ETFs ya traen sus % resueltos desde Yahoo).
  private histSymbols = computed<string[]>(() => {
    const syms: string[] = [];
    for (const t of this.tableTiles()) {
      if (!t.withHist || (t.id !== 'bonos' && t.id !== 'letras')) continue;
      for (const g of t.groups) for (const r of g.rows) syms.push(String(r?.symbol ?? ''));
    }
    return syms;
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
  // Se ordenan los casilleros por altura estimada (real, según filas que
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
