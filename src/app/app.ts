import { Component, OnDestroy, OnInit, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin, Subscription, timer } from 'rxjs';
import { catchError, map, of } from 'rxjs';
import * as XLSX from 'xlsx';
import { ArbitrageComponent } from './arbitrage.component';
import { CotizacionesComponent } from './cotizaciones.component';
import { ARB_TABS, DEFAULTS, ArbTab, CedearRow, Settlement, iolCedearsUrl } from './market.config';
import { scanOpportunities, nextAlertState } from './arb-engine';
import type { ArbOpportunity, MonitorSettings } from './arb-engine';

interface PanelDef {
  id: string;
  label: string;
  url?: string;
  // optional transformer (e.g. dólar returns objects with nested fields)
  transform?: (raw: any) => any[];
}

// Panels de datos (cada uno con su url para el fetch).
const PANELS: PanelDef[] = [
  { id: 'acciones',     label: 'Acciones ARG',  url: '/api/data912/live/arg_stocks' },
  { id: 'cedears',      label: 'CEDEARs',       url: '/api/data912/live/arg_cedears' },
  { id: 'bonos',        label: 'Bonos',         url: '/api/data912/live/arg_bonds' },
  { id: 'letras',       label: 'Letras',        url: '/api/data912/live/arg_notes' },
  { id: 'ons',          label: 'Obligaciones',  url: '/api/data912/live/arg_corp' },
  { id: 'opciones',     label: 'Opciones',      url: '/api/data912/live/arg_options' },
  { id: 'usa',          label: 'Acciones USA',  url: '/api/data912/live/usa_stocks' },
  { id: 'dolar',        label: 'Dólar',         url: '/api/dolar/v1/dolares' },
];

const ALERT_FIRE = 2.0;   // umbral de disparo: % neto
const ALERT_REARM = 1.9;  // umbral de re-arme (histéresis)

// Vista de primer nivel del navbar.
type View = 'arbitraje' | 'cotizaciones';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ArbitrageComponent, CotizacionesComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit, OnDestroy {
  private http = inject(HttpClient);

  panels = PANELS;
  arbTabs = ARB_TABS;
  activePanel = signal<string>(ARB_TABS[0].id);

  // Nav de primer nivel (Arbitraje / Cotizaciones) y, dentro de Cotizaciones,
  // el casillero de detalle abierto ("Ver todo"); null = mosaico.
  view = signal<View>('arbitraje');
  detailPanel = signal<string | null>(null);
  // Wrapper para pasar panelStatus como input a <app-cotizaciones>.
  statusFn = (id: string) => this.panelStatus(id);

  // panelId -> rows
  data = signal<Record<string, any[]>>({});
  // panelId -> error string
  errors = signal<Record<string, string | null>>({});
  // panelId -> last update timestamp
  lastUpdated = signal<Record<string, Date | null>>({});

  paused = signal(false);
  intervalSec = signal<number>(DEFAULTS.refreshSec);
  loading = signal(false);
  filter = signal('');

  // Filas de CEDEARs por plazo. Fuente preferida: IOL (precio real por plazo).
  // Fallback: data912 (un solo libro ≈ 24hs) para ambos plazos.
  cedearsT0 = signal<CedearRow[]>([]); // Contado Inmediato (IOL t0)
  cedearsT1 = signal<CedearRow[]>([]); // 24hs (IOL t1)
  // true = datos reales IOL para ese plazo; false = fallback data912.
  iolSource = signal<{ t0: boolean; t1: boolean }>({ t0: false, t1: false });

  // Monitor de oportunidades de arbitraje.
  alertsEnabled = signal<boolean>(true);
  activeAlerts = signal<ArbOpportunity[]>([]);
  private armed: Record<string, boolean> = {};      // por tabId; true = listo para disparar
  private audioCtx?: AudioContext;
  private alertBuffer?: AudioBuffer;                 // /alert.wav decodificado
  private alertBufferLoading = false;
  private unlockAudio = () => this.initAudio();
  private monitorSettings: MonitorSettings = {
    commissionPct: DEFAULTS.commissionPct,
    minUsdVol: DEFAULTS.minUsdVol,
    ciAdjustPct: DEFAULTS.ciAdjustPct,
  };

  private sub?: Subscription;

  // ArbTab activa, o null si la pestaña activa es una data tab.
  activeArbTab = computed<ArbTab | null>(() => {
    const id = this.activePanel();
    return this.arbTabs.find((t) => t.id === id) ?? null;
  });

  // Filas que recibe el componente de arbitraje según el plazo de la pestaña activa.
  activeArbRows = computed<CedearRow[]>(() => {
    const tab = this.activeArbTab();
    if (!tab) return [];
    return tab.settlement === 'CI' ? this.cedearsT0() : this.cedearsT1();
  });

  // ¿La pestaña activa muestra precios reales de plazo (IOL) o estimados (fallback)?
  activeCiIsReal = computed<boolean>(() => {
    const tab = this.activeArbTab();
    if (!tab) return false;
    return tab.settlement === 'CI' ? this.iolSource().t0 : this.iolSource().t1;
  });

  // Título y estado de la subbar: sub-tab de arbitraje, o el casillero de
  // Cotizaciones cuya vista detalle ("Ver todo") está abierta.
  subbarTitle = computed<string>(() => {
    if (this.view() === 'arbitraje') return this.activeArbTab()?.label ?? '';
    const id = this.detailPanel();
    if (!id) return '';
    return this.panels.find((p) => p.id === id)?.label ?? '';
  });
  subbarStatus = computed<string>(() => {
    if (this.view() === 'arbitraje') return this.panelStatus(this.activePanel());
    const id = this.detailPanel();
    return id ? this.panelStatus(id) : '';
  });

  // Filas/columnas de la vista detalle (casillero abierto vía "Ver todo").
  detailRows = computed(() => {
    const id = this.detailPanel();
    const rows = id ? (this.data()[id] ?? []) : [];
    const q = this.filter().trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q))
    );
  });

  detailColumns = computed<string[]>(() => {
    const id = this.detailPanel();
    const rows = id ? (this.data()[id] ?? []) : [];
    if (!rows.length) return [];
    const cols = new Set<string>();
    for (const r of rows.slice(0, 10)) Object.keys(r).forEach((k) => cols.add(k));
    return Array.from(cols);
  });

  ngOnInit() {
    this.refreshAll();
    this.startTimer();
    // Primer gesto en la página → desbloquear el audio (política de autoplay)
    // para que la alerta pueda sonar aunque la pestaña quede en segundo plano
    // o el navegador minimizado.
    document.addEventListener('pointerdown', this.unlockAudio, { once: true });
    document.addEventListener('keydown', this.unlockAudio, { once: true });
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
    document.removeEventListener('pointerdown', this.unlockAudio);
    document.removeEventListener('keydown', this.unlockAudio);
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
    // IOL: precios reales por plazo (t0=CI, t1=24hs). Si falla, fallback a data912.
    const iolCall = (s: Settlement, id: string) =>
      this.http.get<CedearRow[]>(iolCedearsUrl(s)).pipe(
        map((rows) => ({ id, rows: Array.isArray(rows) ? rows : [], error: null as string | null })),
        catchError(() => of({ id, rows: [] as CedearRow[], error: 'iol' as string | null }))
      );
    calls.push(iolCall('CI', '__iol_t0') as any, iolCall('H24', '__iol_t1') as any);

    forkJoin(calls).subscribe((results) => {
      const dataAcc = { ...this.data() };
      const errAcc = { ...this.errors() };
      const tsAcc = { ...this.lastUpdated() };
      const now = new Date();
      let iolT0: CedearRow[] = [];
      let iolT1: CedearRow[] = [];
      for (const r of results) {
        if (r.id === '__iol_t0') { iolT0 = (r.rows as CedearRow[]) ?? []; continue; }
        if (r.id === '__iol_t1') { iolT1 = (r.rows as CedearRow[]) ?? []; continue; }
        if (r.error) {
          errAcc[r.id] = r.error;
        } else {
          dataAcc[r.id] = r.rows;
          errAcc[r.id] = null;
          tsAcc[r.id] = now;
        }
      }
      // Fallback por plazo: IOL si trajo filas, si no el libro de data912 ('cedears').
      const data912 = (dataAcc['cedears'] as CedearRow[]) ?? [];
      const t0Real = iolT0.length > 0;
      const t1Real = iolT1.length > 0;
      this.cedearsT0.set(t0Real ? iolT0 : data912);
      this.cedearsT1.set(t1Real ? iolT1 : data912);
      this.iolSource.set({ t0: t0Real, t1: t1Real });

      this.data.set(dataAcc);
      this.errors.set(errAcc);
      this.lastUpdated.set(tsAcc);
      this.loading.set(false);
      this.runMonitor();
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
    this.view.set('arbitraje');
    this.filter.set('');
  }

  setView(v: View) {
    this.view.set(v);
    this.detailPanel.set(null);
    this.filter.set('');
  }

  openDetail(id: string) {
    this.detailPanel.set(id);
    this.filter.set('');
  }

  closeDetail() {
    this.detailPanel.set(null);
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
    // Las arb tabs no tienen url propia: usan el feed de CEDEARs (IOL o data912).
    const arbTab = this.arbTabs.find((t) => t.id === id);
    if (arbTab) {
      const ts = this.lastUpdated()['cedears'];
      if (!ts) return 'esperando CEDEARs…';
      const sec = Math.round((Date.now() - ts.getTime()) / 1000);
      const real = arbTab.settlement === 'CI' ? this.iolSource().t0 : this.iolSource().t1;
      return `hace ${sec}s · ${real ? 'IOL' : 'data912'}`;
    }
    const ts = this.lastUpdated()[id];
    const err = this.errors()[id];
    if (err) return `error: ${err.substring(0, 30)}`;
    if (!ts) return '—';
    const sec = Math.round((Date.now() - ts.getTime()) / 1000);
    return `hace ${sec}s`;
  }

  // --- Monitor de alertas ---

  private runMonitor() {
    const opps = scanOpportunities(
      this.cedearsT0(), this.cedearsT1(), this.iolSource(), this.monitorSettings
    );
    const byTab = new Map(opps.map(o => [o.tabId, o] as const));
    let fired = false;
    for (const tab of ARB_TABS) {
      const net = byTab.get(tab.id)?.netPct ?? Number.NEGATIVE_INFINITY;
      const prev = this.armed[tab.id] ?? true;
      const s = nextAlertState(prev, net, { fire: ALERT_FIRE, rearm: ALERT_REARM });
      this.armed[tab.id] = s.armed;
      if (s.fire) fired = true;
    }
    this.activeAlerts.set(
      opps.filter(o => o.netPct >= ALERT_FIRE).sort((a, b) => b.netPct - a.netPct)
    );
    if (fired && this.alertsEnabled()) this.playBeep();
  }

  toggleAlerts() {
    const next = !this.alertsEnabled();
    this.alertsEnabled.set(next);
    if (next) this.initAudio();   // el click cuenta como gesto → habilita el audio
  }

  private initAudio() {
    try {
      if (!this.audioCtx) {
        const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (Ctor) this.audioCtx = new Ctor();
      }
      if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume();
      this.loadAlertSound();
    } catch { /* audio no disponible: ignorar */ }
  }

  // Pre-carga /alert.wav como AudioBuffer. Web Audio reproduce igual con la
  // pestaña en segundo plano o el navegador minimizado, siempre que el
  // contexto se haya desbloqueado con un gesto del usuario.
  private loadAlertSound() {
    if (this.alertBuffer || this.alertBufferLoading || !this.audioCtx) return;
    this.alertBufferLoading = true;
    fetch('/alert.wav')
      .then((r) => r.arrayBuffer())
      .then((buf) => this.audioCtx!.decodeAudioData(buf))
      .then((decoded) => { this.alertBuffer = decoded; })
      .catch(() => { this.alertBufferLoading = false; });
  }

  private playBeep() {
    try {
      this.initAudio();
      const ctx = this.audioCtx;
      if (!ctx) return;
      // Sonido custom de alerta; beep sintetizado sólo si el .wav aún no cargó.
      if (this.alertBuffer) {
        const src = ctx.createBufferSource();
        src.buffer = this.alertBuffer;
        src.connect(ctx.destination);
        src.start();
        return;
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      const t = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.26);
    } catch { /* ignorar */ }
  }
}
