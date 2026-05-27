import { Component, OnDestroy, OnInit, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin, Subscription, timer } from 'rxjs';
import { catchError, map, of } from 'rxjs';
import * as XLSX from 'xlsx';
import { ArbitrageComponent } from './arbitrage.component';

interface PanelDef {
  id: string;
  label: string;
  url?: string;
  // optional transformer (e.g. dólar returns objects with nested fields)
  transform?: (raw: any) => any[];
}

const PANELS: PanelDef[] = [
  { id: 'arbitraje',    label: 'Arbitraje' },
  { id: 'acciones',     label: 'Acciones ARG',  url: '/api/data912/live/arg_stocks' },
  { id: 'cedears',      label: 'CEDEARs',       url: '/api/data912/live/arg_cedears' },
  { id: 'bonos',        label: 'Bonos',         url: '/api/data912/live/arg_bonds' },
  { id: 'letras',       label: 'Letras',        url: '/api/data912/live/arg_notes' },
  { id: 'ons',          label: 'Obligaciones',  url: '/api/data912/live/arg_corp' },
  { id: 'opciones',     label: 'Opciones',      url: '/api/data912/live/arg_options' },
  { id: 'usa',          label: 'Acciones USA',  url: '/api/data912/live/usa_stocks' },
  { id: 'dolar',        label: 'Dólar',         url: '/api/dolar/v1/dolares' },
];

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ArbitrageComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit, OnDestroy {
  private http = inject(HttpClient);

  panels = PANELS;
  activePanel = signal<string>(PANELS[0].id);

  // panelId -> rows
  data = signal<Record<string, any[]>>({});
  // panelId -> error string
  errors = signal<Record<string, string | null>>({});
  // panelId -> last update timestamp
  lastUpdated = signal<Record<string, Date | null>>({});

  paused = signal(false);
  intervalSec = signal(15);
  loading = signal(false);
  filter = signal('');

  private sub?: Subscription;

  activeRows = computed(() => {
    const rows = this.data()[this.activePanel()] ?? [];
    const q = this.filter().trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q))
    );
  });

  activeColumns = computed<string[]>(() => {
    const rows = this.data()[this.activePanel()] ?? [];
    if (!rows.length) return [];
    const cols = new Set<string>();
    for (const r of rows.slice(0, 10)) Object.keys(r).forEach((k) => cols.add(k));
    return Array.from(cols);
  });

  ngOnInit() {
    this.refreshAll();
    this.startTimer();
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
  }

  private startTimer() {
    this.sub?.unsubscribe();
    this.sub = timer(this.intervalSec() * 1000, this.intervalSec() * 1000).subscribe(() => {
      if (!this.paused()) this.refreshAll();
    });
  }

  onIntervalChange() {
    this.startTimer();
  }

  togglePause() {
    this.paused.update((v) => !v);
  }

  refreshAll() {
    if (this.loading()) return;
    this.loading.set(true);
    const fetchable = PANELS.filter((p) => !!p.url);
    const calls = fetchable.map((p) =>
      this.http.get<any>(p.url!).pipe(
        map((res) => ({ id: p.id, rows: this.normalize(res), error: null as string | null })),
        catchError((err) =>
          of({ id: p.id, rows: [] as any[], error: err?.message ?? 'Error de red' })
        )
      )
    );
    forkJoin(calls).subscribe((results) => {
      const dataAcc = { ...this.data() };
      const errAcc = { ...this.errors() };
      const tsAcc = { ...this.lastUpdated() };
      const now = new Date();
      for (const r of results) {
        if (r.error) {
          errAcc[r.id] = r.error;
        } else {
          dataAcc[r.id] = r.rows;
          errAcc[r.id] = null;
          tsAcc[r.id] = now;
        }
      }
      this.data.set(dataAcc);
      this.errors.set(errAcc);
      this.lastUpdated.set(tsAcc);
      this.loading.set(false);
    });
  }

  private normalize(raw: any): any[] {
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.results)) return raw.results;
    if (raw && typeof raw === 'object') return [raw];
    return [];
  }

  setActive(id: string) {
    this.activePanel.set(id);
    this.filter.set('');
  }

  downloadXLSX() {
    const wasPaused = this.paused();
    this.paused.set(true);
    try {
      const wb = XLSX.utils.book_new();
      const snapshot = this.data();
      const ts = this.lastUpdated();
      // Resumen
      const resumen = [
        ['Cotizaciones Argento — snapshot'],
        ['Generado', new Date().toISOString()],
        [],
        ['Panel', 'Filas', 'Última actualización'],
        ...PANELS.map((p) => [p.label, (snapshot[p.id] ?? []).length, ts[p.id]?.toISOString() ?? '']),
      ];
      const wsResumen = XLSX.utils.aoa_to_sheet(resumen);
      XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');

      for (const p of PANELS) {
        const rows = snapshot[p.id] ?? [];
        const ws = rows.length
          ? XLSX.utils.json_to_sheet(rows)
          : XLSX.utils.aoa_to_sheet([['Sin datos']]);
        const sheetName = p.label.substring(0, 31);
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
      }

      const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      XLSX.writeFile(wb, `cotizaciones-argento-${date}.xlsx`);
    } finally {
      if (!wasPaused) this.paused.set(false);
    }
  }

  fmt(v: any): string {
    if (v == null) return '';
    if (typeof v === 'number') {
      const abs = Math.abs(v);
      if (abs > 0 && abs < 0.01) return v.toPrecision(3);
      return v.toLocaleString('es-AR', { maximumFractionDigits: 4 });
    }
    if (v instanceof Date) return v.toLocaleString('es-AR');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  panelStatus(id: string): string {
    if (id === 'arbitraje') {
      const ts = this.lastUpdated()['cedears'];
      if (!ts) return 'esperando CEDEARs…';
      const sec = Math.round((Date.now() - ts.getTime()) / 1000);
      return `hace ${sec}s (cedears)`;
    }
    const ts = this.lastUpdated()[id];
    const err = this.errors()[id];
    if (err) return `error: ${err.substring(0, 30)}`;
    if (!ts) return '—';
    const sec = Math.round((Date.now() - ts.getTime()) / 1000);
    return `hace ${sec}s`;
  }

  cedearRows(): any[] {
    return this.data()['cedears'] ?? [];
  }
}
