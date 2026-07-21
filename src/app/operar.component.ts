import { Component, DestroyRef, HostListener, OnInit, computed, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { forkJoin, catchError, of, timer, switchMap, map } from 'rxjs';

import { iolCedearsUrl, cohenHistoricoUrl, CedearRow } from './market.config';
import {
  PanelRow,
  OperarSubview,
  InstrumentId,
  InstrumentPill,
  INSTRUMENT_PILLS,
  DolarStripRow,
  MoverRow,
  FondoRow,
  FONDO_TIPO_LABEL,
  CurrencyPillId,
  CURRENCY_PILLS,
  PanelSubTabDef,
  PanelSortColumn,
  PanelSortState,
  ChartRango,
  CHART_RANGOS,
  HistoricoPoint,
  TicketStep,
  TicketState,
  TicketTipoPrecio,
  TICKET_TIPO_PRECIO,
  TicketPlazo,
  TICKET_PLAZOS,
  OperarInstrumento,
  TenenciaRow,
  TicketTipoOperacion,
  INSTRUMENTO_CHIP_LABEL,
} from './operar.types';
import {
  SimulatedMovement,
  loadMovements,
  addMovement,
  loadHomeColLeft,
  loadHomeColRight,
  saveHomeColLeft,
  saveHomeColRight,
} from './operar-storage';

// Tira de dólares — hardcodeada, sin proxy propio todavía.
// TODO: wire a /Cotizaciones/MEP cuando haya proxy.
const DOLAR_STRIP: DolarStripRow[] = [
  { label: 'Oficial', value: 1230 },
  { label: 'MEP', value: 1418 },
  { label: 'CCL', value: 1432 },
];

// Días atrás por rango del gráfico — mismo mapeo que RANGO_DIAS en
// api/iol/historico.js (server-side), replicado acá para armar la URL de
// Cohen (que pide `dias`, no fechas desde/hasta).
const RANGO_DIAS: Record<ChartRango, number> = {
  '1S': 7,
  '1M': 30,
  '6M': 182,
  '1A': 365,
  MAX: 1825,
};

// Geometría fija del SVG del gráfico histórico. REESCRITO (v2): el SVG ya
// NO contiene ningún <text> — bug real de v1: con preserveAspectRatio="none"
// el navegador estira los glyphs de <text> de forma no uniforme (ancho ≠
// alto), deformándolos como goma. Ahora los ejes (precio a la derecha,
// fechas abajo) son overlays HTML/CSS posicionados en % sobre `.fc-wrap`,
// fuera del SVG — el texto usa tipografía real del DOM, nunca se deforma
// sin importar cómo se estire el SVG debajo.
//
// viewBox 1000x250. Sólo reserva un margen chico en X (pad.left/right, para
// que el trazo no quede pegado al borde) — el padding vertical del 15%
// arriba/abajo (pad.top/bottom) es el que pide la consigna, en PÍXELES del
// viewBox (no en el rango de valores): la curva usa sólo el 70% central de
// la altura, dejando 15%+15% de aire real sin necesidad de inflar
// artificialmente el rango min/max del precio.
const CHART_W = 1000;
const CHART_H = 250;
const CHART_PAD = { top: CHART_H * 0.15, bottom: CHART_H * 0.15, left: 8, right: 8 };
const CHART_GRID_STEPS = 3; // 4 líneas horizontales (incluye tope y base)
const CHART_X_LABELS = 5;   // etiquetas de fecha repartidas en el eje X

interface ChartPoint {
  x: number;
  y: number;
  price: number;
  dateIso: string;
}

// xPct/yPct: posición en % del contenedor (0–100), para los overlays
// HTML/CSS de los ejes — se derivan de x/y en unidades de viewBox dividido
// por CHART_W/CHART_H, así quedan correctos sin importar el stretch no
// uniforme del SVG (cada eje escala independiente, pero % de SU propio eje
// siempre es exacto).
interface ChartGridLine {
  y: number;    // unidades de viewBox — para el <line> dentro del SVG
  yPct: number; // % del alto del contenedor — para el label HTML overlay
  label: string;
}

interface ChartXLabel {
  xPct: number;
  label: string;
}

interface ChartLayout {
  linePath: string;
  areaPath: string;
  gridLines: ChartGridLine[];
  xLabels: ChartXLabel[];
  points: ChartPoint[];
  plot: { x0: number; x1: number; y0: number; y1: number };
}

// Etiqueta corta del eje X: DD/MM para rangos cortos (1S/1M, donde importa el
// día); mes/año para rangos largos (6M/1A/MAX, donde el día ya no aporta).
function formatChartAxisDate(iso: string, rango: ChartRango): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  if (rango === '1S' || rango === '1M') {
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
  }
  return d.toLocaleDateString('es-AR', { month: 'short', year: '2-digit' });
}

// Fecha completa para el tooltip del crosshair — siempre con día, sin
// importar el rango (acá sí importa la precisión exacta del punto).
function formatChartTooltipDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Serie MOCK: último recurso cuando Cohen e IOL devuelven ambos [] (feed sin
// credenciales en dev, símbolo sin histórico real, mercado sin datos, etc.).
// El objetivo es que el gráfico SVG de Ficha/Ticket nunca quede en blanco
// con "Sin datos históricos" — genera un paseo aleatorio suave con la MISMA
// forma HistoricoPoint[] (fechaHora ascendente, un punto por día) que ya
// consume chartLayout(). No pretende ser una cotización real: es sólo
// placeholder visual para que la UI no quede vacía.
function buildMockHistorico(symbol: string, dias: number): HistoricoPoint[] {
  // Semilla determinística por símbolo: mismo symbol => misma serie mock en
  // toda la sesión (no "salta" en cada refetch/rango).
  let seed = 0;
  for (let i = 0; i < symbol.length; i++) seed = (seed * 31 + symbol.charCodeAt(i)) % 100000;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const points = Math.max(2, Math.min(dias, 180)); // tope razonable de puntos a graficar
  const basePrice = 100 + (seed % 900); // $100–$1000, estable por símbolo
  let price = basePrice;
  const out: HistoricoPoint[] = [];
  const today = new Date();
  for (let i = points - 1; i >= 0; i--) {
    const day = new Date(today.getTime() - i * 86_400_000);
    const drift = (rand() - 0.5) * 0.03; // ±1.5% diario
    price = Math.max(1, price * (1 + drift));
    const open = price * (1 - (rand() - 0.5) * 0.01);
    out.push({
      fechaHora: `${day.toISOString().slice(0, 10)}T00:00:00`,
      apertura: +open.toFixed(2),
      maximo: +Math.max(open, price).toFixed(2),
      minimo: +Math.min(open, price).toFixed(2),
      ultimoPrecio: +price.toFixed(2),
      volumenNominal: Math.round(1000 + rand() * 9000),
    });
  }
  return out;
}



@Component({
  selector: 'app-operar',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="operar">
      @if (subview() === 'home') {
        <!-- Acciones: primer contenedor de Home, con datos reales de
             accionesRows()/cedearsRows()/etc. — misma fuente que consume
             Panel (ver loadHome/panelRawRows). 2 columnas INDEPENDIENTES,
             cada una con su propio dropdown de instrumento (ver
             .op-acciones-grid más abajo) — mismo mecanismo de grilla que
             cotizaciones.component.ts (.mosaic), colapsa a 1 columna en
             mobile ≤760px como el resto de la app.

             Pedido de Elio (reemplaza los toggles globales que había antes):
             los 5 toggles de tipo de instrumento se sacaron de esta fila —
             ya no hacen falta, la selección ahora vive en cada columna del
             panel de Acciones vía dropdown (ver selectHomeInstrumentLeft/
             Right). En el espacio que quedó libre va el widget "Destacados"
             compacto (ver .op-top-mover más abajo): la acción/cedear con
             mayor % de ganancia en tiempo real, reusando la misma fuente que
             la card completa de Destacados de más abajo (ver topMover()) —
             esa card NO se toca, este widget es una pieza aparte y
             adicional. El buscador sigue abriendo su propio dropdown de
             resultados (cruza Acciones+Cedears, ver searchResults) — no
             filtra el panel de Acciones, son mecanismos distintos. -->
        <div class="op-home-head">
          <div class="op-search-wrap">
            <input
              class="op-search"
              type="text"
              placeholder="Buscar símbolo o descripción…"
              [ngModel]="query()"
              (ngModelChange)="query.set($event)"
            />
            @if (query().trim() && searchResults().length) {
              <div class="op-search-results">
                @for (r of searchResults(); track r.symbol) {
                  <button class="op-result" (click)="selectSymbol(r)">
                    <span class="or-sym">{{ r.symbol }}</span>
                    <span class="or-desc">{{ r.desc || '' }}</span>
                    <span class="or-px num">{{ fmt(price(r)) }}</span>
                    <span class="or-chip" [class.pos]="r.pct_change >= 0" [class.neg]="r.pct_change < 0">
                      {{ r.pct_change >= 0 ? '+' : '' }}{{ fmt(r.pct_change) }}%
                    </span>
                  </button>
                }
              </div>
            } @else if (query().trim()) {
              <div class="op-search-results">
                <div class="op-empty op-empty-inline">Sin resultados para «{{ query() }}».</div>
              </div>
            }
          </div>

          <!-- Widget compacto de Destacados, al lado del buscador. Rota
               automáticamente entre destacados() cada 4.5s (ver
               currentMoverIndex/rotatingMover/moverRotation en el
               component) — antes mostraba fijo el mayor % de ganancia. Fade
               vía [class.otm-fade] + track por symbol (Angular recrea el
               nodo al cambiar de mover, la transición CSS de opacity corre
               sola). Pausa en hover (pauseMoverRotation/resumeMoverRotation),
               reanuda al sacar el cursor. Sin destino de "ver más" — para el
               detalle completo sigue existiendo la card .op-destacados de
               más abajo, sin cambios. -->
          <div class="op-top-mover" (mouseenter)="pauseMoverRotation()" (mouseleave)="resumeMoverRotation()">
            <!-- @for con track por symbol en vez de @if+as: fuerza a Angular a
                 destruir/recrear el nodo cada vez que rotatingMover() cambia
                 de símbolo (mismo truco que flip-num.component.ts) — así la
                 animación CSS de entrada (otm-fade-in) vuelve a correr en
                 cada rotación en vez de quedar estática por reusar el mismo
                 elemento. rotatingMoverList() envuelve rotatingMover() en un
                 array de 0 o 1 elemento para poder usar @for. -->
            @for (m of rotatingMoverList(); track m.symbol) {
              <button class="op-top-mover-body otm-fade-in" type="button" (click)="selectSymbol(m)" title="Ver ficha de {{ m.symbol }}">
                <span class="otm-lbl">Destacada</span>
                <span class="otm-sym">{{ m.symbol }}</span>
                <span class="otm-px num">{{ fmt(m.price) }}</span>
                <span class="otm-chip" [class.pos]="m.pctChange >= 0" [class.neg]="m.pctChange < 0">
                  {{ m.pctChange >= 0 ? '+' : '' }}{{ fmt(m.pctChange) }}%
                </span>
              </button>
              <button class="op-buy-row-btn op-top-mover-buy" type="button" title="Comprar {{ m.symbol }}" [attr.aria-label]="'Comprar ' + m.symbol" (click)="comprarDirecto(m.symbol, 'home')">
                Comprar
              </button>
            } @empty {
              <span class="otm-lbl">Destacada</span>
              <span class="op-empty-inline op-top-mover-empty">Esperando cotizaciones…</span>
            }
          </div>

          <!-- Panel de Dólar, ubicado al lado del bloque "Destacada" en la
               barra superior (pedido de UI: mismo nivel que el buscador y
               Destacada, no en el mosaico de abajo). Reusa dolarStrip ya
               existente en el component, con una piel compacta propia
               (.op-top-dolar) en vez de la card completa .op-dolares. -->
          <div class="op-top-dolar">
            @for (d of dolarStrip; track d.label) {
              <div class="otd-item">
                <span class="otd-lbl">{{ d.label }}</span>
                <span class="otd-val num">$ {{ fmt(d.value) }}</span>
              </div>
            }
          </div>

          <button class="op-cartera-btn op-subtab on" type="button" (click)="goCartera()" title="Cartera" aria-label="Ver cartera">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
            <span>Cartera</span>
            @if (tenencias().length) {
              <span class="op-cartera-badge">{{ tenencias().length }}</span>
            }
          </button>
        </div>

        <div class="op-card op-acciones">
          <!-- 2 columnas INDEPENDIENTES (pedido de Elio): cada una con su
               propio dropdown de instrumento (select nativo, ver
               .op-col-select) en vez de un h3 fijo + toggles globales. La
               selección de cada dropdown persiste en localStorage (ver
               selectHomeInstrumentLeft/Right en el component), mismo patrón
               que el dropdown de horario de mercado de Arbitraje
               (market-hours.config.ts). -->
          <div class="op-acciones-grid">
            <div class="op-acciones-col">
              <div class="op-dropdown" [class.open]="dropdownOpenLeft()">
                <button
                  class="op-dropdown-btn"
                  type="button"
                  (click)="toggleDropdownLeft($event)"
                  aria-haspopup="listbox"
                  [attr.aria-expanded]="dropdownOpenLeft()"
                  aria-label="Instrumento columna izquierda"
                >
                  <span>{{ homeInstrumentLabelLeft() }}</span>
                  <span class="op-dropdown-arrow">▾</span>
                </button>
                @if (dropdownOpenLeft()) {
                  <ul class="op-dropdown-menu" role="listbox">
                    @for (p of pills; track p.id) {
                      <li
                        class="op-dropdown-option"
                        role="option"
                        [class.selected]="homeInstrumentLeft() === p.id"
                        [attr.aria-selected]="homeInstrumentLeft() === p.id"
                        (click)="pickHomeInstrumentLeft(p.id)"
                      >{{ p.label }}</li>
                    }
                  </ul>
                }
              </div>
              @if (homeRowsLeft().length) {
                <div class="op-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Símbolo</th>
                        <th class="num">Precio</th>
                        <th class="num">Variación</th>
                        <th class="op-th-accion"></th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (r of homeRowsLeft(); track r.symbol) {
                        <tr class="op-row-buy" (click)="comprarDirecto(r.symbol, 'home')" title="Comprar {{ r.symbol }}">
                          <td>
                            <span class="opt-sym">{{ r.symbol }}</span>
                            @if (r.desc) { <span class="opt-desc">{{ r.desc }}</span> }
                          </td>
                          <td class="num">{{ fmt(price(r)) }}</td>
                          <td class="num" [class.pos]="r.pct_change >= 0" [class.neg]="r.pct_change < 0">
                            {{ r.pct_change >= 0 ? '+' : '' }}{{ fmt(r.pct_change) }}%
                          </td>
                          <td class="op-td-accion">
                            <span class="op-row-arrow" aria-hidden="true">›</span>
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>

                <div class="op-acciones-cards">
                  @for (r of homePreviewMobileLeft(); track r.symbol) {
                    <div class="op-acc-card" (click)="comprarDirecto(r.symbol, 'home')" title="Comprar {{ r.symbol }}">
                      <div class="op-acc-id">
                        <span class="opt-sym">{{ r.symbol }}</span>
                        @if (r.desc) { <span class="opt-desc">{{ r.desc }}</span> }
                      </div>
                      <div class="op-acc-row">
                        <span class="op-acc-price num">{{ fmt(price(r)) }}</span>
                        <span class="op-acc-chip num" [class.pos]="r.pct_change >= 0" [class.neg]="r.pct_change < 0">
                          {{ r.pct_change >= 0 ? '+' : '' }}{{ fmt(r.pct_change) }}%
                        </span>
                        <span class="op-row-arrow op-acc-arrow" aria-hidden="true">›</span>
                      </div>
                    </div>
                  }
                  <button class="op-acc-verall" type="button" (click)="selectInstrument(homeInstrumentLeft())">
                    Ver todo en {{ homeInstrumentLabelLeft() }}
                  </button>
                </div>
              } @else {
                <div class="op-empty">Cargando {{ homeInstrumentLabelLeft().toLowerCase() }}…</div>
              }
            </div>

            <div class="op-acciones-col">
              <div class="op-dropdown" [class.open]="dropdownOpenRight()">
                <button
                  class="op-dropdown-btn"
                  type="button"
                  (click)="toggleDropdownRight($event)"
                  aria-haspopup="listbox"
                  [attr.aria-expanded]="dropdownOpenRight()"
                  aria-label="Instrumento columna derecha"
                >
                  <span>{{ homeInstrumentLabelRight() }}</span>
                  <span class="op-dropdown-arrow">▾</span>
                </button>
                @if (dropdownOpenRight()) {
                  <ul class="op-dropdown-menu" role="listbox">
                    @for (p of pills; track p.id) {
                      <li
                        class="op-dropdown-option"
                        role="option"
                        [class.selected]="homeInstrumentRight() === p.id"
                        [attr.aria-selected]="homeInstrumentRight() === p.id"
                        (click)="pickHomeInstrumentRight(p.id)"
                      >{{ p.label }}</li>
                    }
                  </ul>
                }
              </div>
              @if (homeRowsRight().length) {
                <div class="op-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Símbolo</th>
                        <th class="num">Precio</th>
                        <th class="num">Variación</th>
                        <th class="op-th-accion"></th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (r of homeRowsRight(); track r.symbol) {
                        <tr class="op-row-buy" (click)="comprarDirecto(r.symbol, 'home')" title="Comprar {{ r.symbol }}">
                          <td>
                            <span class="opt-sym">{{ r.symbol }}</span>
                            @if (r.desc) { <span class="opt-desc">{{ r.desc }}</span> }
                          </td>
                          <td class="num">{{ fmt(price(r)) }}</td>
                          <td class="num" [class.pos]="r.pct_change >= 0" [class.neg]="r.pct_change < 0">
                            {{ r.pct_change >= 0 ? '+' : '' }}{{ fmt(r.pct_change) }}%
                          </td>
                          <td class="op-td-accion">
                            <span class="op-row-arrow" aria-hidden="true">›</span>
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>

                <div class="op-acciones-cards">
                  @for (r of homePreviewMobileRight(); track r.symbol) {
                    <div class="op-acc-card" (click)="comprarDirecto(r.symbol, 'home')" title="Comprar {{ r.symbol }}">
                      <div class="op-acc-id">
                        <span class="opt-sym">{{ r.symbol }}</span>
                        @if (r.desc) { <span class="opt-desc">{{ r.desc }}</span> }
                      </div>
                      <div class="op-acc-row">
                        <span class="op-acc-price num">{{ fmt(price(r)) }}</span>
                        <span class="op-acc-chip num" [class.pos]="r.pct_change >= 0" [class.neg]="r.pct_change < 0">
                          {{ r.pct_change >= 0 ? '+' : '' }}{{ fmt(r.pct_change) }}%
                        </span>
                        <span class="op-row-arrow op-acc-arrow" aria-hidden="true">›</span>
                      </div>
                    </div>
                  }
                  <button class="op-acc-verall" type="button" (click)="selectInstrument(homeInstrumentRight())">
                    Ver todo en {{ homeInstrumentLabelRight() }}
                  </button>
                </div>
              } @else {
                <div class="op-empty">Cargando {{ homeInstrumentLabelRight().toLowerCase() }}…</div>
              }
            </div>
          </div>
        </div>

        <!-- Fondos: datos reales vía api/iol/fondos.js → /api/v2/Titulos/FCI
             (docs/api-iol.md §2.7, ver fondosRows()/loadFondos()) — ya NO es
             la constante hardcodeada anterior. Sin fallback real posible:
             data912 no cubre FCIs (ver market.config.ts), así que ante error
             se muestra un estado explícito en vez de inventar un valor. El
             detalle mostrado es variacionAnual (dato real más comparable
             entre fondos de distinto perfil, ver FondoRow) — a diferencia
             del hardcodeo anterior, TODOS los fondos reales traen
             variación con signo (no hay ningún campo "TNA" en la respuesta
             real de IOL), así que el color por signo aplica a los 4+ fondos
             por igual, no sólo a uno. Semántica de color según ui-kit.md
             §5.3: verde --pos = ganancia, rojo --neg = pérdida, nunca color
             hardcodeado. Sin interacción nueva (no había ningún click
             handler previo, ver diagnóstico — no se agrega ninguno acá). -->
        <div class="op-card op-fondos">
          <h3>Fondos</h3>
          @if (fondosLoading()) {
            <div class="op-empty">Cargando fondos…</div>
          } @else if (fondosError()) {
            <div class="op-empty">Fondos no disponible.</div>
          } @else if (fondosRows().length) {
            <div class="op-fondos-grid">
              @for (f of fondosRows(); track f.symbol) {
                <div class="op-fondo">
                  <span class="of-name">{{ f.name }}</span>
                  <span class="of-cat">{{ fondoTipoLabel(f.tipoFondo) }}</span>
                  <span class="of-detail num" [class.pos]="f.variacionAnual >= 0" [class.neg]="f.variacionAnual < 0">
                    {{ f.variacionAnual >= 0 ? '+' : '' }}{{ fmt(f.variacionAnual) }} % (12 m)
                  </span>
                </div>
              }
            </div>
          } @else {
            <div class="op-empty">Fondos no disponible.</div>
          }
        </div>
      } @else if (subview() === 'panel') {
        <div class="op-panel-head">
          <button class="op-back" (click)="goHome()">← Volver</button>
          <h2 class="op-panel-title">{{ selectedInstrumentLabel() }}</h2>
        </div>

        <div class="op-search-wrap">
          <input
            class="op-search"
            type="text"
            placeholder="Buscar símbolo o descripción…"
            [ngModel]="panelQuery()"
            (ngModelChange)="panelQuery.set($event)"
          />
        </div>

        <div class="op-panel-toolbar">
          <div class="op-cur-pills">
            @for (c of currencyPills; track c.id) {
              <button
                class="op-cur-pill"
                type="button"
                [class.on]="panelCurrency() === c.id"
                [disabled]="isCurrencyDisabled(c.id)"
                [title]="isCurrencyDisabled(c.id) ? 'Próximamente' : ''"
                (click)="selectCurrency(c.id)"
              >{{ c.label }}</button>
            }
          </div>

          @if (panelSubTabs().length) {
            <div class="op-subtabs">
              @for (t of panelSubTabs(); track t.id) {
                <button
                  class="op-subtab"
                  type="button"
                  [class.on]="panelSubTab() === t.id"
                  (click)="panelSubTab.set(t.id)"
                >{{ t.label }}</button>
              }
            </div>
          }
        </div>

        @if (isGeneralEmpty()) {
          <div class="op-empty">Panel general — próximamente.</div>
          <!-- TODO: integrar /Titulos/Cotizacion/Paneles para la clasificación real -->
        } @else if (panelSortedRows().length) {
          <div class="op-table-wrap">
            <table>
              <thead>
                <tr>
                  <th (click)="toggleSort('symbol')" [class.sorted]="panelSort().column === 'symbol'">
                    Nombre <span class="op-sort-arrow">{{ sortArrow('symbol') }}</span>
                  </th>
                  <th class="num" (click)="toggleSort('price')" [class.sorted]="panelSort().column === 'price'">
                    Precio <span class="op-sort-arrow">{{ sortArrow('price') }}</span>
                  </th>
                  <th class="num" (click)="toggleSort('pct')" [class.sorted]="panelSort().column === 'pct'">
                    Variación <span class="op-sort-arrow">{{ sortArrow('pct') }}</span>
                  </th>
                  <th class="op-th-accion"></th>
                </tr>
              </thead>
              <tbody>
                @for (r of panelSortedRows(); track r.symbol) {
                  <tr class="op-row-buy" (click)="comprarDirecto(r.symbol, 'panel')" title="Comprar {{ r.symbol }}">
                    <td>
                      <span class="opt-sym">{{ r.symbol }}</span>
                      @if (r.desc) { <span class="opt-desc">{{ r.desc }}</span> }
                    </td>
                    <td class="num">{{ fmt(price(r)) }}</td>
                    <td class="num" [class.pos]="r.pct_change >= 0" [class.neg]="r.pct_change < 0">
                      {{ r.pct_change >= 0 ? '+' : '' }}{{ fmt(r.pct_change) }}%
                    </td>
                    <td class="op-td-accion">
                      <span class="op-row-arrow" aria-hidden="true">›</span>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else if (panelQuery().trim()) {
          <div class="op-empty">Sin resultados para «{{ panelQuery() }}».</div>
        } @else {
          <div class="op-empty">Cargando cotizaciones…</div>
        }
      } @else if (subview() === 'ficha') {
        <div class="op-ficha-head">
          <button class="op-back" (click)="goBackFromFicha()">← Volver</button>
          <div class="op-ficha-id">
            <span class="fh-sym">{{ selectedSymbol() }}</span>
            @if (selectedRow()?.desc) { <span class="fh-desc">{{ selectedRow()!.desc }}</span> }
          </div>
        </div>

        <div class="op-ficha-price">
          @if (selectedRow(); as r) {
            <span class="fp-val num">$ {{ fmt(price(r)) }}</span>
            <span class="fp-chip" [class.pos]="r.pct_change >= 0" [class.neg]="r.pct_change < 0">
              {{ r.pct_change >= 0 ? '+' : '' }}{{ fmt(r.pct_change) }}%
            </span>
          } @else {
            <span class="fp-val num">—</span>
          }
        </div>

        <!-- Sección de 2 columnas de Ficha: mismo mecanismo de grilla que
             .mosaic/.col de cotizaciones.component.css (grid de 2 columnas +
             gap 14px, align-items:start, colapsa a 1 columna en el mismo
             breakpoint ≤1000px que usa Home — ver .op-ficha-mosaic/@media
             más abajo). Columna izquierda: selector de rango + gráfico
             (van juntos, el selector controla el gráfico). Columna derecha:
             Puntas. Ningún bloque se reescribe, sólo se reubican dentro de
             la nueva grilla — el botón sticky Comprar queda fuera, debajo,
             con su comportamiento intacto. -->
        <div class="op-ficha-mosaic">
          <div class="op-ficha-col">
            <div class="op-rango-pills">
              @for (r of chartRangos; track r.id) {
                <button class="op-rango-pill" type="button" [class.on]="chartRango() === r.id" (click)="selectRango(r.id)">
                  {{ r.label }}
                </button>
              }
            </div>

            @if (chartLayout(); as layout) {
              <div class="fc-wrap">
                <div class="fc-row">
                  <!-- fc-plot: única superficie con position:relative que
                       comparten el SVG (línea+área, SIN ningún <text>) y los
                       overlays HTML (etiquetas de fecha + tooltip) — todos
                       posicionados en % de ESTA caja, así que %s siempre
                       calzan sin importar cómo el navegador estire el SVG
                       (preserveAspectRatio="none" ya no deforma texto porque
                       ya no hay texto adentro del SVG). -->
                  <div
                    #fichaChartPlot
                    class="fc-plot"
                    (mousemove)="onChartMove($event, fichaChartPlot)"
                    (mouseleave)="onChartLeave()"
                  >
                    <svg class="fc-svg" [attr.viewBox]="'0 0 ' + chartW + ' ' + chartH" preserveAspectRatio="none">
                      <defs>
                        <linearGradient id="fcAreaGradPos" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stop-color="#059669" stop-opacity="0.35" />
                          <stop offset="100%" stop-color="#059669" stop-opacity="0" />
                        </linearGradient>
                        <linearGradient id="fcAreaGradNeg" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" [attr.stop-color]="negColor" stop-opacity="0.35" />
                          <stop offset="100%" [attr.stop-color]="negColor" stop-opacity="0" />
                        </linearGradient>
                      </defs>
                      <!-- Gridlines horizontales sutiles (eje Y) — sin texto, la
                           marca de precio vive en el overlay .fc-axis-y de al lado. -->
                      @for (g of layout.gridLines; track g.y) {
                        <line class="fc-grid-line" [attr.x1]="layout.plot.x0" [attr.x2]="layout.plot.x1" [attr.y1]="g.y" [attr.y2]="g.y" />
                      }
                      <!-- Área: <path> M/L…Z explícito que baja a la base ANTES
                           de cerrar (nunca una diagonal xN,yN -> x0,y0). -->
                      <path class="fc-area" [attr.d]="layout.areaPath" [attr.fill]="chartIsPos() ? 'url(#fcAreaGradPos)' : 'url(#fcAreaGradNeg)'" />
                      <!-- Línea: vector-effect="non-scaling-stroke" mantiene el
                           trazo a 2px reales sin importar el stretch no
                           uniforme del viewBox (preserveAspectRatio="none"). -->
                      <path class="fc-line" [class.pos]="chartIsPos()" [class.neg]="!chartIsPos()" [attr.d]="layout.linePath" fill="none" vector-effect="non-scaling-stroke" />
                      <!-- Crosshair al pasar el cursor. -->
                      @if (chartHover(); as h) {
                        <line class="fc-crosshair-x" [attr.x1]="h.x" [attr.x2]="h.x" [attr.y1]="layout.plot.y0" [attr.y2]="layout.plot.y1" vector-effect="non-scaling-stroke" />
                        <circle class="fc-crosshair-dot" [class.pos]="chartIsPos()" [class.neg]="!chartIsPos()" [attr.cx]="h.x" [attr.cy]="h.y" r="4" vector-effect="non-scaling-stroke" />
                      }
                    </svg>

                    <!-- Etiquetas de fecha (eje X): overlay HTML, nunca dentro
                         del SVG — tipografía real del DOM, no se deforma. -->
                    @for (xl of layout.xLabels; track xl.xPct) {
                      <span class="fc-x-label" [style.left.%]="xl.xPct">{{ xl.label }}</span>
                    }

                    <!-- Tooltip del crosshair. -->
                    @if (chartHover(); as h) {
                      <div class="fc-tooltip" [style.left.%]="chartHoverXPct()">
                        <span class="fc-tooltip-date">{{ chartHoverDateLabel() }}</span>
                        <span class="fc-tooltip-price num">$ {{ fmt(h.price) }}</span>
                      </div>
                    }
                  </div>

                  <!-- Eje Y: marcas de precio, overlay HTML en columna propia
                       al lado del plot (nunca <text> dentro del SVG). -->
                  <div class="fc-axis-y">
                    @for (g of layout.gridLines; track g.y) {
                      <span class="fc-axis-y-label" [style.top.%]="g.yPct">{{ g.label }}</span>
                    }
                  </div>
                </div>
              </div>
            } @else if (historicoLoading()) {
              <div class="op-empty">Cargando gráfico…</div>
            } @else {
              <div class="op-empty">Sin datos históricos para este rango.</div>
            }
          </div>

          <div class="op-ficha-col">
            <div class="op-card op-book">
              <button class="op-book-toggle" type="button" (click)="fichaBookOpen.set(!fichaBookOpen())">
                <span class="ob-title-wrap">
                  <h3>Puntas</h3>
                  @if (bookIsEmpty(selectedRow())) { <span class="ori-chip warn">estimado</span> }
                </span>
                <span class="ob-chevron" [class.open]="fichaBookOpen()">›</span>
              </button>
              @if (fichaBookOpen()) {
                <div class="op-book-row">
                  <div class="ob-side ob-buy">
                    <span class="ob-lbl">Compra</span>
                    <span class="ob-qty num">{{ fmt(selectedRow()?.q_bid ?? 0, 0) }}</span>
                    <span class="ob-px num">{{ fmt(bookBidPx(selectedRow())) }}</span>
                  </div>
                  <div class="ob-side ob-sell">
                    <span class="ob-lbl">Venta</span>
                    <span class="ob-px num">{{ fmt(bookAskPx(selectedRow())) }}</span>
                    <span class="ob-qty num">{{ fmt(selectedRow()?.q_ask ?? 0, 0) }}</span>
                  </div>
                </div>
              }
            </div>
          </div>
        </div>

        <button class="op-buy-sticky" type="button" (click)="goTicket()">Comprar {{ selectedSymbol() }}</button>
      } @else if (subview() === 'ticket') {
        @if (ticketStep() === 'form') {
          <div class="op-ficha-head">
            <button class="op-back" (click)="goBackFromTicketForm()">← Volver</button>
            <div class="op-ficha-id">
              <span class="fh-sym">{{ selectedSymbol() }}</span>
              <span class="fh-desc">{{ ticketTipo() === 'venta' ? 'Vender' : 'Comprar' }}</span>
            </div>
          </div>

          <!-- Gráfico histórico (mismo SVG que Ficha, ver .fc-wrap/chartPoints
               más abajo): arriba de Puntas/Orden, en la pantalla de compra.
               loadHistorico() se dispara para esta subvista vía fichaFetch
               (ver effect en el component) — mismos historicoData()/
               historicoLoading()/chartRango() que ya usa Ficha, sin
               duplicar estado ni lógica. -->
          <div class="op-card op-chart-card">
            <div class="op-rango-pills">
              @for (r of chartRangos; track r.id) {
                <button class="op-rango-pill" type="button" [class.on]="chartRango() === r.id" (click)="selectRango(r.id)">
                  {{ r.label }}
                </button>
              }
            </div>

            @if (chartLayout(); as layout) {
              <div class="fc-wrap">
                <div class="fc-row">
                  <div
                    #ticketChartPlot
                    class="fc-plot"
                    (mousemove)="onChartMove($event, ticketChartPlot)"
                    (mouseleave)="onChartLeave()"
                  >
                    <svg class="fc-svg" [attr.viewBox]="'0 0 ' + chartW + ' ' + chartH" preserveAspectRatio="none">
                      <defs>
                        <linearGradient id="fcAreaGradPosTk" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stop-color="#059669" stop-opacity="0.35" />
                          <stop offset="100%" stop-color="#059669" stop-opacity="0" />
                        </linearGradient>
                        <linearGradient id="fcAreaGradNegTk" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" [attr.stop-color]="negColor" stop-opacity="0.35" />
                          <stop offset="100%" [attr.stop-color]="negColor" stop-opacity="0" />
                        </linearGradient>
                      </defs>
                      @for (g of layout.gridLines; track g.y) {
                        <line class="fc-grid-line" [attr.x1]="layout.plot.x0" [attr.x2]="layout.plot.x1" [attr.y1]="g.y" [attr.y2]="g.y" />
                      }
                      <path class="fc-area" [attr.d]="layout.areaPath" [attr.fill]="chartIsPos() ? 'url(#fcAreaGradPosTk)' : 'url(#fcAreaGradNegTk)'" />
                      <path class="fc-line" [class.pos]="chartIsPos()" [class.neg]="!chartIsPos()" [attr.d]="layout.linePath" fill="none" vector-effect="non-scaling-stroke" />
                      @if (chartHover(); as h) {
                        <line class="fc-crosshair-x" [attr.x1]="h.x" [attr.x2]="h.x" [attr.y1]="layout.plot.y0" [attr.y2]="layout.plot.y1" vector-effect="non-scaling-stroke" />
                        <circle class="fc-crosshair-dot" [class.pos]="chartIsPos()" [class.neg]="!chartIsPos()" [attr.cx]="h.x" [attr.cy]="h.y" r="4" vector-effect="non-scaling-stroke" />
                      }
                    </svg>

                    @for (xl of layout.xLabels; track xl.xPct) {
                      <span class="fc-x-label" [style.left.%]="xl.xPct">{{ xl.label }}</span>
                    }

                    @if (chartHover(); as h) {
                      <div class="fc-tooltip" [style.left.%]="chartHoverXPct()">
                        <span class="fc-tooltip-date">{{ chartHoverDateLabel() }}</span>
                        <span class="fc-tooltip-price num">$ {{ fmt(h.price) }}</span>
                      </div>
                    }
                  </div>

                  <div class="fc-axis-y">
                    @for (g of layout.gridLines; track g.y) {
                      <span class="fc-axis-y-label" [style.top.%]="g.yPct">{{ g.label }}</span>
                    }
                  </div>
                </div>
              </div>
            } @else if (historicoLoading()) {
              <div class="op-empty">Cargando gráfico…</div>
            } @else {
              <div class="op-empty">Sin datos históricos para este rango.</div>
            }
          </div>

          <!-- Puntas + Orden en 2 columnas — grid dedicado del Ticket
               (.op-ticket-mosaic), mismo mecanismo que .op-home-mosaic/
               .op-ficha-mosaic (grid de 2 columnas + gap 14px). A diferencia
               de esos otros mosaicos, acá align-items es stretch (default,
               ver CSS): Orden tiene más filas que Puntas (Precio/Plazo +
               Cantidad/Monto vs. sólo Compra/Venta), así que con
               align-items:start la columna de Puntas quedaba visualmente más
               chica al lado de Orden — con stretch ambas cards ocupan la
               altura de la fila más alta del grid (Orden), Puntas se estira
               parejo aunque su contenido siga arriba. Se usa una clase propia
               en vez de reusar .op-ficha-mosaic para no atar el
               breakpoint/estilo del Ticket al de Ficha (subvistas distintas,
               alcance estricto pide no tocar Ficha). Mismo breakpoint
               ≤1000px que el resto de la app (ver @media más abajo) — por
               debajo de ese ancho las columnas colapsan a 1 sola, Puntas
               arriba y Orden abajo. El botón "Revisar orden" vive DENTRO de
               la card Orden, como cierre de esa columna (ver op-order-body
               más abajo) — ya no es una franja a lo ancho completo de toda
               la pantalla. Contenido interno de cada card intacto. -->
          <div class="op-ticket-mosaic">
            <!-- op-book-fill: clase adicional SOLO en esta instancia de
                 Ticket (combinada con op-card op-book, igual que
                 op-book-row-stacked más abajo) — Ficha usa "op-card op-book"
                 sin este modificador y no se ve afectada. Cadena de alturas
                 completa para que Compra/Venta se repartan el 100% de la
                 columna en partes iguales (ver CSS, selectores
                 .op-card.op-book-fill / .op-book-row-stacked / .ob-side
                 dentro de ese scope):
                 grid (align-items:stretch, default) estira este .op-card a
                 la altura de fila (= altura de Orden) → op-book-fill lo
                 vuelve flex-column con height:100% → op-book-row-stacked
                 toma flex:1 de ese alto → cada .ob-side toma flex:1 1 0
                 del alto de op-book-row-stacked. -->
            <div class="op-card op-book op-book-fill">
              <div class="ob-title-wrap">
                <h3>Puntas</h3>
                @if (bookIsEmpty(selectedRow())) { <span class="ori-chip warn">estimado</span> }
              </div>
              <!-- Compra/Venta apiladas (no lado a lado) SOLO en esta
                   instancia de Ticket: clase adicional op-book-row-stacked
                   combinada con op-book-row (ver CSS, selector compuesto
                   .op-book-row.op-book-row-stacked) — Ficha sigue usando
                   op-book-row sola, sin este modificador, así que su
                   Compra/Venta lado a lado no cambia. -->
              <div class="op-book-row op-book-row-stacked">
                <div class="ob-side ob-buy">
                  <span class="ob-lbl">Compra</span>
                  <span class="ob-qty num">{{ fmt(selectedRow()?.q_bid ?? 0, 0) }}</span>
                  <span class="ob-px num">{{ fmt(bookBidPx(selectedRow())) }}</span>
                </div>
                <div class="ob-side ob-sell">
                  <span class="ob-lbl">Venta</span>
                  <span class="ob-px num">{{ fmt(bookAskPx(selectedRow())) }}</span>
                  <span class="ob-qty num">{{ fmt(selectedRow()?.q_ask ?? 0, 0) }}</span>
                </div>
              </div>
            </div>

            <div class="op-card op-order">
              <h3>Orden</h3>
              <div class="op-order-body">
                <div class="op-ticket-row">
                  <label class="op-field">
                    <span class="of-lbl">Precio</span>
                    <select class="op-select" [ngModel]="ticketState().tipoPrecio" (ngModelChange)="setTipoPrecio($event)">
                      @for (t of tipoPrecioOpts; track t.id) {
                        <option [value]="t.id">{{ t.label }}</option>
                      }
                    </select>
                  </label>

                  @if (ticketState().tipoPrecio === 'limite') {
                    <label class="op-field">
                      <span class="of-lbl">Precio límite</span>
                      <input
                        class="op-input num"
                        type="number" min="0" step="0.01"
                        [ngModel]="ticketState().precioLimite"
                        (ngModelChange)="setPrecioLimite($event)"
                      />
                    </label>
                  }

                  <label class="op-field">
                    <span class="of-lbl">Plazo de liquidación</span>
                    <select class="op-select" [ngModel]="ticketState().plazo" (ngModelChange)="setPlazo($event)">
                      @for (p of plazoOpts; track p.id) {
                        <option [value]="p.id">{{ p.label }}</option>
                      }
                    </select>
                  </label>
                </div>

                <!-- Cantidad + Monto a invertir en 2 columnas — mismo contenedor
                     .op-ticket-row/.op-field que ya usan Precio/Plazo de arriba
                     (flex + gap 14px + flex-wrap, min-width 140px por campo).
                     Reusar el contenedor existente evita reescribir el
                     comportamiento responsive: al no entrar los 2 min-width
                     140px + gap en el ancho disponible, flex-wrap los apila en
                     1 columna igual que ya le pasa a Precio/Plazo en mobile —
                     no hace falta una media query nueva. Stepper de Cantidad y
                     label "Disponible"/aviso de Monto quedan intactos, sólo se
                     reubican dentro de la fila. -->
                <div class="op-ticket-row">
                  <div class="op-field">
                    <div class="of-row">
                      <span class="of-lbl">Cantidad</span>
                      @if (ticketTipo() === 'venta') {
                        <span class="of-hint">Disponible: {{ fmt(maxVendible(), 0) }}</span>
                      }
                    </div>
                    <div class="op-stepper">
                      <input
                        class="op-step-input num"
                        type="number" min="0" step="1"
                        [ngModel]="ticketState().cantidad"
                        (ngModelChange)="setCantidad($event)"
                      />
                      <button class="op-step-btn" type="button" (click)="decCantidad()" [disabled]="ticketState().cantidad <= 0">−</button>
                      <button class="op-step-btn" type="button" (click)="incCantidad()" [disabled]="ticketState().cantidad >= maxVendible()">+</button>
                    </div>
                  </div>

                  <div class="op-field">
                    <div class="of-row">
                      <span class="of-lbl">Monto a invertir</span>
                      @if (montoBelowMinimum()) {
                        <span class="of-hint of-hint-warn">No alcanza para 1 nominal · mín. $ {{ fmt(precioEfectivo()) }}</span>
                      } @else {
                        <!-- TODO: viene de estadocuenta si se habilita más adelante -->
                        <span class="of-hint">Disponible: $ 0,00</span>
                      }
                    </div>
                    <input
                      class="op-input op-input-monto num"
                      type="number" min="0" step="100"
                      [ngModel]="ticketState().monto"
                      (ngModelChange)="setMonto($event)"
                    />
                  </div>
                </div>

                <!-- "Revisar orden" como cierre de la columna Orden (ver
                     comentario del mosaico más arriba) — mismo botón/clases
                     de siempre, sólo se reubica dentro de op-order-body en
                     vez de vivir afuera de las 2 columnas. margin-top:auto
                     (op-order-body es flex-column) lo empuja al fondo de la
                     card cuando Orden queda más baja que su contenido en
                     mobile (1 columna, ver @media) sin afectar el layout de
                     desktop, donde ya es el último elemento del flujo. -->
                <button class="op-buy-sticky op-buy-sticky-sm" type="button" [disabled]="ticketState().cantidad <= 0" (click)="goTicketConfirmar()">
                  Revisar orden
                </button>
              </div>
            </div>
          </div>
        } @else {
          <div class="op-ficha-head">
            <button class="op-back" (click)="goTicketForm()">← Volver</button>
            <div class="op-ficha-id">
              <span class="fh-sym">Revisar orden</span>
              <span class="fh-desc">{{ selectedSymbol() }}</span>
            </div>
          </div>

          <div class="op-card op-ref">
            <h3>Resumen</h3>
            <div class="op-summary-list">
              <div class="op-summary-row">
                <span class="orr-lbl">Símbolo</span>
                <span class="orr-right"><span class="orr-val">{{ selectedSymbol() }}</span></span>
              </div>
              <div class="op-summary-row">
                <span class="orr-lbl">Operación</span>
                <span class="orr-right"><span class="orr-val">{{ ticketTipo() === 'venta' ? 'Vender' : 'Comprar' }}</span></span>
              </div>
              <div class="op-summary-row">
                <span class="orr-lbl">Precio</span>
                <span class="orr-right">
                  <span class="orr-val">
                    @if (ticketState().tipoPrecio === 'mercado') {
                      Mercado
                    } @else {
                      Límite · $ {{ fmt(ticketState().precioLimite ?? 0) }}
                    }
                  </span>
                </span>
              </div>
              <div class="op-summary-row">
                <span class="orr-lbl">Plazo</span>
                <span class="orr-right"><span class="orr-val">{{ plazoLabel(ticketState().plazo) }}</span></span>
              </div>
              <div class="op-summary-row">
                <span class="orr-lbl">Cantidad</span>
                <span class="orr-right"><span class="orr-val num">{{ fmt(ticketState().cantidad, 0) }}</span></span>
              </div>
              <div class="op-summary-row">
                <span class="orr-lbl">Monto estimado</span>
                <span class="orr-right"><span class="orr-val num">$ {{ fmt(montoEstimado()) }}</span></span>
              </div>
            </div>
          </div>

          <!-- TODO: reemplazar por texto legal real aprobado por Boston antes de
               habilitar esta pantalla en producción. -->
          <p class="op-legal">
            Esta operación está sujeta a las condiciones de mercado vigentes al momento de su ejecución.
            Los precios e importes mostrados son estimados y pueden variar.
          </p>

          <label class="op-checkbox-row">
            <input
              type="checkbox"
              class="op-checkbox"
              [ngModel]="ticketAccepted()"
              (ngModelChange)="ticketAccepted.set($event)"
            />
            <span>Confirmo que leí y acepto los términos de esta operación</span>
          </label>

          @if (ticketBannerShown()) {
            <div class="op-warn-banner">
              <p>La operatoria de IOL todavía no está habilitada para esta cuenta. Esta operación no fue enviada.</p>
              <button class="op-warn-banner-link" type="button" (click)="goCarteraFromTicket()">Ver en Cartera →</button>
            </div>
          }

          <button class="op-buy-sticky" type="button" [disabled]="!ticketAccepted()" (click)="confirmarOperacion()">
            Confirmar operación
          </button>
        }
      } @else if (subview() === 'cartera') {
        <div class="op-panel-head">
          <button class="op-back" (click)="goHome()">← Volver</button>
          <h2 class="op-panel-title">Cartera</h2>
        </div>

        <div class="op-warn-banner">
          <p>DATOS SIMULADOS — no representa operaciones reales ni información de tu cuenta en IOL.</p>
        </div>

        @if (tenencias().length) {
          <div class="op-card">
            <div class="op-dolares-row">
              <div class="op-dollar-item">
                <span class="od-lbl">Total invertido</span>
                <span class="op-resumen-val num">$ {{ fmt(resumenCartera().totalInvertido) }}</span>
              </div>
              <div class="op-dollar-item">
                <span class="od-lbl">Ganancia / Pérdida total</span>
                <div class="op-resumen-prof" [class.pos]="resumenCartera().gananciaTotal >= 0" [class.neg]="resumenCartera().gananciaTotal < 0">
                  <span class="rp-val num">
                    {{ resumenCartera().gananciaTotal >= 0 ? '+' : '' }}$ {{ fmt(resumenCartera().gananciaTotal) }}
                  </span>
                </div>
              </div>
              <div class="op-dollar-item">
                <span class="od-lbl">Variación de hoy</span>
                <span class="op-resumen-val num" [class.pos]="resumenCartera().variacionHoy >= 0" [class.neg]="resumenCartera().variacionHoy < 0">
                  {{ resumenCartera().variacionHoy >= 0 ? '+' : '' }}$ {{ fmt(resumenCartera().variacionHoy) }}
                </span>
                <span class="op-resumen-pct">
                  ({{ resumenCartera().variacionHoyPct >= 0 ? '+' : '' }}{{ fmt(resumenCartera().variacionHoyPct) }}%) hoy
                </span>
              </div>
            </div>
          </div>
        }

        <div class="op-subtabs">
          <button class="op-subtab" type="button" [class.on]="carteraTab() === 'tenencias'" (click)="carteraTab.set('tenencias')">Tenencias</button>
          <button class="op-subtab" type="button" [class.on]="carteraTab() === 'movimientos'" (click)="carteraTab.set('movimientos')">Movimientos</button>
        </div>

        @if (carteraTab() === 'tenencias') {
          @if (tenencias().length) {
            <div class="op-card op-cart-comp-card">
              <span class="od-lbl">Composición de la cartera</span>
              <div class="op-cart-comp-row">
                @for (c of composicionCartera(); track c.instrumento) {
                  <span class="op-cart-comp-chip">
                    <span class="op-cart-comp-pct num">{{ fmt(c.pct, 0) }}%</span>
                    <span class="op-cart-comp-lbl">{{ c.label }}</span>
                  </span>
                }
              </div>
            </div>

            <div class="op-pills op-cart-filter">
              @for (p of tenenciasFilterOptions; track p.id) {
                <button class="op-pill" type="button" [class.on]="tenenciasFiltro() === p.id" (click)="tenenciasFiltro.set(p.id)">
                  <span class="op-pill-circle">{{ p.initials }}</span>
                  <span class="op-pill-label">{{ p.label }}</span>
                </button>
              }
            </div>

            @if (tenenciasFiltradas().length) {
            <div class="op-table-wrap op-cartera-table">
              <table>
                <thead>
                  <tr>
                    <th>Símbolo</th>
                    <th class="num">Cantidad</th>
                    <th class="num">Precio prom.</th>
                    <th class="num">Valor actual</th>
                    <th class="num">P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  @for (t of tenenciasFiltradas(); track t.symbol) {
                    <tr (click)="toggleTenenciaExpandida(t.symbol)">
                      <td>
                        <span class="opt-sym">{{ t.symbol }}</span>
                        <span class="ori-chip">{{ instrumentoLabel[t.instrumento] }}</span>
                        @if (t.estimado) { <span class="ori-chip warn">estimado</span> }
                      </td>
                      <td class="num">{{ fmt(t.cantidad, 0) }}</td>
                      <td class="num">{{ fmt(t.precioPromedio) }}</td>
                      <td class="num">{{ fmt(t.valorActual) }}</td>
                      <td class="num" [class.pos]="t.pnl >= 0" [class.neg]="t.pnl < 0">
                        {{ t.pnl >= 0 ? '+' : '' }}{{ fmt(t.pnl) }}
                      </td>
                    </tr>
                    @if (tenenciaExpandida() === t.symbol) {
                      <tr class="op-tenencia-actions-row">
                        <td colspan="5">
                          <div class="op-subtabs">
                            <button class="op-subtab on" type="button" (click)="comprarMasDesdeCartera(t.symbol)">Comprar más</button>
                            <button class="op-subtab sell" type="button" (click)="venderDesdeCartera(t.symbol)">Vender</button>
                          </div>
                        </td>
                      </tr>
                    }
                  }
                </tbody>
              </table>
            </div>

            <div class="op-mobile-cards">
              @for (t of tenenciasFiltradas(); track t.symbol) {
                <div class="op-card op-cart-card" (click)="toggleTenenciaExpandida(t.symbol)">
                  <div class="op-id-row">
                    <span class="opt-sym">{{ t.symbol }}</span>
                    <span class="ori-chip">{{ instrumentoLabel[t.instrumento] }}</span>
                    @if (t.estimado) { <span class="ori-chip warn">estimado</span> }
                  </div>
                  <div class="op-dolares-row">
                    <div class="op-dollar-item">
                      <span class="od-lbl">Cantidad</span>
                      <span class="od-val num">{{ fmt(t.cantidad, 0) }}</span>
                    </div>
                    <div class="op-dollar-item">
                      <span class="od-lbl">Precio prom.</span>
                      <span class="od-val num">{{ fmt(t.precioPromedio) }}</span>
                    </div>
                    <div class="op-dollar-item">
                      <span class="od-lbl">Valor actual</span>
                      <span class="od-val num">{{ fmt(t.valorActual) }}</span>
                    </div>
                  </div>
                  <div class="op-cart-delta" [class.pos]="t.pnl >= 0" [class.neg]="t.pnl < 0">
                    <span class="od-lbl">P&amp;L</span>
                    <span class="op-cart-delta-val num">{{ t.pnl >= 0 ? '+' : '' }}{{ fmt(t.pnl) }}</span>
                  </div>
                  @if (tenenciaExpandida() === t.symbol) {
                    <div class="op-subtabs">
                      <button class="op-subtab on" type="button" (click)="comprarMasDesdeCartera(t.symbol)">Comprar más</button>
                      <button class="op-subtab sell" type="button" (click)="venderDesdeCartera(t.symbol)">Vender</button>
                    </div>
                  }
                </div>
              }
            </div>
            } @else {
              <div class="op-empty">
                No tenés tenencias de este tipo.
                <button class="op-empty-cta" type="button" (click)="tenenciasFiltro.set('todos')">Ver todos</button>
              </div>
            }
          } @else {
            <div class="op-empty">
              Todavía no tenés compras simuladas.
              <button class="op-empty-cta" type="button" (click)="goHome()">Elegí un símbolo para comprar</button>
            </div>
          }
        } @else {
          @if (movimientosOrdenados().length) {
            <div class="op-table-wrap op-cartera-table">
              <table>
                <thead>
                  <tr>
                    <th>Tipo</th>
                    <th>Símbolo</th>
                    <th class="num">Cantidad</th>
                    <th class="num">Precio</th>
                    <th class="num">Monto</th>
                    <th>Plazo</th>
                    <th>Liquidación est.</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  @for (m of movimientosOrdenados(); track m.id) {
                    <tr [class.op-buy]="m.tipo === 'compra'" [class.op-sell]="m.tipo === 'venta'">
                      <td>{{ m.tipo === 'compra' ? 'Compra' : 'Venta' }}</td>
                      <td>
                        <span class="opt-sym">{{ m.symbol }}</span>
                        <span class="ori-chip">{{ instrumentoLabel[m.instrumento] }}</span>
                      </td>
                      <td class="num">{{ fmt(m.cantidad, 0) }}</td>
                      <td class="num">{{ fmt(m.precio) }}</td>
                      <td class="num">{{ fmt(m.monto) }}</td>
                      <td>{{ plazoLabel(m.plazo) }}</td>
                      <td>{{ m.fechaLiquidacionEstimada }}</td>
                      <td>
                        <span class="ori-chip" [class.warn]="m.estado === 'simulada_pendiente'" [class.pos]="m.estado === 'simulada_liquidada'">
                          {{ m.estado === 'simulada_pendiente' ? 'Pendiente' : 'Liquidada' }}
                        </span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>

            <div class="op-mobile-cards">
              @for (m of movimientosOrdenados(); track m.id) {
                <div class="op-card op-cart-card">
                  <div class="op-cart-top">
                    <div class="op-id-row">
                      <span class="opt-sym">{{ m.symbol }}</span>
                      <span class="ori-chip" [class.accent]="m.tipo === 'compra'" [class.warn]="m.tipo === 'venta'">
                        {{ m.tipo === 'compra' ? 'Compra' : 'Venta' }}
                      </span>
                    </div>
                    <span class="of-hint">{{ relativeTime(m.timestamp) }}</span>
                  </div>
                  <div class="op-dolares-row">
                    <div class="op-dollar-item">
                      <span class="od-lbl">Cantidad</span>
                      <span class="od-val num">{{ fmt(m.cantidad, 0) }}</span>
                    </div>
                    <div class="op-dollar-item">
                      <span class="od-lbl">Precio</span>
                      <span class="od-val num">{{ fmt(m.precio) }}</span>
                    </div>
                    <div class="op-dollar-item">
                      <span class="od-lbl">Monto</span>
                      <span class="od-val num">{{ fmt(m.monto) }}</span>
                    </div>
                  </div>
                  <span class="ori-chip op-cart-status" [class.warn]="m.estado === 'simulada_pendiente'" [class.pos]="m.estado === 'simulada_liquidada'">
                    {{ m.estado === 'simulada_pendiente' ? 'Pendiente' : 'Liquidada' }}
                  </span>
                </div>
              }
            </div>
          } @else {
            <div class="op-empty">
              Todavía no tenés movimientos simulados.
              <button class="op-empty-cta" type="button" (click)="goHome()">Elegí un símbolo para comprar</button>
            </div>
          }
        }
      }
    </div>
  `,
  styles: [`
    .operar { display: flex; flex-direction: column; gap: 18px; }

    /* Buscador */
    .op-search-wrap { position: relative; max-width: 300px; }
    .op-search {
      width: 100%; max-width: 300px; height: 40px; padding: 0 14px;
      border: 1px solid var(--line); border-radius: var(--r);
      background: var(--surface); color: var(--ink);
      font-family: var(--font-ui); font-size: 14px; outline: none;
      transition: border-color .12s, box-shadow .12s;
    }
    .op-search:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-sf); }
    .op-search-results {
      position: absolute; z-index: 5; top: calc(100% + 6px); left: 0; right: 0;
      display: flex; flex-direction: column;
      background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg);
      box-shadow: var(--shadow); max-height: 320px; overflow-y: auto;
    }
    .op-result {
      display: grid; grid-template-columns: 84px 1fr auto auto; align-items: center; gap: 10px;
      padding: 8px 14px; border: 0; border-bottom: 1px solid var(--line);
      background: var(--surface); cursor: pointer; text-align: left;
      transition: background .12s;
    }
    .op-result:last-child { border-bottom: 0; }
    .op-result:hover { background: var(--accent-sf); }
    .or-sym { font-family: var(--font-mono); font-weight: 600; font-size: 13px; color: var(--ink); }
    .or-desc { font-size: 11.5px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .or-px { font-size: 13px; color: var(--ink-2); }
    .or-chip, .om-chip, .ori-chip {
      display: inline-flex; align-items: center; height: 20px; padding: 0 7px;
      border-radius: var(--r-sm); font-family: var(--font-mono); font-size: 11px; font-weight: 600;
      background: var(--surface-2); color: var(--ink-3); border: 1px solid var(--line);
    }
    .or-chip.pos, .om-chip.pos, .ori-chip.pos { background: var(--pos-bg); border-color: var(--pos-line); color: var(--pos); }
    .or-chip.neg, .om-chip.neg, .ori-chip.neg { background: var(--neg-bg); border-color: var(--neg-line); color: var(--neg); }
    .ori-chip.warn { background: var(--warn-bg); border-color: var(--warn-line); color: var(--warn); }
    .op-empty-inline { border: 0; padding: 14px; }

    /* Pills de instrumento */
    .op-pills { display: flex; gap: 10px; flex-wrap: wrap; }
    .op-pill {
      display: flex; align-items: center; gap: 9px;
      height: 44px; padding: 0 14px 0 6px;
      border: 1px solid var(--line); border-radius: var(--r-lg);
      background: var(--surface); cursor: pointer;
      font-family: var(--font-ui); font-size: 13px; font-weight: 600; color: var(--ink);
      transition: border-color .14s, transform .04s, box-shadow .14s;
    }
    .op-pill:hover { border-color: var(--line-2); box-shadow: var(--shadow-sm); }
    .op-pill:active { transform: translateY(1px); }
    .op-pill-circle {
      display: flex; align-items: center; justify-content: center;
      width: 32px; height: 32px; border-radius: 999px;
      background: var(--surface-2); color: var(--ink-2);
      font-family: var(--font-mono); font-size: 11px; font-weight: 700; letter-spacing: 0.02em;
    }
    /* Pill activo (filtro de Tenencias por tipo, ver .op-cart-filter): mismo
       patrón "flota" que .op-rango-pill.on/.op-cur-pill.on — sombra +
       anillo interno --line-2, sin color por tipo (ui-kit §5.1: el color
       comunica dirección/resultado, no decora). */
    .op-pill.on { border-color: var(--line-2); box-shadow: var(--shadow-sm), inset 0 0 0 1px var(--line-2); }
    .op-pill.on .op-pill-circle { background: var(--ink); color: var(--surface); }

    /* Composición de la cartera por tipo de instrumento (ver PROMPT 7) —
       box chico en superficies neutras, % en mono, sin color por tipo. */
    .op-cart-comp-card { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; }
    .op-cart-comp-row { display: flex; flex-wrap: wrap; gap: 8px; }
    .op-cart-comp-chip {
      display: inline-flex; align-items: baseline; gap: 5px;
      padding: 5px 10px; border-radius: var(--r-sm); border: 1px solid var(--line); background: var(--surface-2);
    }
    .op-cart-comp-pct { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--ink); }
    .op-cart-comp-lbl { font-size: 11.5px; color: var(--ink-2); }

    /* Cards genéricas */
    .op-card {
      border: 1px solid var(--line); border-radius: var(--r-lg);
      background: var(--surface); box-shadow: var(--shadow-sm); padding: 14px 16px;
    }
    .op-card h3 {
      margin: 0 0 12px; font-family: var(--font-display); font-size: 14px; font-weight: 700; color: var(--ink);
    }

    /* Dólares — 3 columnas divididas (label arriba, valor mono debajo) */
    .op-dolares-row { display: flex; }
    .op-dollar-item {
      flex: 1; display: flex; flex-direction: column; gap: 3px;
      padding: 0 16px; border-right: 1px solid var(--line);
    }
    .op-dollar-item:first-child { padding-left: 0; }
    .op-dollar-item:last-child { border-right: 0; padding-right: 0; }
    .od-lbl { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-3); }
    .od-val { font-size: 16px; font-weight: 600; color: var(--ink); }

    .op-resumen-val, .op-resumen-prof .rp-val { font-family: var(--font-mono); font-size: 22px; font-weight: 700; color: var(--ink); }
    .op-resumen-val.pos, .op-resumen-prof.pos .rp-val { color: var(--pos-strong); }
    .op-resumen-val.neg, .op-resumen-prof.neg .rp-val { color: var(--neg-strong); }
    .op-resumen-pct { font-size: 12.5px; color: var(--ink-3); }
    .op-resumen-prof { display: inline-block; padding: 4px 10px; border-radius: var(--r); }
    .op-resumen-prof.pos { background: var(--pos-bg); box-shadow: inset 3px 0 0 var(--pos); }
    .op-resumen-prof.neg { background: var(--neg-bg); box-shadow: inset 3px 0 0 var(--neg); }

    .op-subtab.sell { border-color: var(--warn-line); color: var(--warn-strong); background: var(--warn-bg); }
    .ori-chip.accent { background: var(--accent-sf); border-color: var(--accent); color: var(--accent-2); }

    /* Tenencias/Movimientos en mobile: cards en vez de tabla (ver .op-cartera-table
       más abajo), mismo patrón que .mobile-cards/.sector-card de cedears-heatmap.component.ts. */
    .op-mobile-cards { display: none; flex-direction: column; gap: 10px; }

    /* Cards de Tenencias/Movimientos: layout en columna con gap regular
       (misma separación que .op-movers-grid/.op-fondos-grid). op-id-row
       hace wrap propio (flex-wrap + gap) en vez de depender de espacios en
       blanco entre tags del template — con preserveWhitespaces:false (default
       de Angular) esos nodos de texto se eliminan, así que symbol+chips
       quedaban pegados sin punto de corte y desbordaban la card en anchos
       angostos; esa era la causa real del scroll horizontal. */
    .op-cart-card { display: flex; flex-direction: column; gap: 10px; }
    .op-id-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
    .op-cart-top { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
    .op-cart-status { align-self: flex-start; }
    .op-cart-delta {
      display: inline-flex; flex-direction: column; gap: 2px; align-self: flex-start;
      padding: 6px 12px; border-radius: var(--r); border: 1px solid var(--line); background: var(--surface-2);
    }
    .op-cart-delta-val { font-family: var(--font-mono); font-size: 17px; font-weight: 700; color: var(--ink); }
    .op-cart-delta.pos { background: var(--pos-bg); border-color: var(--pos-line); }
    .op-cart-delta.pos .op-cart-delta-val { color: var(--pos-strong); }
    .op-cart-delta.neg { background: var(--neg-bg); border-color: var(--neg-line); }
    .op-cart-delta.neg .op-cart-delta-val { color: var(--neg-strong); }

    /* Acciones — 2 columnas INDEPENDIENTES (pedido de Elio), mismo mecanismo
       de grilla que .mosaic de cotizaciones.component.css (grid de N
       columnas + gap). Cada .op-acciones-col agrupa su propio dropdown +
       tabla/cards — antes esta grilla contenía 2 .op-table-wrap directas
       (mismo instrumento global); ahora cada columna es independiente. */
    .op-acciones-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
    .op-acciones-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
    /* Dropdown custom de instrumento de cada columna (reemplaza el <select>
       nativo, que no permite estilar el menú de opciones de forma
       consistente entre navegadores): botón fit-content con flecha pegada
       al texto + menú flotante propio (<ul>/<li>), mismo radio --r-sm en
       botón y menú, hover/active en negro con texto blanco (pedido de UI). */
    .op-dropdown { position: relative; align-self: flex-start; }
    .op-dropdown-btn {
      display: inline-flex; align-items: center; gap: 8px; width: fit-content;
      height: 40px; padding: 0 12px; border: 1px solid var(--line); border-radius: var(--r-sm);
      background: var(--surface); color: var(--ink); font-family: var(--font-ui);
      font-size: 14px; font-weight: 600; cursor: pointer; outline: none;
      transition: border-color .12s, box-shadow .12s;
    }
    .op-dropdown-btn:hover { border-color: var(--line-2); }
    .op-dropdown.open .op-dropdown-btn { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-sf); }
    .op-dropdown-arrow { font-size: 10px; color: var(--ink-3); line-height: 1; }
    .op-dropdown-menu {
      position: absolute; z-index: 6; top: calc(100% + 4px); left: 0; min-width: 100%;
      margin: 0; padding: 4px; list-style: none;
      border: 1px solid var(--line); border-radius: var(--r-sm);
      background: var(--surface); box-shadow: var(--shadow);
    }
    .op-dropdown-option {
      padding: 8px 12px; border-radius: var(--r-sm); white-space: nowrap;
      font-family: var(--font-ui); font-size: 13.5px; font-weight: 600; color: var(--ink);
      cursor: pointer; transition: background .1s, color .1s;
    }
    .op-dropdown-option:hover,
    .op-dropdown-option:active,
    .op-dropdown-option.selected {
      background: #000; color: #fff;
    }

    /* Sección de 2 columnas de Ficha (rango+gráfico / Puntas) — mismo
       mecanismo de grilla que .op-home-mosaic/.op-home-col de arriba, que a
       su vez replica .mosaic/.col de cotizaciones.component.css: grid de 2
       columnas iguales + gap 14px, align-items:start para que cada columna
       mida su propio contenido. Mismo breakpoint ≤1000px que Home (ver
       @media más abajo). */
    .op-ficha-mosaic { display: grid; grid-template-columns: repeat(2, 1fr); align-items: start; gap: 14px; max-width: 100%; }
    .op-ficha-col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }

    /* Ticket — Puntas + Orden en 2 columnas, mismo mecanismo que
       .op-home-mosaic/.op-ficha-mosaic: grid de 2 columnas iguales + gap
       14px. align-items:stretch (default, sin declarar acá) en vez de
       :start — con :start cada card mide su propio contenido y Puntas
       (2 cajas Compra/Venta) queda más baja que Orden (Precio/Plazo +
       Cantidad/Monto); con stretch (default) ambas cards ocupan la altura
       de fila del grid (la más alta = Orden), lo que le da a op-card.op-book
       una altura real de la que .op-book-row-stacked puede tomar el 100%
       (ver .op-card.op-book/.op-book-row-stacked/.ob-side más abajo) para
       que Compra/Venta repartan ese alto en partes iguales. Clase propia
       (no se reusa .op-ficha-mosaic) porque son subvistas distintas y el
       alcance pide no tocar Ficha. Colapsa a 1 columna en el mismo
       breakpoint ≤1000px que el resto de los mosaicos (ver @media más
       abajo) — ahí Puntas queda arriba y Orden abajo, con su alto natural
       (la cadena stretch/100% de abajo no se activa fuera del grid). */
    .op-ticket-mosaic { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; max-width: 100%; }

    /* Gráfico histórico del Ticket (pantalla de compra): misma pieza que
       usa Ficha (.op-rango-pills + .fc-wrap, estilos más abajo), sólo se
       agrega el espaciado interno de card + separación respecto del grid
       de Puntas/Orden que va debajo. */
    .op-chart-card { display: flex; flex-direction: column; gap: 12px; margin-bottom: 14px; }

    /* Acciones en mobile: cards apiladas en vez de las tablas de 4 columnas
       (Símbolo/Precio/Variación/Comprar no entran en ≤760px — mismo .op-table-wrap
       que usa Panel, así que en vez de tocar esa clase compartida se oculta
       .op-acciones-grid entera y se muestra esta lista aparte). Mismo patrón
       visual de card que cedears-heatmap.component.ts (.sector-card): borde
       --line, radio --r-lg, fondo --surface. Round 2 (PROMPT 8): la v1 apilaba
       símbolo/precio/variación/botón en 4 renglones con labels propios y
       terminaba en cards de 150px+; acá precio+variación+botón comparten un
       solo renglón (símbolo arriba, todo lo demás abajo) para acercarse al
       ~doble de alto de una fila de tabla desktop. */
    .op-acciones-cards { display: none; flex-direction: column; gap: 6px; }
    .op-acc-card {
      display: flex; flex-direction: column; gap: 4px; text-align: left;
      padding: 8px 12px; border: 1px solid var(--line); border-radius: var(--r-lg);
      background: var(--surface); box-shadow: var(--shadow-sm); cursor: pointer;
    }
    .op-acc-id { display: flex; flex-direction: column; min-width: 0; }
    /* .opt-desc se oculta globalmente en mobile (ver .opt-desc{display:none}
       más abajo, breakpoint 760px) — acá se reactiva sólo dentro de esta card
       (selector de mayor especificidad), debajo del símbolo como en la tabla
       desktop, pero a una sola línea con ellipsis en vez de wrap libre. */
    .op-acc-id .opt-desc {
      display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
    }
    .op-acc-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
    .op-acc-price { font-family: var(--font-mono); font-size: 14px; font-weight: 600; color: var(--ink); }
    .op-acc-chip {
      display: inline-flex; align-items: center; height: 20px; padding: 0 7px;
      border-radius: var(--r-sm); font-size: 11px; font-weight: 700;
      background: var(--surface-2); color: var(--ink-3); border: 1px solid var(--line);
    }
    .op-acc-chip.pos { background: var(--pos-bg); border-color: var(--pos-line); color: var(--pos); }
    .op-acc-chip.neg { background: var(--neg-bg); border-color: var(--neg-line); color: var(--neg); }
    /* .op-acc-card entera es clickeable (ver template, comprarDirecto en el
       click del div) — la flecha sólo indica que la card es interactiva,
       ya no hay botón "Comprar" propio dentro de la card. */
    .op-acc-arrow { margin-left: auto; flex-shrink: 0; font-size: 15px; }

    /* "Ver todas las Acciones", sólo mobile (.op-acciones-cards ya oculta en
       desktop). Mismo patrón que .op-back/.op-empty-cta. */
    .op-acc-verall {
      height: 32px; margin-top: 2px; border: 1px solid var(--line); border-radius: var(--r-sm);
      background: var(--surface); color: var(--ink-2);
      font-family: var(--font-ui); font-size: 12.5px; font-weight: 600; cursor: pointer;
      transition: border-color .12s;
    }
    .op-acc-verall:hover { border-color: var(--line-2); }
    .op-acc-verall:active { transform: translateY(1px); }

    /* Referencia — grilla de 2 columnas (AL30 + Caución en la fila de
       arriba). Bleed horizontal a los bordes de la card (padding de
       .op-card en negativo) para que el hover llene la fila. */
    .op-ref-list { display: grid; grid-template-columns: repeat(2, 1fr); column-gap: 8px; margin: 0 -16px; }
    .op-ref-row {
      display: flex; align-items: center; gap: 10px; width: 100%;
      padding: 10px 16px; border: 0; border-bottom: 1px solid var(--line);
      background: transparent; cursor: pointer; text-align: left;
      font-family: var(--font-ui); color: var(--ink);
      transition: background .14s;
    }
    /* Plazo fijo (3ra fila, última): con sólo 3 filas en un grid de 2
       columnas, sin esto quedaba solo en la 2da fila ocupando 1 columna y
       dejando un hueco vacío a la derecha. grid-column:1/-1 lo estira a las
       2 columnas de esa fila sin afectar AL30/Caución (fila de arriba, que
       sigue en su columna 1fr normal). */
    .op-ref-row:last-child { border-bottom: 0; grid-column: 1 / -1; }
    /* Fix de espaciado (medido con getBoundingClientRect, ver historial):
       .orr-right tiene margin-left:auto para empujar valor+chip al borde
       derecho de SU fila — en AL30/Caución esa fila mide ~289px (1 columna),
       así que no se nota. Plazo fijo ocupa la fila COMPLETA (587px, ver
       grid-column:1/-1 arriba, necesario para no dejar hueco) y el mismo
       margin-left:auto ahí empujaba el valor hasta los 433px de x, lejísimos
       del label — terminaba alineado bajo el valor de Caución en vez de
       pegado a su propio label. Se pisa el auto con un gap fijo chico, igual
       de ajustado que el resto de las filas. */
    .op-ref-row:last-child .orr-right { margin-left: 12px; }
    .op-ref-row:hover { background: var(--accent-sf); }
    /* Caución/Plazo fijo (ver template op-ref-row-static): sin destino de
       navegación real, no deben parecer clickeables — sin cursor pointer ni
       hover de fondo (a diferencia de AL30, que sí navega a Ficha). */
    .op-ref-row-static { cursor: default; }
    .op-ref-row-static:hover { background: transparent; }
    .orr-lbl {
      font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
      color: var(--ink-3); flex-shrink: 0;
    }
    .orr-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
    .orr-val { font-size: 15px; font-weight: 600; color: var(--ink); }
    .orr-chevron { color: var(--ink-3); font-size: 15px; line-height: 1; flex-shrink: 0; }

    /* Hover propio (no el --accent-sf genérico de .op-mover:hover): el wash
       pos/neg es la jerarquía visual pedida, tapar todo con el wash de
       acento en hover la anularía — sólo se oscurece el borde. */
    .op-mover.op-mover-top:hover { border-color: var(--line); }
    .op-mover.op-mover-top .om-sym { font-size: 15px; }
    .op-mover.op-mover-top .om-px { font-size: 15px; font-weight: 600; }

    /* Fondos — grilla fija de 2 columnas */
    .op-fondos-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
    .op-fondo {
      display: flex; flex-direction: column; gap: 4px;
      padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--r);
    }
    .of-name { font-size: 13px; font-weight: 600; color: var(--ink); }
    .of-cat { font-size: 11px; color: var(--ink-3); }
    .of-detail { font-size: 12.5px; font-weight: 600; color: var(--ink-2); margin-top: 2px; }
    /* Todos los fondos reales traen variacionAnual con signo (ver FondoRow/
       api/iol/fondos.js) — a diferencia del hardcodeo anterior (donde sólo
       "Renta Variable" tenía signo y las otras 3 eran TNA sin P&L), acá el
       color por signo aplica a cualquier fondo según su valor real. Mismo
       par de tokens que usa .op-table-wrap td.num.pos/.neg (Panel) para el
       mismo significado. */
    .of-detail.pos { color: var(--pos); }
    .of-detail.neg { color: var(--neg); }

    /* Panel — header + buscador propio */
    .op-panel-head { display: flex; align-items: center; gap: 12px; }
    .op-panel-title { margin: 0; font-family: var(--font-display); font-size: 18px; font-weight: 700; color: var(--ink); }

    /* Panel — toolbar: pills de moneda + sub-tabs */
    .op-panel-toolbar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
    .op-cur-pills {
      display: inline-flex; gap: 2px; padding: 3px;
      border: 1px solid var(--line); border-radius: var(--r); background: var(--surface-2);
    }
    .op-cur-pill {
      height: 28px; padding: 0 12px; border: 0; border-radius: var(--r-sm);
      background: transparent; color: var(--ink-2);
      font-family: var(--font-ui); font-size: 12.5px; font-weight: 600; cursor: pointer;
      transition: background .14s, box-shadow .14s, color .14s;
    }
    .op-cur-pill.on { background: var(--surface); color: var(--ink); box-shadow: var(--shadow-sm); }
    .op-cur-pill:disabled { color: var(--ink-3); cursor: not-allowed; opacity: .55; }
    .op-cur-pill:not(:disabled):hover { color: var(--ink); }

    .op-subtabs { display: flex; gap: 4px; }
    .op-subtab {
      height: 32px; padding: 0 14px; border: 1px solid var(--line); border-radius: var(--r-sm);
      background: var(--surface); color: var(--ink-2); cursor: pointer;
      font-family: var(--font-ui); font-size: 12.5px; font-weight: 600;
      transition: border-color .14s, color .14s, background .14s;
    }
    .op-subtab.on { border-color: var(--accent); color: var(--accent-2); background: var(--accent-sf); }
    .op-subtab:hover:not(.on) { border-color: var(--line-2); }

    /* Panel — tabla Nombre/Precio/Variación. Mismo look visual que .table-wrap
       de app.css, reimplementado acá porque cada componente standalone tiene
       su propio CSS con view encapsulation (no hay forma de importar esas
       clases entre componentes) — mismo patrón que .tile-body table en
       cotizaciones.component.css. */
    .op-table-wrap {
      border: 1px solid var(--line); border-radius: var(--r-lg);
      overflow: auto; max-height: calc(100dvh - 320px); background: var(--surface);
    }
    .op-table-wrap table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    .op-table-wrap thead { position: sticky; top: 0; z-index: 2; }
    .op-table-wrap th {
      text-align: left; padding: 9px 12px; background: var(--surface-2);
      font-weight: 600; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em;
      color: var(--ink-3); border-bottom: 1px solid var(--line); white-space: nowrap;
      cursor: pointer; user-select: none; transition: color .12s;
    }
    .op-table-wrap th:hover { color: var(--ink); }
    .op-table-wrap th.sorted { color: var(--ink); }
    .op-table-wrap th.num, .op-table-wrap td.num { text-align: right; }
    .op-sort-arrow { font-size: 9px; color: var(--accent); margin-left: 3px; }
    .op-table-wrap td {
      padding: 7px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; color: var(--ink);
    }
    .op-table-wrap tbody tr { cursor: pointer; transition: background .12s; }
    .op-table-wrap tbody tr:last-child td { border-bottom: 0; }
    .op-table-wrap tbody tr:nth-child(even) td { background: var(--surface-2); }
    .op-table-wrap tbody tr:hover td { background: var(--accent-sf); }
    .op-table-wrap td.num.pos { color: var(--pos); font-weight: 600; }
    .op-table-wrap td.num.neg { color: var(--neg); font-weight: 600; }

    /* Columna de acción de las tablas (Panel y Acciones de Home): ya NO
       tiene un botón "Comprar" por fila — toda la fila es clickeable
       (.op-row-buy, ver template) y ejecuta la misma acción de compra
       directa que antes hacía el botón. Sólo queda una flecha sutil
       (.op-row-arrow) como indicador visual al final de la fila. */
    .op-th-accion { width: 1%; }
    .op-td-accion { white-space: nowrap; }
    .op-row-buy:hover td { background: var(--accent-sf); }
    .op-row-arrow {
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--ink-3); font-size: 16px; line-height: 1;
      transition: color .12s, transform .12s;
    }
    .op-row-buy:hover .op-row-arrow { color: var(--accent-2); transform: translateX(2px); }
    .opt-sym { font-family: var(--font-mono); font-weight: 600; }
    .opt-desc { display: block; font-size: 11px; font-weight: 400; color: var(--ink-3); font-family: var(--font-ui); }
    tr.op-buy td { background: var(--accent-sf); }
    tr.op-sell td { background: var(--warn-bg); }

    /* Ficha — header + precio protagonista */
    .op-ficha-head { display: flex; align-items: center; gap: 12px; }
    .op-ficha-id { display: flex; flex-direction: column; gap: 1px; }
    .fh-sym { font-family: var(--font-mono); font-size: 18px; font-weight: 700; color: var(--ink); }
    .fh-desc { font-size: 12px; color: var(--ink-3); }
    .op-ficha-price { display: flex; align-items: baseline; gap: 10px; }
    .fp-val { font-size: 30px; font-weight: 700; letter-spacing: -0.01em; color: var(--ink); }
    .fp-chip {
      display: inline-flex; align-items: center; height: 24px; padding: 0 9px;
      border-radius: var(--r-sm); font-family: var(--font-mono); font-size: 12.5px; font-weight: 700;
      background: var(--surface-2); color: var(--ink-3); border: 1px solid var(--line);
    }
    .fp-chip.pos { background: var(--pos-bg); border-color: var(--pos-line); color: var(--pos); }
    .fp-chip.neg { background: var(--neg-bg); border-color: var(--neg-line); color: var(--neg); }

    /* Ficha — selector de rango: mismo patrón .seg del ui-kit */
    .op-rango-pills {
      display: inline-flex; gap: 2px; padding: 3px; align-self: flex-start;
      border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface-2);
    }
    .op-rango-pill {
      height: 28px; min-width: 44px; padding: 0 10px; border: 0; border-radius: var(--r-sm);
      background: transparent; color: var(--ink-2);
      font-family: var(--font-mono); font-size: 12px; font-weight: 700; cursor: pointer;
      transition: color .12s, background .12s, box-shadow .12s;
    }
    .op-rango-pill:hover { color: var(--ink); }
    .op-rango-pill.on {
      background: var(--surface); color: var(--ink);
      box-shadow: var(--shadow-sm), inset 0 0 0 1px var(--line-2);
    }

    /* Ficha/Ticket — contenedor del gráfico: card con borde y radio, igual
       que tablas. */
    .fc-wrap {
      border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface);
      padding: 16px;
    }
    /* fc-row: plot (SVG + overlays de fecha/tooltip) a la izquierda, eje Y
       (precios) en columna angosta a la derecha — layout real en HTML/CSS,
       no dentro del SVG. */
    .fc-row { display: flex; align-items: stretch; gap: 0; }
    /* fc-plot: única superficie position:relative que comparten el SVG y
       los overlays HTML (.fc-x-label/.fc-tooltip) — todos anclados a ESTA
       caja con % (top/left), así que cuadran sin importar el aspect ratio
       real que termine teniendo el SVG en pantalla. padding-bottom reserva
       el renglón de las fechas debajo del plot; sin ese padding, las
       etiquetas absolutas (top:100%) quedarían pegadas al borde inferior
       de la card en vez de tener su propio renglón. */
    .fc-plot {
      position: relative; flex: 1; min-width: 0;
      height: 200px; padding-bottom: 22px; cursor: crosshair;
    }
    .fc-svg { position: absolute; top: 0; left: 0; width: 100%; height: calc(100% - 22px); display: block; }
    .fc-line { stroke-width: 2; }
    .fc-line.pos { stroke: #059669; }
    .fc-line.neg { stroke: var(--neg); }
    /* fc-area: <path> con fill="url(#fcAreaGrad…)" seteado inline desde el
       template (ver chartLayout().areaPath + linearGradient en <defs>) —
       degradado verde/rojo a transparente, sin opacidad plana por CSS. El
       FIX real del "bloque sólido" no es esta regla: es que el atributo
       "d" del path ahora baja a la base DESPUÉS de recorrer toda la curva
       punto a punto (ver comentario en chartLayout()), en vez de cerrar
       con una diagonal directa que dejaba mal definida el área rellenada. */
    .fc-area { stroke: none; }

    /* Gridlines horizontales sutiles (eje Y) — punteadas, no compiten
       visualmente con la curva. Sin texto: la marca de precio vive en el
       overlay .fc-axis-y de al lado (ver template), nunca en un <text> del
       SVG (con preserveAspectRatio="none" el texto se deforma al estirar). */
    .fc-grid-line { stroke: #f3f4f6; stroke-width: 1; stroke-dasharray: 4 4; }

    /* Eje Y (precios): columna angosta a la derecha del plot, cada label
       posicionado en top:% (mismo % que su gridline, ver gridLines().yPct)
       — position:absolute dentro de esta columna, nunca dentro del SVG. */
    .fc-axis-y { position: relative; flex: 0 0 auto; width: 52px; height: 200px; }
    .fc-axis-y-label {
      position: absolute; left: 6px; transform: translateY(-50%);
      font-family: var(--font-mono); font-size: 10px; color: var(--ink-3); white-space: nowrap;
    }

    /* Eje X (fechas): overlay HTML debajo del plot (dentro de fc-plot,
       top:100% = el padding-bottom reservado arriba) — cada label
       centrado en su left:%, nunca dentro del SVG. */
    .fc-x-label {
      position: absolute; top: 100%; margin-top: 4px; transform: translateX(-50%);
      font-family: var(--font-ui); font-size: 10px; color: var(--ink-3); white-space: nowrap;
    }

    /* Crosshair vertical + punto sobre la curva — el trazo usa
       vector-effect="non-scaling-stroke" (ver template) para no deformarse
       con el stretch no uniforme del viewBox. */
    .fc-crosshair-x { stroke: var(--ink-3); stroke-width: 1; stroke-dasharray: 3 3; pointer-events: none; }
    .fc-crosshair-dot { stroke: var(--surface); stroke-width: 1.5; pointer-events: none; }
    .fc-crosshair-dot.pos { fill: #059669; }
    .fc-crosshair-dot.neg { fill: var(--neg); }

    /* Tooltip flotante del crosshair: overlay HTML dentro de fc-plot,
       sigue al mouse en X (left:%, ver chartHoverXPct() en el component) —
       tipografía real, nunca deformada. */
    .fc-tooltip {
      position: absolute; top: 8px; z-index: 2;
      display: flex; flex-direction: column; gap: 1px;
      padding: 5px 9px; border-radius: var(--r-sm);
      background: var(--ink); color: var(--surface);
      font-size: 11px; line-height: 1.3; white-space: nowrap;
      transform: translateX(-50%); pointer-events: none;
      box-shadow: var(--shadow-sm);
    }
    .fc-tooltip-date { color: #cfcfd2; font-size: 10px; }
    .fc-tooltip-price { font-weight: 700; }

    @media (max-width: 480px) {
      /* Eje Y más angosto en mobile — los precios suelen ser cortos y el
         plot necesita todo el ancho posible en pantallas chicas. */
      .fc-axis-y { width: 40px; }
    }

    /* Ficha — mini-libro de puntas, colapsable */
    .op-book-toggle {
      display: flex; align-items: center; justify-content: space-between; width: 100%;
      border: 0; background: transparent; padding: 0; margin: 0 0 12px; cursor: pointer;
    }
    .op-book-toggle h3 { margin: 0; }
    .ob-title-wrap { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; }
    .ob-title-wrap h3 { margin: 0; }
    .op-book-toggle .ob-title-wrap { margin: 0; }
    .ob-chevron { color: var(--ink-3); font-size: 16px; transition: transform .16s cubic-bezier(.16,1,.3,1); }
    .ob-chevron.open { transform: rotate(90deg); }
    .op-book-row { display: flex; gap: 14px; }
    .ob-side {
      flex: 1; display: flex; flex-direction: column; gap: 4px;
      padding: 10px 12px; border-radius: var(--r); border: 1px solid var(--line);
    }
    /* Cadena de alturas para que Puntas (Ticket) llene exactamente el alto
       de Orden — SOLO afecta la instancia que combina op-card.op-book con
       la clase adicional op-book-fill (ver template); Ficha usa
       "op-card op-book" sin op-book-fill y queda con su height:auto de
       siempre, sin cambios.
       1) .op-card.op-book-fill: flex-column + height:100% — el grid padre
          (.op-ticket-mosaic, align-items:stretch por default) ya estira esta
          card a la altura de fila (igual a Orden); height:100% + flex-column
          hace que su contenido interno (título + fila de Compra/Venta) pueda
          repartirse ese alto en vez de quedarse en su alto natural.
       2) .op-book-row.op-book-row-stacked: flex:1 además de flex-direction:
          column (ya estaba) — toma el espacio restante de op-book-fill
          (descontado el título) para que sea ese contenedor, no el título,
          el que efectivamente mida el 100% repartible.
       3) .ob-side dentro de esa combinación: flex:1 1 0 (en vez del flex:1
          genérico de la regla de arriba, que sólo garantiza ancho igual en
          el layout lado-a-lado de Ficha) — con flex-basis:0 cada caja
          Compra/Venta arranca sin alto de contenido como base y crece en
          partes EXACTAMENTE iguales para llenar op-book-row-stacked. */
    .op-card.op-book-fill { display: flex; flex-direction: column; height: 100%; }
    .op-book-row.op-book-row-stacked { flex-direction: column; }
    .op-book-fill .op-book-row.op-book-row-stacked { flex: 1; }
    .op-book-fill .op-book-row.op-book-row-stacked > .ob-side { flex: 1 1 0; }
    .ob-buy { border-color: var(--accent-sf); background: var(--accent-sf); }
    .ob-sell { border-color: var(--warn-line); background: var(--warn-bg); }
    .ob-lbl { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-3); }
    .ob-px { font-size: 16px; font-weight: 700; color: var(--ink); }
    .ob-qty { font-size: 11.5px; color: var(--ink-2); }

    /* Ficha — botón sticky de compra (también lo usa Ticket) */
    .op-buy-sticky {
      position: sticky; bottom: 0; z-index: 3;
      width: 100%; height: 46px; margin-top: 4px;
      border: 0; border-radius: var(--r-sm);
      background: var(--accent); color: var(--surface);
      font-family: var(--font-ui); font-size: 14px; font-weight: 700; cursor: pointer;
      box-shadow: var(--shadow);
      transition: opacity .14s, transform .04s;
    }
    .op-buy-sticky:hover { opacity: .92; }
    .op-buy-sticky:active { transform: translateY(1px); }
    .op-buy-sticky:disabled { opacity: .5; cursor: not-allowed; box-shadow: none; }
    .op-buy-sticky:disabled:hover { opacity: .5; }
    .op-buy-sticky:disabled:active { transform: none; }
    /* Paso 1 del Ticket ("Revisar orden"): mismo botón pero menos pesado
       frente al resto de la card Orden — Ficha/Paso 2 conservan 46px. */
    .op-buy-sticky-sm { height: 42px; }

    /* Ticket — card "Orden" (Precio/Plazo/Cantidad/Monto/Revisar orden) */
    .op-order-body { display: flex; flex-direction: column; gap: 18px; }
    /* "Revisar orden" ahora vive dentro de op-order-body en vez de a lo
       ancho completo de la pantalla (ver template) — reusa .op-buy-sticky
       por el estilo visual (color, tipografía, radio), pero position:sticky
       ya no tiene sentido acá: haría que el botón se despegue del borde/
       fondo de la card op-order al hacer scroll y flote sobre el resto de
       la pantalla sin el marco de la card detrás, en vez de quedar como
       cierre visual del bloque (justo lo que se pidió evitar). static +
       margin-top:auto (op-order-body es flex-column) lo deja pegado al
       final de la card en flujo normal, sin escapar del contenedor. */
    .op-order-body > .op-buy-sticky { position: static; margin-top: auto; }

    /* Ticket — fila de 2 columnas reusada por Precio/Plazo de liquidación Y
       por Cantidad/Monto a invertir (misma .op-order-body, 2 filas
       .op-ticket-row seguidas): flex + gap 14px + flex-wrap, cada .op-field
       con min-width 140px. Al no forzarse un grid fijo, en anchos angostos
       (contenido de card por debajo de ~294px, dos columnas de 140px + gap)
       cada fila apila sus 2 campos en 1 columna sola, mismo comportamiento
       que ya tenía Precio/Plazo — no hace falta una media query nueva para
       el breakpoint mobile. */
    .op-ticket-row { display: flex; gap: 14px; flex-wrap: wrap; }
    .op-field { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 140px; }
    .of-lbl { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-3); }
    .op-select, .op-input {
      height: 40px; padding: 0 12px; border: 1px solid var(--line); border-radius: var(--r-sm);
      background: var(--surface); color: var(--ink); font-family: var(--font-ui); font-size: 14px; outline: none;
      transition: border-color .12s, box-shadow .12s;
    }
    .op-select:focus, .op-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-sf); }
    /* Menú desplegable (options) del <select> nativo: mismo radio que el
       botón (--r-sm) y hover/active en un azul suave (--accent-sf) en vez
       del azul fuerte "Highlight" que aplica el navegador por defecto. */
    .op-select option {
      border-radius: var(--r-sm);
      background: var(--surface);
      color: var(--ink);
    }
    .op-select option:hover,
    .op-select option:focus,
    .op-select option:checked {
      background: var(--accent-sf);
      color: var(--ink);
    }
    .op-input.num { font-family: var(--font-mono); }
    /* Monto a invertir — protagonista de la pantalla, mismo tratamiento que
       Panel usa para precios destacados (mono, bold, tamaño elevado). */
    .op-input-monto { height: 48px; font-size: 20px; font-weight: 700; }
    /* Fila de label del campo Monto: "Monto a invertir" a la izquierda,
       "Disponible" (o el aviso) a la derecha, misma línea de base — mismo
       patrón que .orr-lbl/.orr-right de Referencia (Home). */
    .of-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .of-hint { font-size: 11px; color: var(--ink-3); }
    .of-hint-warn { color: var(--warn); font-weight: 600; }

    /* Ticket — fila de Cantidad: el input manda (flex-grow), −/+ quedan
       como botones compactos de tamaño fijo al lado (ver docs/design-refs/compra2.png). */
    .op-stepper { display: flex; align-items: center; gap: 8px; }
    .op-step-input {
      flex: 1; min-width: 0; height: 40px; padding: 0 12px; text-align: left;
      border: 1px solid var(--line); border-radius: var(--r-sm);
      background: var(--surface); color: var(--ink);
      font-family: var(--font-mono); font-size: 15px; font-weight: 600; outline: none;
      transition: border-color .12s, box-shadow .12s;
    }
    .op-step-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-sf); }
    .op-step-btn {
      flex: 0 0 32px; width: 32px; height: 32px; border: 1px solid var(--line); border-radius: var(--r-sm);
      background: var(--surface); color: var(--ink); font-size: 16px; font-weight: 700; line-height: 1; cursor: pointer;
      transition: border-color .12s, transform .04s;
    }
    .op-step-btn:hover:not(:disabled) { border-color: var(--line-2); }
    .op-step-btn:active:not(:disabled) { transform: translateY(1px); }
    .op-step-btn:disabled { opacity: .5; cursor: not-allowed; }

    /* Ticket — resumen del Paso 2, mismo patrón visual de lista que Referencia
       (Home) pero sin comportamiento tappable (son filas de sólo lectura). */
    .op-summary-list { display: flex; flex-direction: column; margin: 0 -16px; }
    .op-summary-row {
      display: flex; align-items: center; gap: 10px; width: 100%;
      padding: 10px 16px; border-bottom: 1px solid var(--line);
    }
    .op-summary-row:last-child { border-bottom: 0; }

    .op-legal { margin: 0; font-size: 11.5px; color: var(--ink-3); line-height: 1.5; }

    /* Ticket — checkbox propio (ui-kit no define uno todavía) */
    .op-checkbox-row { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; padding: 4px 0; }
    .op-checkbox {
      appearance: none; -webkit-appearance: none;
      width: 18px; height: 18px; flex-shrink: 0; margin-top: 1px;
      border: 1px solid var(--line); border-radius: var(--r-sm);
      background: var(--surface); cursor: pointer; position: relative;
      transition: background .14s, border-color .14s;
    }
    .op-checkbox:hover { border-color: var(--line-2); }
    .op-checkbox:checked { background: var(--accent); border-color: var(--accent); }
    .op-checkbox:checked::after {
      content: ''; position: absolute; left: 5px; top: 1px;
      width: 5px; height: 9px;
      border: solid var(--surface); border-width: 0 2px 2px 0;
      transform: rotate(45deg);
    }
    .op-checkbox:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-sf); }
    .op-checkbox-row span { font-size: 13px; color: var(--ink-2); line-height: 1.4; }

    /* Banner familia warn: Ticket ("no habilitada") y Cartera ("simulados"). */
    .op-warn-banner {
      padding: 12px 16px; border: 1px solid var(--warn-line); border-left: 3px solid var(--warn);
      background: var(--warn-bg); border-radius: var(--r); color: var(--warn);
      font-size: 12.5px; line-height: 1.5;
    }
    .op-warn-banner p { margin: 0 0 8px; }
    .op-warn-banner-link {
      border: 0; background: transparent; padding: 0; margin: 0;
      font-family: var(--font-ui); font-size: 12.5px; font-weight: 700; color: var(--warn);
      cursor: pointer; text-decoration: underline;
    }

    /* op-home-head: buscador + toggles de instrumento + botón Cartera en una
       sola fila (pedido de Elio) — antes sólo tenía buscador+Cartera, los
       toggles vivían en su propia fila aparte más abajo. flex-wrap:wrap para
       que en anchos angostos (antes del breakpoint mobile explícito de
       abajo) los toggles puedan bajar de línea sin romper el buscador ni el
       botón Cartera, que se mantienen flex-shrink:0/flex:1 como ya estaban. */
    .op-home-head { display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap; }
    .op-home-head .op-search-wrap { flex: 0 1 260px; min-width: 0; order: 1; margin-right: auto; }
    .op-home-head .op-top-dolar { flex-shrink: 0; order: 2; }
    .op-home-head .op-top-mover { flex-shrink: 0; order: 3; }
    .op-home-head .op-cartera-btn { order: 4; }
    .op-cartera-btn { flex-shrink: 0; position: relative; display: inline-flex; align-items: center; gap: 6px; height: 40px; }

    /* Widget compacto de Destacados, al lado del buscador (pedido de Elio,
       ocupa el espacio que dejaron los 5 toggles de instrumento) — mismo
       alto que .op-search (40px) para alinear en la fila. Una sola línea:
       label + símbolo + precio + variación + botón Comprar chico. Reusa
       .op-buy-row-btn (mismo botón "Comprar" del resto de la app) en vez de
       un botón nuevo. NO es la card .op-destacados completa (esa sigue
       intacta más abajo) — acá no entra el grid de 4 movers ni el padding
       de una .op-card, es un control de línea única. */
    .op-top-mover {
      display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 6px 0 12px;
      border: 1px solid var(--line); border-radius: var(--r);
      background: var(--surface);
    }
    .otm-lbl {
      font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-3);
      flex-shrink: 0;
    }
    .op-top-mover-body {
      display: flex; align-items: center; gap: 8px; min-width: 0;
      border: 0; background: transparent; padding: 0; cursor: pointer; text-align: left;
    }
    /* Transición de la rotación automática (ver rotatingMover/@for con track
       por symbol en el template): fade + slide sutil de entrada cada vez
       que Angular recrea el nodo al cambiar de mover. */
    .otm-fade-in { animation: otm-fade-in .32s cubic-bezier(.16,1,.3,1); }
    @keyframes otm-fade-in {
      from { opacity: 0; transform: translateY(2px); }
      to   { opacity: 1; transform: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .otm-fade-in { animation: none; }
    }
    .otm-sym { font-family: var(--font-mono); font-weight: 600; font-size: 13px; color: var(--ink); }
    .otm-px { font-size: 13px; color: var(--ink-2); }
    .otm-chip {
      display: inline-flex; align-items: center; height: 20px; padding: 0 7px;
      border-radius: var(--r-sm); font-family: var(--font-mono); font-size: 11px; font-weight: 700;
      background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-3);
    }
    /* Antes fija en .pos (topMover() sólo filtraba ganadores) — ahora el
       widget rota sobre destacados() completo, que puede incluir movers
       negativos (ordenado por variación ABSOLUTA), así que necesita ambas
       variantes semánticas, igual que .om-chip/.or-chip. */
    .otm-chip.pos { background: var(--pos-bg); border-color: var(--pos-line); color: var(--pos); }
    .otm-chip.neg { background: var(--neg-bg); border-color: var(--neg-line); color: var(--neg); }
    .op-top-mover-buy { flex-shrink: 0; height: 26px; }
    .op-top-mover-empty { padding: 0; font-size: 12px; }

    /* Panel de Dólar compacto de la barra superior, al lado de "Destacada"
       (ver .op-top-mover arriba) — misma altura (40px) para alinear en la
       fila. Reusa dolarStrip del component, piel propia en vez de la card
       .op-dolares completa. */
    .op-top-dolar {
      display: flex; align-items: center; gap: 12px; height: 40px; padding: 0 14px;
      border: 1px solid var(--line); border-radius: var(--r);
      background: var(--surface);
    }
    .otd-item { display: flex; align-items: baseline; gap: 5px; }
    .otd-lbl {
      font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-3);
    }
    .otd-val { font-size: 13px; font-weight: 600; color: var(--ink); }
    .op-cartera-badge {
      position: absolute; top: -6px; right: -6px; min-width: 16px; height: 16px; padding: 0 3px;
      background: var(--pos); color: var(--surface); font-size: 10px; font-weight: 700;
      line-height: 16px; text-align: center; border-radius: 99px;
    }

    .op-back, .op-empty-cta {
      height: 32px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface);
      color: var(--ink-2); font-family: var(--font-ui); font-size: 12.5px; font-weight: 600; cursor: pointer;
      transition: border-color .12s;
    }
    .op-back { align-self: flex-start; padding: 0 12px; margin-bottom: 4px; }
    .op-back:hover, .op-empty-cta:hover { border-color: var(--line-2); }
    .op-back:active { transform: translateY(1px); }
    .op-empty-cta { margin-top: 10px; padding: 0 14px; }
    .op-empty {
      display: flex; flex-direction: column; align-items: center;
      padding: 40px 20px; color: var(--ink-3); font-size: 13px; text-align: center;
      border: 1px dashed var(--line); border-radius: var(--r-lg); background: var(--surface);
    }

    /* Mismo breakpoint que .mosaic de cotizaciones.component.css (1000px). */
    @media (max-width: 1000px) {
      .op-ficha-mosaic { grid-template-columns: 1fr; }
      .op-ticket-mosaic { grid-template-columns: 1fr; }
    }

    @media (max-width: 760px) {
      /* op-home-head en 1 columna: buscador a ancho completo, luego widget de
         Destacados compacto, luego Cartera — en vez de la fila única de
         desktop, que en mobile (buscador flex-basis 220px + widget + botón
         Cartera) no entraría y forzaría wraps desprolijos a mitad de
         elemento. */
      .op-home-head { flex-direction: column; align-items: stretch; }
      .op-home-head .op-search-wrap { flex: 1 1 auto; max-width: none; }
      .op-search { max-width: none; }
      .op-top-mover { justify-content: space-between; }
      .op-top-dolar { justify-content: space-between; }
      .op-dolares-row { flex-direction: column; }
      .op-dollar-item { padding: 0; border-right: 0; border-bottom: 1px solid var(--line); }
      .op-dollar-item:not(:first-child) { padding-top: 8px; }
      .op-dollar-item:not(:last-child) { padding-bottom: 8px; }
      .op-dollar-item:last-child { border-bottom: 0; }
      /* Antes .op-acciones-grid se ocultaba entera y .op-acciones-cards (fuera
         del grid) se mostraba sola, con una única lista global. Ahora cada
         columna es independiente (dropdown propio, ver .op-acciones-col) y
         .op-acciones-cards vive DENTRO de esa columna/grid — ocultar el grid
         completo escondería también las cards (un padre display:none oculta
         a sus descendientes sin importar su propio display). Se apilan las
         2 columnas en 1 sola (mismo criterio que el resto de los mosaicos en
         este breakpoint) y, dentro de cada una, se alterna tabla↔cards. */
      .op-acciones-grid { grid-template-columns: 1fr; }
      /* Escopeado a .op-acciones-grid (no un .op-table-wrap global): esa
         misma clase la reusan Panel y Cartera/Movimientos (ver
         .op-cartera-table), que están fuera de alcance y no deben ocultarse. */
      .op-acciones-grid .op-table-wrap { display: none; }
      .op-acciones-cards { display: flex; }
      .op-ref-list { grid-template-columns: 1fr; }
      .op-ref-row { flex-wrap: wrap; }
      .op-fondos-grid { grid-template-columns: 1fr; }
      .op-result { grid-template-columns: 72px 1fr auto; }
      .or-desc { display: none; }
      .op-panel-toolbar { gap: 10px; }
      .opt-desc { display: none; }
      .op-cartera-table { display: none; }
      .op-mobile-cards { display: flex; }
    }
  `],
})
export class OperarComponent implements OnInit {
  private http = inject(HttpClient);
  private router = inject(Router);

  // Hidratación de estado por ruta (/operar/:ticker, ver app.routes.ts):
  // bindeados vía withComponentInputBinding (app.config.ts) desde el param
  // de ruta `ticker` y los query params `tipo`/`origin` — sin servicio de
  // navegación propio ni estado intermedio. Cualquier click en un activo o
  // en "Comprar" navega directo a esta ruta (ver goToOrder/comprarDirecto/
  // comprarMasDesdeCartera/venderDesdeCartera más abajo) y el effect
  // `hydrateFromRoute` monta directo la pantalla de orden (gráfico + Puntas
  // + formulario), sin pasar por Ficha ni por ningún resumen previo.
  ticker = input<string | null>(null);
  tipo = input<TicketTipoOperacion>('compra');
  origin = input<'ficha' | 'cartera' | 'panel' | 'home'>('home');

  pills: InstrumentPill[] = INSTRUMENT_PILLS;
  dolarStrip: DolarStripRow[] = DOLAR_STRIP;
  currencyPills = CURRENCY_PILLS;
  chartRangos = CHART_RANGOS;
  // Expuestos al template para el viewBox del gráfico (ver .fc-svg) — el
  // template no puede leer constantes de módulo directamente.
  chartW = CHART_W;
  chartH = CHART_H;
  // Rojo semántico para el gradiente del área en tramos negativos (--neg del
  // ui-kit resuelve a este mismo tono) — SVG <stop stop-color> no acepta
  // var(--custom-prop) en todos los navegadores, así que va hardcodeado acá,
  // igual que el verde #059669 pedido para la línea/área positiva.
  negColor = '#dc2626';

  subview = signal<OperarSubview>('home');
  selectedInstrumentId = signal<InstrumentId | null>(null);
  selectedSymbol = signal<string | null>(null);
  query = signal('');

  accionesRows = signal<PanelRow[]>([]);
  cedearsRows = signal<CedearRow[]>([]);
  bonosRows = signal<PanelRow[]>([]);
  letrasRows = signal<PanelRow[]>([]);
  // Fondos (FCI) — datos reales vía api/iol/fondos.js (ver loadFondos()).
  // Fetch propio (no entra en el forkJoin de loadHome porque es un endpoint
  // sin relación con acciones/cedears/bonos, y con manejo de error propio:
  // sin fallback real posible, ver template op-fondos). fondosLoading
  // arranca en true para mostrar "Cargando…" desde el primer render, no un
  // estado vacío falso antes de que la request termine.
  fondosRows = signal<FondoRow[]>([]);
  fondosLoading = signal(true);
  fondosError = signal(false);
  onsRows = signal<PanelRow[]>([]);
  // Panel de Acciones en US$ (mapea a /api/iol/panel?id=usa) — único caso con
  // fuente real fuera de AR$, ver docs/api-iol.md §3.1.
  usaRows = signal<PanelRow[]>([]);

  // Estado propio de la subvista Panel.
  panelQuery = signal('');
  panelCurrency = signal<CurrencyPillId>('ars');
  panelSubTab = signal<string>('lider');
  panelSort = signal<PanelSortState>({ column: 'symbol', dir: 'asc' });

  // Estado propio de la subvista Ficha.
  chartRango = signal<ChartRango>('1M');
  historicoData = signal<HistoricoPoint[]>([]);
  historicoLoading = signal(false);
  fichaBookOpen = signal(true);

  // Estado propio de la subvista Ticket — 100% UI, sin request a operatoria
  // (ver docs/api-iol.md §4; Elio pidió que quede hardcodeado hasta que IOL
  // habilite la API para la cuenta).
  tipoPrecioOpts = TICKET_TIPO_PRECIO;
  plazoOpts = TICKET_PLAZOS;
  ticketStep = signal<TicketStep>('form');
  ticketState = signal<TicketState>(this.defaultTicketState());
  ticketAccepted = signal(false);
  ticketBannerShown = signal(false);
  // Compra o venta (ver openTicket) y subvista desde la que se abrió el
  // Ticket, para saber a dónde volver con "← Volver" (goBackFromTicketForm).
  // 'panel'/'home' se agregan para el botón "Comprar" directo desde las
  // filas de Panel y de Home (Acciones/Destacados) — ver comprarDirecto.
  ticketTipo = signal<TicketTipoOperacion>('compra');
  ticketOrigin = signal<'ficha' | 'cartera' | 'panel' | 'home'>('ficha');

  // Estado propio de la subvista Cartera — simulación en localStorage, ver
  // operar-storage.ts y operar.types.ts §Cartera simulada.
  carteraTab = signal<'tenencias' | 'movimientos'>('tenencias');
  simulatedMovements = signal<SimulatedMovement[]>(loadMovements());
  // Symbol de Tenencias con las acciones "Comprar más"/"Vender" desplegadas.
  tenenciaExpandida = signal<string | null>(null);
  instrumentoLabel = INSTRUMENTO_CHIP_LABEL;

  // Filtro por tipo de instrumento de Tenencias — mismos pills que Home
  // (ver .op-pills/.op-pill), sólo se agrega 'todos' adelante. 'Todos' por
  // default (ver PROMPT 7). No afecta a Movimientos ni a la composición
  // (composicionCartera se calcula siempre sobre TODAS las tenencias).
  tenenciasFiltro = signal<InstrumentId | 'todos'>('todos');
  tenenciasFilterOptions: Array<{ id: InstrumentId | 'todos'; label: string; initials: string }> = [
    { id: 'todos', label: 'Todos', initials: 'TD' },
    ...INSTRUMENT_PILLS,
  ];
  tenenciasFiltradas = computed<TenenciaRow[]>(() => {
    const filtro = this.tenenciasFiltro();
    const all = this.tenencias();
    return filtro === 'todos' ? all : all.filter((t) => t.instrumento === filtro);
  });

  // Composición de la cartera por tipo de instrumento — % sobre el VALOR
  // actual de mercado (cantidad × precio actual, misma métrica que ya usa
  // el resumen de Cartera: Total invertido/Valor actual), no por cantidad
  // de posiciones. ASUNCIÓN A CONFIRMAR con Elio, ver reporte del PROMPT 7.
  // Siempre sobre tenencias() completas (ignora tenenciasFiltro) — el
  // widget muestra la composición real de TODA la cartera.
  composicionCartera = computed<{ instrumento: OperarInstrumento; label: string; pct: number }[]>(() => {
    const rows = this.tenencias();
    const total = rows.reduce((s, t) => s + t.valorActual, 0);
    if (total <= 0) return [];
    const porTipo = new Map<OperarInstrumento, number>();
    for (const t of rows) {
      porTipo.set(t.instrumento, (porTipo.get(t.instrumento) ?? 0) + t.valorActual);
    }
    return [...porTipo.entries()]
      .map(([instrumento, valor]) => ({ instrumento, label: this.instrumentoLabel[instrumento], pct: (valor / total) * 100 }))
      .sort((a, b) => b.pct - a.pct);
  });

  private homeLoaded = false;
  // Ids ya fetcheados en esta sesión del componente (letras/ons son lazy;
  // acciones/cedears/bonos ya vienen del prefetch de Home).
  private lazyFetched = new Set<'letras' | 'ons'>();
  private usaFetched = false;
  // Cache de serie histórica por symbol+rango — no se re-fetchea si ya se pidió.
  private historicoCache = new Map<string, HistoricoPoint[]>();
  private destroyRef = inject(DestroyRef);

  // Prefetch al entrar a Home; sólo una vez por sesión del componente (Panel/
  // Ficha/Ticket no tienen fetch propio todavía).
  private prefetchHome = effect(() => {
    if (this.subview() === 'home' && !this.homeLoaded) {
      this.homeLoaded = true;
      this.loadHome();
      this.loadFondos();
      // Si el instrumento persistido de alguna columna es Letras/ONs (ver
      // loadHomeColLeft/Right en operar-storage.ts), dispara su fetch lazy
      // ya mismo — antes esto sólo pasaba al hacer click en un toggle
      // (selectHomeInstrument), pero ahora la columna puede arrancar
      // directo en ese instrumento por la persistencia.
      this.ensurePanelData(this.homeInstrumentLeft());
      this.ensurePanelData(this.homeInstrumentRight());
      // Polling de refresco automático (pedido: Destacados "en tiempo
      // real"): re-corre loadHome() cada 20s mientras el componente esté
      // vivo, así accionesRows/cedearsRows/bonosRows se refrescan solos y
      // destacados()/topMover() (computed sobre esas signals) reflejan
      // precio/variación nuevos sin que el usuario haga nada. Limpieza vía
      // DestroyRef (equivalente a ngOnDestroy) para no dejar el timer
      // corriendo si el usuario navega fuera de Operar.
      timer(20_000, 20_000)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => this.loadHome());
    }
  });

  // Índice rotativo del widget compacto de Destacados (header, al lado del
  // buscador) — antes mostraba fijo topMover() (el mayor % de ganancia);
  // ahora rota entre TODOS los elementos de destacados() cada 4.5s. Se
  // alimenta de datos vivos: destacados() ya es un computed sobre
  // accionesRows/cedearsRows (refrescadas por el polling de arriba), así que
  // el elemento que se está mostrando en cada momento se actualiza solo si
  // cambia su precio/variación mientras está en pantalla — currentMoverIndex
  // sólo decide CUÁL mostrar, no clona el dato.
  currentMoverIndex = signal(0);
  private moverRotationPaused = signal(false);
  private moverRotation = timer(4_500, 4_500)
    .pipe(takeUntilDestroyed(this.destroyRef))
    .subscribe(() => {
      if (this.moverRotationPaused()) return;
      const n = this.destacados().length;
      if (!n) return;
      this.currentMoverIndex.update((i) => (i + 1) % n);
    });

  // Mover que muestra el widget rotativo del header: clamp por si
  // destacados() cambió de tamaño (ej. de 5 a menos) entre rotaciones.
  rotatingMover = computed<MoverRow | null>(() => {
    const list = this.destacados();
    if (!list.length) return null;
    const idx = this.currentMoverIndex() % list.length;
    return list[idx];
  });
  // Envoltorio en array de 0/1 para poder usar @for+track en el template
  // (ver comentario en el template) — necesario para que el fade se
  // reproduzca en cada rotación en vez de quedar estático.
  rotatingMoverList = computed<MoverRow[]>(() => {
    const m = this.rotatingMover();
    return m ? [m] : [];
  });

  pauseMoverRotation() {
    this.moverRotationPaused.set(true);
  }

  resumeMoverRotation() {
    this.moverRotationPaused.set(false);
  }

  // Fetch de la serie histórica al entrar a Ficha O al Ticket (pantalla de
  // compra, con Puntas+Orden — ver template) o al cambiar de rango
  // (cacheado por symbol+rango en loadHistorico, ver más abajo). El Ticket
  // también muestra el gráfico (ver .op-chart-card en el template de
  // 'ticket'), así que necesita la misma data que Ficha.
  private fichaFetch = effect(() => {
    const sym = this.selectedSymbol();
    const rango = this.chartRango();
    const view = this.subview();
    if ((view !== 'ficha' && view !== 'ticket') || !sym) return;
    this.loadHistorico(sym, rango);
  });

  // Hidratación directa desde /operar/:ticker (ver ticker/tipo/origin input()
  // arriba): cuando el param de ruta cambia (navegación por URL, back/forward,
  // o refresh de página), monta la pantalla de orden (Ticket: gráfico +
  // Puntas + formulario) para ESE símbolo sin pasar por Home/Panel/Ficha —
  // mismo estado que dejaría openTicket(), pero disparado por la ruta en vez
  // de por un click ya procesado en memoria. Bypassea cualquier vista
  // intermedia: no hay modal ni resumen previo entre el click y esta pantalla.
  private hydrateFromRoute = effect(() => {
    const t = this.ticker();
    if (!t) return;
    const symbol = decodeURIComponent(t).toUpperCase();
    if (this.selectedSymbol() === symbol && this.subview() === 'ticket') return;
    this.openTicket(this.tipo(), symbol, this.origin());
  });

  searchResults = computed<PanelRow[]>(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return [];
    const all: PanelRow[] = [...this.accionesRows(), ...this.cedearsRows()];
    return all
      .filter((r) => String(r.symbol ?? '').toLowerCase().includes(q) || String(r.desc ?? '').toLowerCase().includes(q))
      .slice(0, 8);
  });

  // Panel de Acciones (primer contenedor de Home): 2 columnas INDEPENDIENTES
  // (pedido de Elio, reemplaza el toggle global único que tenían antes) —
  // cada columna elige su propio tipo de instrumento vía dropdown y persiste
  // esa elección en localStorage (ver operar-storage.ts), mismo patrón que
  // market-hours.config.ts. Reusa exactamente la misma fuente cacheada que
  // ya lee panelRawRows para Panel — nada de fetch/datos nuevos, sólo lee
  // accionesRows/cedearsRows/bonosRows/letrasRows/onsRows según el
  // instrumento elegido en cada columna.
  homeInstrumentLeft = signal<InstrumentId>(loadHomeColLeft() ?? 'acciones');
  homeInstrumentRight = signal<InstrumentId>(loadHomeColRight() ?? 'cedears');
  homeInstrumentLabelLeft = computed<string>(() => this.pills.find((p) => p.id === this.homeInstrumentLeft())?.label ?? '');
  homeInstrumentLabelRight = computed<string>(() => this.pills.find((p) => p.id === this.homeInstrumentRight())?.label ?? '');

  // Dropdown custom de instrumento (reemplaza el <select> nativo, ver
  // .op-dropdown en el template): abre/cierra por click en el botón, se
  // cierra al elegir una opción o al clickear afuera (ver onDocumentClick,
  // registrado una sola vez en el constructor).
  dropdownOpenLeft = signal(false);
  dropdownOpenRight = signal(false);

  toggleDropdownLeft(ev: Event) {
    ev.stopPropagation();
    this.dropdownOpenRight.set(false);
    this.dropdownOpenLeft.set(!this.dropdownOpenLeft());
  }

  toggleDropdownRight(ev: Event) {
    ev.stopPropagation();
    this.dropdownOpenLeft.set(false);
    this.dropdownOpenRight.set(!this.dropdownOpenRight());
  }

  pickHomeInstrumentLeft(id: InstrumentId) {
    this.selectHomeInstrumentLeft(id);
    this.dropdownOpenLeft.set(false);
  }

  pickHomeInstrumentRight(id: InstrumentId) {
    this.selectHomeInstrumentRight(id);
    this.dropdownOpenRight.set(false);
  }

  private rowsForInstrument(id: InstrumentId): PanelRow[] {
    const rows: PanelRow[] = id === 'cedears' ? this.cedearsRows() : (
      id === 'bonos' ? this.bonosRows() :
      id === 'letras' ? this.letrasRows() :
      id === 'ons' ? this.onsRows() :
      this.accionesRows()
    );
    return [...rows].sort((a, b) => String(a.symbol ?? '').localeCompare(String(b.symbol ?? '')));
  }

  // Cada columna ahora es la lista COMPLETA de su propio instrumento (ya no
  // es una mitad alfabética de una única lista global, ver comentario de
  // arriba) — mismo orden alfabético que antes.
  homeRowsLeft = computed<PanelRow[]>(() => this.rowsForInstrument(this.homeInstrumentLeft()));
  homeRowsRight = computed<PanelRow[]>(() => this.rowsForInstrument(this.homeInstrumentRight()));
  // Preview mobile (PROMPT 9), ahora por columna: primeras 8 de cada
  // instrumento independiente. Sólo se usa en .op-acciones-cards (≤760px);
  // el desktop sigue mostrando homeRowsLeft/homeRowsRight completas.
  homePreviewMobileLeft = computed<PanelRow[]>(() => this.homeRowsLeft().slice(0, 8));
  homePreviewMobileRight = computed<PanelRow[]>(() => this.homeRowsRight().slice(0, 8));

  // Top 5 movers por variación absoluta, 100% real sobre acciones+cedears
  // cacheados. Antes eran 4 (1 destacado grande + 3 chicos en grid de 2
  // columnas): el 3ro quedaba solo en su fila, dejando un hueco vacío al
  // lado — con 5 (1 grande + 4 chicos) el grid de 2x2 de los chicos cierra
  // sin huecos (ver .op-mover-top ocupando la fila completa en el template).
  destacados = computed<MoverRow[]>(() => {
    const all: PanelRow[] = [...this.accionesRows(), ...this.cedearsRows()];
    return [...all]
      .filter((r) => r?.symbol)
      .sort((a, b) => Math.abs(b.pct_change || 0) - Math.abs(a.pct_change || 0))
      .slice(0, 5)
      .map((r) => ({ symbol: r.symbol, price: this.price(r), pctChange: r.pct_change || 0 }));
  });

  // Widget compacto nuevo, al lado del buscador (reemplaza el espacio que
  // ocupaban los 5 toggles de instrumento): la acción/cedear con MAYOR % de
  // ganancia en tiempo real. Reusa la misma fuente/orden que destacados() en
  // vez de reinventar el cálculo — a diferencia de destacados() (top 4 por
  // variación ABSOLUTA, mezcla ganancias y pérdidas), acá se filtra sólo
  // pct_change positivo y se ordena descendente para quedarnos con el mayor
  // ganador real del momento.
  topMover = computed<MoverRow | null>(() => {
    const all: PanelRow[] = [...this.accionesRows(), ...this.cedearsRows()];
    const ganadores = all
      .filter((r) => r?.symbol && (r.pct_change || 0) > 0)
      .sort((a, b) => (b.pct_change || 0) - (a.pct_change || 0));
    const top = ganadores[0];
    return top ? { symbol: top.symbol, price: this.price(top), pctChange: top.pct_change || 0 } : null;
  });

  selectedInstrumentLabel = computed<string>(() => {
    const id = this.selectedInstrumentId();
    return this.pills.find((p) => p.id === id)?.label ?? '';
  });

  // Sub-tabs por instrumento. Heurística simple (ver panelFilteredRows);
  // Cedears/Letras/ONs no tienen sub-tab todavía → tabla directa.
  panelSubTabs = computed<PanelSubTabDef[]>(() => {
    const id = this.selectedInstrumentId();
    if (id === 'acciones') return [{ id: 'lider', label: 'Panel líder' }, { id: 'general', label: 'Panel general' }];
    if (id === 'bonos') return [{ id: 'usd', label: 'Soberanos US$' }, { id: 'ars', label: 'Soberanos AR$' }];
    return [];
  });

  // Filas crudas del instrumento+moneda elegidos, reusando los signals ya
  // cacheados (Home o el fetch lazy de letras/ons/usa — nunca se re-fetchea).
  panelRawRows = computed<PanelRow[]>(() => {
    const id = this.selectedInstrumentId();
    if (!id) return [];
    if (id === 'acciones' && this.panelCurrency() === 'usd') return this.usaRows();
    switch (id) {
      case 'acciones': return this.accionesRows();
      case 'cedears': return this.cedearsRows();
      case 'bonos': return this.bonosRows();
      case 'letras': return this.letrasRows();
      case 'ons': return this.onsRows();
      default: return [];
    }
  });

  isGeneralEmpty = computed<boolean>(() =>
    this.selectedInstrumentId() === 'acciones' && this.panelSubTab() === 'general'
  );

  // Aplica sub-tab (heurística de prefijo/sufijo de símbolo) + buscador propio de Panel.
  panelFilteredRows = computed<PanelRow[]>(() => {
    let rows = this.panelRawRows();
    const id = this.selectedInstrumentId();
    const sub = this.panelSubTab();
    if (id === 'acciones') {
      // "Panel general" es placeholder vacío por ahora (ver isGeneralEmpty / TODO en template).
      if (sub === 'general') rows = [];
    } else if (id === 'bonos') {
      // Heurística: símbolos que terminan en D son la pata en dólares (soberanos US$).
      rows = rows.filter((r) => (String(r.symbol ?? '').endsWith('D') ? sub === 'usd' : sub === 'ars'));
    }
    const q = this.panelQuery().trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) =>
        String(r.symbol ?? '').toLowerCase().includes(q) || String(r.desc ?? '').toLowerCase().includes(q)
      );
    }
    return rows;
  });

  panelSortedRows = computed<PanelRow[]>(() => {
    const rows = [...this.panelFilteredRows()];
    const { column, dir } = this.panelSort();
    const mul = dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      if (column === 'symbol') return String(a.symbol ?? '').localeCompare(String(b.symbol ?? '')) * mul;
      if (column === 'price') return (this.price(a) - this.price(b)) * mul;
      return ((a.pct_change || 0) - (b.pct_change || 0)) * mul;
    });
    return rows;
  });

  // Fila cacheada del símbolo de Ficha, buscada en TODOS los paneles ya
  // fetcheados (Home + Panel) — sin refetch, dato real que ya tenemos en memoria.
  selectedRow = computed<PanelRow | null>(() => {
    const sym = this.selectedSymbol();
    return sym ? this.findCachedRow(sym) : null;
  });

  // Tenencias de Cartera: posición NETA por symbol (compras - ventas),
  // valuada contra el precio REAL cacheado (nunca el simulado) — fallback al
  // costo promedio con badge "estimado" si el símbolo no está en ningún
  // panel. costoPromedio es el costo ponderado de TODAS las compras
  // históricas (no se recalcula al vender, método estándar de costo
  // promedio); si la cantidad neta llega a 0 el symbol desaparece (sigue en
  // Movimientos, ver movimientosOrdenados).
  tenencias = computed<TenenciaRow[]>(() => {
    const bySymbol = new Map<string, SimulatedMovement[]>();
    for (const m of this.simulatedMovements()) {
      const list = bySymbol.get(m.symbol) ?? [];
      list.push(m);
      bySymbol.set(m.symbol, list);
    }
    const rows: TenenciaRow[] = [];
    for (const [symbol, movs] of bySymbol) {
      const compras = movs.filter((m) => m.tipo === 'compra');
      const cantidadCompras = compras.reduce((s, m) => s + m.cantidad, 0);
      const cantidadVentas = movs.filter((m) => m.tipo === 'venta').reduce((s, m) => s + m.cantidad, 0);
      const cantidadNeta = cantidadCompras - cantidadVentas;
      if (cantidadNeta <= 0) continue;
      const costoPromedio = cantidadCompras > 0 ? compras.reduce((s, m) => s + m.monto, 0) / cantidadCompras : 0;
      const row = this.findCachedRow(symbol);
      const precioActual = row ? this.price(row) : costoPromedio;
      rows.push({
        symbol,
        instrumento: movs[0].instrumento,
        cantidad: cantidadNeta,
        precioPromedio: costoPromedio,
        valorActual: cantidadNeta * precioActual,
        pnl: cantidadNeta * precioActual - costoPromedio * cantidadNeta,
        estimado: !row,
      });
    }
    return rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  });

  // Tope duro de Vender: cantidad neta actual en Tenencias del symbol del
  // Ticket. Infinity fuera de modo venta, para no ramificar el clamp en
  // setCantidad/incCantidad.
  maxVendible = computed<number>(() => {
    if (this.ticketTipo() !== 'venta') return Infinity;
    const symbol = this.selectedSymbol();
    if (!symbol) return 0;
    return this.tenencias().find((t) => t.symbol === symbol)?.cantidad ?? 0;
  });

  // Movimientos de Cartera, más reciente primero.
  movimientosOrdenados = computed<SimulatedMovement[]>(() =>
    [...this.simulatedMovements()].sort((a, b) => b.timestamp - a.timestamp)
  );

  // Header resumen de Cartera (3 números protagonistas, ver template). Total
  // invertido = costo de la posición NETA actual (costoPromedio × cantidad de
  // cada tenencia), no el bruto histórico de compras — una venta reduce este
  // número. Ganancia total = mismo cálculo que Tenencias (valor actual real -
  // costo de la posición). Variación de hoy = pct_change diario de cada panel
  // cacheado aplicado al valor actual de cada tenencia y sumado (0 para
  // símbolos "estimado", que no tienen pct_change real).
  resumenCartera = computed<{ totalInvertido: number; gananciaTotal: number; variacionHoy: number; variacionHoyPct: number }>(() => {
    const tenenciasList = this.tenencias();
    const totalInvertido = tenenciasList.reduce((s, t) => s + t.precioPromedio * t.cantidad, 0);
    const gananciaTotal = tenenciasList.reduce((s, t) => s + t.pnl, 0);
    let variacionHoy = 0;
    for (const t of tenenciasList) {
      const row = this.findCachedRow(t.symbol);
      if (row) variacionHoy += t.valorActual * ((row.pct_change || 0) / 100);
    }
    const valorActualTotal = tenenciasList.reduce((s, t) => s + t.valorActual, 0);
    const valorAyerTotal = valorActualTotal - variacionHoy;
    const variacionHoyPct = valorAyerTotal > 0 ? (variacionHoy / valorAyerTotal) * 100 : 0;
    return { totalInvertido, gananciaTotal, variacionHoy, variacionHoyPct };
  });

  chartIsPos = computed<boolean>(() => {
    const d = this.historicoData();
    if (d.length < 2) return true;
    return (+d[d.length - 1].ultimoPrecio || 0) >= (+d[0].ultimoPrecio || 0);
  });

  // Layout completo del gráfico: línea + área (<path> con comandos
  // explícitos, nunca <polygon>/<polyline>) y las posiciones (en %, para los
  // overlays HTML) de gridlines de precio (Y) y etiquetas de fecha (X).
  // viewBox fijo CHART_W x CHART_H (ver constantes arriba). IOL no trae un
  // campo "cierre" en la serie histórica: en una serie diaria, `ultimoPrecio`
  // de cada día ES el cierre de esa rueda (ver operar.types.ts).
  chartLayout = computed<ChartLayout | null>(() => {
    const d = this.historicoData();
    if (d.length < 2) return null;

    const x0 = CHART_PAD.left;
    const x1 = CHART_W - CHART_PAD.right;
    const y0 = CHART_PAD.top;
    const y1 = CHART_H - CHART_PAD.bottom;

    const closes = d.map((p) => +p.ultimoPrecio || 0);
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    // span nunca 0 (serie plana) para no dividir por cero; el padding
    // vertical real ya lo da CHART_PAD.top/bottom en píxeles del viewBox
    // (15% arriba/abajo, ver comentario de las constantes) — acá sólo se
    // normaliza el precio al 0..1 del área útil (y0..y1).
    const span = max - min || Math.max(max, 1) * 0.01;

    const stepX = (x1 - x0) / (d.length - 1);
    // BUG REAL de la versión anterior: `(+p.ultimoPrecio || 0 - min)` — por
    // precedencia de operadores en JS, `||` liga MÁS DÉBIL que `-`, así que
    // esto se evaluaba como `(+p.ultimoPrecio) || (0 - min)`. Con
    // ultimoPrecio truthy (cualquier precio > 0), el operando derecho del
    // `||` nunca se usaba y la resta "- min" quedaba completamente
    // descartada — el numerador terminaba siendo el precio CRUDO, no
    // "precio - min". Eso rompía la normalización: alturas gigantes/
    // negativas fuera de la ventana visible → línea aplastada contra un
    // borde (invisible) y el <path> del área, que sí llegaba a cerrar en
    // la base, terminaba pintando el rectángulo completo. Fix: paréntesis
    // explícitos, `(+p.ultimoPrecio || 0) - min`.
    const points: ChartPoint[] = d.map((p, i) => {
      const price = +p.ultimoPrecio || 0;
      return {
        x: x0 + i * stepX,
        y: y1 - ((price - min) / span) * (y1 - y0),
        price,
        dateIso: p.fechaHora,
      };
    });

    const linePath = points
      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(2)},${pt.y.toFixed(2)}`)
      .join(' ');
    // Área: sube por la curva (linePath) y SÓLO ahí baja verticalmente por
    // xN hasta la base (height), corre por la base hasta x0 y cierra (Z) —
    // nunca una diagonal directa del último punto al primero.
    const last = points[points.length - 1];
    const first = points[0];
    const areaPath =
      `M ${first.x.toFixed(2)},${CHART_H.toFixed(2)} ` +
      `${points.map((pt) => `L ${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(' ')} ` +
      `L ${last.x.toFixed(2)},${CHART_H.toFixed(2)} ` +
      `L ${first.x.toFixed(2)},${CHART_H.toFixed(2)} Z`;

    // Gridlines horizontales con marca de precio (overlay HTML, ver
    // .fc-axis-y en el template) — posición en % del alto del contenedor,
    // de max (arriba) a min (abajo).
    const gridLines: ChartGridLine[] = Array.from({ length: CHART_GRID_STEPS + 1 }, (_, i) => {
      const t = i / CHART_GRID_STEPS;
      const price = max - t * (max - min);
      const y = y0 + t * (y1 - y0);
      return { y, yPct: (y / CHART_H) * 100, label: this.fmt(price) };
    });

    // Etiquetas de fecha (overlay HTML, ver .fc-axis-x) repartidas por
    // índice — siempre incluye el primer y el último punto.
    const rango = this.chartRango();
    const n = Math.min(CHART_X_LABELS, points.length);
    const xLabels: ChartXLabel[] = Array.from({ length: n }, (_, i) => {
      const idx = n === 1 ? 0 : Math.round((i / (n - 1)) * (points.length - 1));
      const pt = points[idx];
      return { xPct: (pt.x / CHART_W) * 100, label: formatChartAxisDate(pt.dateIso, rango) };
    });

    return { linePath, areaPath, gridLines, xLabels, points, plot: { x0, x1, y0, y1 } };
  });

  // Crosshair (hover): punto más cercano al cursor sobre el eje X, con
  // fecha completa + precio exacto para el tooltip. null = mouse afuera del
  // gráfico (oculta crosshair/tooltip en el template).
  chartHover = signal<ChartPoint | null>(null);

  // `plot` es el div .fc-plot (mismo tamaño real que el SVG que contiene,
  // ver template) — se usa su getBoundingClientRect() en vez del <svg>
  // directamente para que el cálculo no dependa de cómo el navegador mida
  // internamente el SVG con preserveAspectRatio="none".
  onChartMove(ev: MouseEvent, plot: Element) {
    const layout = this.chartLayout();
    if (!layout || !layout.points.length) return;
    const rect = plot.getBoundingClientRect();
    // Mapea la posición del mouse (px reales del elemento) al espacio del
    // viewBox (CHART_W x CHART_H) — necesario porque el SVG se estira a un
    // ancho variable vía CSS (ver .fc-svg, width:100%). El crosshair/tooltip
    // se posicionan en % (chartHoverXPct), así que da igual el aspect ratio
    // real del elemento en pantalla.
    const relX = ((ev.clientX - rect.left) / rect.width) * CHART_W;
    let nearest = layout.points[0];
    let bestDist = Infinity;
    for (const pt of layout.points) {
      const dist = Math.abs(pt.x - relX);
      if (dist < bestDist) { bestDist = dist; nearest = pt; }
    }
    this.chartHover.set(nearest);
  }

  onChartLeave() {
    this.chartHover.set(null);
  }

  // Posición X del punto bajo el cursor, en % del ancho — usada tanto por
  // el crosshair SVG (convertido de vuelta a unidades de viewBox) como por
  // el tooltip HTML (left en %, ver template).
  chartHoverXPct(): number {
    const h = this.chartHover();
    return h ? (h.x / CHART_W) * 100 : 0;
  }

  chartHoverYPct(): number {
    const h = this.chartHover();
    return h ? (h.y / CHART_H) * 100 : 0;
  }

  // Etiqueta de fecha completa del punto bajo el crosshair, para el tooltip.
  chartHoverDateLabel(): string {
    const h = this.chartHover();
    return h ? formatChartTooltipDate(h.dateIso) : '';
  }

  // Precio efectivo del Paso 1: precio límite si el usuario eligió esa
  // modalidad; si no, el lado del libro que corresponde según la dirección:
  // comprar paga la punta Venta (px_ask), vender cobra la punta Compra
  // (px_bid) — con el fallback de último cierre si el libro está vacío (ver
  // bookAskPx/bookBidPx).
  precioEfectivo = computed<number>(() => {
    const s = this.ticketState();
    if (s.tipoPrecio === 'limite') return s.precioLimite ?? 0;
    return this.ticketTipo() === 'venta' ? this.bookBidPx(this.selectedRow()) : this.bookAskPx(this.selectedRow());
  });

  // El monto tipeado no alcanza para 1 nominal entero al precio efectivo:
  // se muestra un aviso en vez de dejar el monto en 0 silenciosamente.
  montoBelowMinimum = computed<boolean>(() => {
    const s = this.ticketState();
    const px = this.precioEfectivo();
    return !!s.monto && s.monto > 0 && px > 0 && Math.floor(s.monto / px) === 0;
  });

  // Monto estimado para el resumen del Paso 2: si el usuario cargó un monto
  // en el Paso 1 se respeta tal cual; si no, se estima cantidad × precio efectivo.
  montoEstimado = computed<number>(() => {
    const s = this.ticketState();
    if (s.monto && s.monto > 0) return s.monto;
    return s.cantidad * this.precioEfectivo();
  });

  ngOnInit() {
    // El prefetch corre desde el effect de arriba (subview() ya arranca en 'home').
  }

  // Cierra el dropdown custom de instrumento (ver .op-dropdown) al clickear
  // afuera — el toggle del botón hace stopPropagation, así que este listener
  // global sólo se dispara con clicks fuera del botón/menú.
  @HostListener('document:click')
  closeDropdowns() {
    if (this.dropdownOpenLeft()) this.dropdownOpenLeft.set(false);
    if (this.dropdownOpenRight()) this.dropdownOpenRight.set(false);
  }

  private defaultTicketState(): TicketState {
    return { tipoPrecio: 'mercado', precioLimite: null, plazo: 't1', cantidad: 0, monto: null };
  }

  private loadHome() {
    const acciones$ = this.http.get<PanelRow[]>('/api/iol/panel?id=acciones').pipe(
      catchError(() => of([] as PanelRow[]))
    );
    // CEDEARs: el panel de IOL no soporta id=cedears (ver docs/api-iol.md §3.1);
    // el libro real sale de api/iol/cedears.js (§3.2), mismo feed que usa Arbitraje.
    const cedears$ = this.http.get<CedearRow[]>(iolCedearsUrl('H24')).pipe(
      catchError(() => of([] as CedearRow[]))
    );
    const bonos$ = this.http.get<PanelRow[]>('/api/iol/panel?id=bonos').pipe(
      catchError(() => of([] as PanelRow[]))
    );
    forkJoin([acciones$, cedears$, bonos$]).subscribe(([acciones, cedears, bonos]) => {
      this.accionesRows.set(Array.isArray(acciones) ? acciones : []);
      this.cedearsRows.set(Array.isArray(cedears) ? cedears : []);
      this.bonosRows.set(Array.isArray(bonos) ? bonos : []);
    });
  }

  // Fondos (FCI): fetch propio, separado de loadHome() — sin fallback real
  // posible (data912 no cubre FCIs, ver comentario del template op-fondos),
  // así que un error acá se comunica con fondosError() en vez de dejar
  // fondosRows() vacío indistinguible de "todavía cargando" o "0 fondos".
  private loadFondos() {
    this.fondosLoading.set(true);
    this.fondosError.set(false);
    this.http.get<FondoRow[]>('/api/iol/fondos').pipe(
      catchError(() => of(null))
    ).subscribe((rows) => {
      this.fondosLoading.set(false);
      if (!Array.isArray(rows)) {
        this.fondosError.set(true);
        return;
      }
      this.fondosRows.set(rows);
    });
  }

  // Label legible del tipoFondo real de IOL (ver FONDO_TIPO_LABEL) — fallback
  // al valor crudo si aparece algún tipoFondo no mapeado todavía, en vez de
  // ocultarlo.
  fondoTipoLabel(tipoFondo: string | null): string {
    if (!tipoFondo) return '—';
    return FONDO_TIPO_LABEL[tipoFondo] ?? tipoFondo;
  }

  price(row: PanelRow | CedearRow | null | undefined): number {
    const px = +(row as any)?.px_bid;
    if (px > 0) return px;
    return +(row as any)?.c || 0;
  }

  // Busca un symbol en TODOS los paneles ya fetcheados (Home + Panel + Ficha
  // US$) — sin refetch, dato real que ya tenemos en memoria. Usado por Ficha
  // (selectedRow) y por Tenencias de Cartera para valuar al precio actual.
  private findCachedRow(symbol: string): PanelRow | null {
    const all: PanelRow[] = [
      ...this.accionesRows(), ...this.cedearsRows(), ...this.bonosRows(),
      ...this.letrasRows(), ...this.onsRows(), ...this.usaRows(),
    ];
    return all.find((r) => r.symbol === symbol) ?? null;
  }

  // Instrumento del symbol para un SimulatedMovement: usa el instrumento de
  // Panel si el Ticket se abrió navegando por una pill; si vino de la
  // búsqueda de Home (selectedInstrumentId sin setear) lo infiere buscando en
  // qué panel cacheado está el símbolo, con 'acciones' de última instancia.
  private inferInstrumento(symbol: string): OperarInstrumento {
    const id = this.selectedInstrumentId();
    if (id) return id;
    if (this.accionesRows().some((r) => r.symbol === symbol)) return 'acciones';
    if (this.cedearsRows().some((r) => r.symbol === symbol)) return 'cedears';
    if (this.bonosRows().some((r) => r.symbol === symbol)) return 'bonos';
    if (this.letrasRows().some((r) => r.symbol === symbol)) return 'letras';
    if (this.onsRows().some((r) => r.symbol === symbol)) return 'ons';
    return 'acciones';
  }

  // Libro sin puntas activas (mercado cerrado). Se usa para mostrar el
  // fallback de último cierre en el mini-libro en vez de "$0,00".
  bookIsEmpty(row: PanelRow | CedearRow | null | undefined): boolean {
    return (+(row as any)?.q_bid || 0) === 0 && (+(row as any)?.q_ask || 0) === 0;
  }

  lastClose(row: PanelRow | CedearRow | null | undefined): number {
    return +(row as any)?.c || 0;
  }

  bookBidPx(row: PanelRow | CedearRow | null | undefined): number {
    return this.bookIsEmpty(row) ? this.lastClose(row) : +(row as any)?.px_bid || 0;
  }

  bookAskPx(row: PanelRow | CedearRow | null | undefined): number {
    return this.bookIsEmpty(row) ? this.lastClose(row) : +(row as any)?.px_ask || 0;
  }

  selectInstrument(id: InstrumentId) {
    this.selectedInstrumentId.set(id);
    this.subview.set('panel');
    this.panelQuery.set('');
    this.panelCurrency.set('ars');
    this.panelSort.set({ column: 'symbol', dir: 'asc' });
    this.panelSubTab.set(id === 'bonos' ? 'usd' : 'lider');
    this.ensurePanelData(id);
  }

  // Dropdown de instrumento de cada columna del panel de Acciones (ver
  // homeRowsLeft/homeRowsRight, pedido de Elio): a diferencia de
  // selectInstrument() NO navega a Panel, cambia el instrumento mostrado en
  // esa columna sin salir de Home, y persiste la elección en localStorage
  // (ver operar-storage.ts) para que no se resetee al recargar. Reusa
  // ensurePanelData() para el mismo fetch lazy de Letras/ONs que ya usa
  // Panel (cacheado en lazyFetched, nunca se re-fetchea) — Acciones/Cedears/
  // Bonos ya vienen precargados por loadHome().
  selectHomeInstrumentLeft(id: InstrumentId) {
    this.homeInstrumentLeft.set(id);
    saveHomeColLeft(id);
    this.ensurePanelData(id);
  }

  selectHomeInstrumentRight(id: InstrumentId) {
    this.homeInstrumentRight.set(id);
    saveHomeColRight(id);
    this.ensurePanelData(id);
  }

  // Letras/ONs no vienen del prefetch de Home: fetch propio, una sola vez por
  // id (cacheado en lazyFetched). Acciones/Cedears/Bonos ya están cacheados
  // por loadHome() — no se re-fetchean acá.
  private ensurePanelData(id: InstrumentId) {
    if (id !== 'letras' && id !== 'ons') return;
    if (this.lazyFetched.has(id)) return;
    this.lazyFetched.add(id);
    this.http.get<PanelRow[]>(`/api/iol/panel?id=${id}`).pipe(
      catchError(() => of([] as PanelRow[]))
    ).subscribe((rows) => {
      const arr = Array.isArray(rows) ? rows : [];
      if (id === 'letras') this.letrasRows.set(arr);
      else this.onsRows.set(arr);
    });
  }

  isCurrencyDisabled(id: CurrencyPillId): boolean {
    if (id === 'usdc') return true; // sin panel real todavía
    if (id === 'usd') return this.selectedInstrumentId() !== 'acciones';
    return false;
  }

  selectCurrency(id: CurrencyPillId) {
    if (this.isCurrencyDisabled(id)) return;
    this.panelCurrency.set(id);
    if (id === 'usd') this.ensureUsaData();
  }

  private ensureUsaData() {
    if (this.usaFetched) return;
    this.usaFetched = true;
    this.http.get<PanelRow[]>('/api/iol/panel?id=usa').pipe(
      catchError(() => of([] as PanelRow[]))
    ).subscribe((rows) => this.usaRows.set(Array.isArray(rows) ? rows : []));
  }

  toggleSort(column: PanelSortColumn) {
    this.panelSort.update((s) => (s.column === column ? { column, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { column, dir: 'asc' }));
  }

  sortArrow(column: PanelSortColumn): string {
    const s = this.panelSort();
    if (s.column !== column) return '';
    return s.dir === 'asc' ? '▲' : '▼';
  }

  // REGLA 1 (bypass de vistas intermedias): clickear un activo en cualquier
  // listado (buscador, Destacados, Home, Panel) ya NO abre Ficha — navega
  // directo a /operar/{ticker}, que hidrata la pantalla de orden completa
  // (gráfico + Puntas + formulario, ver hydrateFromRoute arriba). Sin
  // resumen previo ni paso intermedio entre el click y la orden.
  selectSymbol(row: { symbol: string }) {
    this.goToOrder(row.symbol, 'compra', 'home');
  }

  // Navegación real por Router (REGLA 1/2 del refactor): el onClick invoca
  // directo la ruta de operación con el ticker por parámetro — Angular
  // Router hidrata OperarComponent vía withComponentInputBinding (ver
  // app.config.ts) y hydrateFromRoute monta el gráfico/Puntas/Orden ya
  // resueltos, sin pasar por ningún estado intermedio en memoria.
  private goToOrder(symbol: string, tipo: TicketTipoOperacion, origin: 'ficha' | 'cartera' | 'panel' | 'home') {
    this.router.navigate(['/operar', symbol], { queryParams: { tipo, origin } });
  }

  selectRango(r: ChartRango) {
    this.chartRango.set(r);
  }

  // Serie histórica (Ficha/Ticket): Cohen es la fuente PRIMARIA (get_trade_history
  // vía Primary/XOMS, ver docs/api-cohen.md §2/§5); si el feed de Cohen no
  // está configurado, falla o devuelve vacío/null (símbolo sin trades en el
  // rango, feed caído, plazo sin universo), cae a IOL — mismo patrón
  // Cohen→IOL que ya usa fetchCedears() en app.ts. Regla 1: un [] o null de
  // Cohen NUNCA se considera respuesta válida, siempre dispara el fallback a
  // IOL (ver switchMap abajo). Regla 2: si IOL TAMBIÉN devuelve [] (sin
  // credenciales en dev, símbolo sin serie real, etc.), se genera una serie
  // mock (buildMockHistorico) para que el gráfico nunca quede en blanco.
  private loadHistorico(symbol: string, rango: ChartRango) {
    const key = `${symbol}:${rango}`;
    const cached = this.historicoCache.get(key);
    if (cached) {
      this.historicoData.set(cached);
      return;
    }
    this.historicoLoading.set(true);
    const dias = RANGO_DIAS[rango];

    const iol$ = this.http
      .get<HistoricoPoint[]>(`/api/iol/historico?mercado=bCBA&simbolo=${encodeURIComponent(symbol)}&rango=${rango}`)
      .pipe(
        map((points) => (Array.isArray(points) ? points : [])),
        catchError((err: HttpErrorResponse) => {
          // Sin este log, un 404/500 del proxy queda indistinguible de "sin
          // datos" (array vacío legítimo) — costó un diagnóstico entero
          // encontrar que esto tapaba un 404 real. El fallback a [] sigue
          // igual (dispara el mock, ver abajo), pero el error ya no es mudo.
          console.error('[Ficha] error cargando histórico (IOL)', { symbol, rango, status: err.status, body: err.error });
          return of([] as HistoricoPoint[]);
        }),
        // Regla 2: IOL también vacío → serie mock, nunca [] al subscribe.
        map((points) => (points.length ? points : buildMockHistorico(symbol, dias))),
      );

    const cohenUrl = cohenHistoricoUrl(symbol, 'H24', dias);
    const source$ = cohenUrl
      ? this.http.get<HistoricoPoint[]>(cohenUrl).pipe(
          // Regla 1: [] o null de Cohen no es respuesta válida → cae a IOL
          // (que a su vez cae al mock si también viene vacío, ver iol$).
          map((points) => (Array.isArray(points) ? points : [])),
          catchError(() => of([] as HistoricoPoint[])),
          switchMap((points) => (points.length ? of(points) : iol$)),
        )
      : iol$;

    source$.subscribe((points) => {
      // Ambas fuentes reales pueden venir en cualquier orden (IOL: más
      // reciente primero; Cohen: ascendente por construcción, ver feed.py);
      // el mock ya sale ascendente. Se normaliza siempre a orden
      // cronológico ascendente (viejo -> nuevo, izq -> der).
      const arr = (Array.isArray(points) ? points : [])
        .slice()
        .sort((a, b) => new Date(a.fechaHora).getTime() - new Date(b.fechaHora).getTime());
      this.historicoCache.set(key, arr);
      this.historicoData.set(arr);
      this.historicoLoading.set(false);
    });
  }

  // Si Ficha se abrió desde Panel (hay instrumento elegido) volvemos a Panel;
  // si vino de la búsqueda de Home (sin instrumento), volvemos a Home.
  goBackFromFicha() {
    this.subview.set(this.selectedInstrumentId() ? 'panel' : 'home');
  }

  goTicket() {
    const symbol = this.selectedSymbol();
    if (!symbol) return;
    this.goToOrder(symbol, 'compra', 'ficha');
  }

  // Desde Tenencias de Cartera (ver toggleTenenciaExpandida): navega directo
  // a la orden (ya no abre un Ticket "in-memory" sin ruta), tipo='compra'/
  // 'venta' según la acción.
  comprarMasDesdeCartera(symbol: string) {
    this.goToOrder(symbol, 'compra', 'cartera');
  }

  venderDesdeCartera(symbol: string) {
    this.goToOrder(symbol, 'venta', 'cartera');
  }

  // Botón "Comprar" directo desde una fila de Panel o de Home (Acciones/
  // Destacados/buscador): REGLA 1 — bypassea Ficha y cualquier resumen
  // previo, navega directo a /operar/{ticker} (ver goToOrder). origin
  // decide a dónde vuelve "← Volver" (goBackFromTicketForm).
  comprarDirecto(symbol: string, origin: 'panel' | 'home') {
    this.goToOrder(symbol, 'compra', origin);
  }

  private openTicket(tipo: TicketTipoOperacion, symbol: string, origin: 'ficha' | 'cartera' | 'panel' | 'home') {
    this.selectedSymbol.set(symbol);
    this.ticketTipo.set(tipo);
    this.ticketOrigin.set(origin);
    this.ticketStep.set('form');
    this.ticketState.set(this.defaultTicketState());
    this.ticketAccepted.set(false);
    this.ticketBannerShown.set(false);
    this.subview.set('ticket');
  }

  // Vuelve a donde se abrió el Ticket (ver openTicket): Ficha si vino del
  // botón "Comprar" de una ficha, Cartera si vino de Tenencias, o Panel/Home
  // si vino del botón "Comprar" directo de una fila (ver comprarDirecto).
  goBackFromTicketForm() {
    const dest = this.ticketOrigin();
    this.subview.set(dest);
    // Vuelve a home cuando la orden se abrió por navegación directa (ver
    // goToOrder) — saca al usuario de /operar/{ticker} para que la URL
    // refleje la vista real. Cartera/Panel siguen resolviéndose en memoria
    // (no tienen ruta propia todavía), sólo home limpia el path.
    if (dest === 'home' || dest === 'panel') this.router.navigate(['/operar']);
  }

  toggleTenenciaExpandida(symbol: string) {
    this.tenenciaExpandida.set(this.tenenciaExpandida() === symbol ? null : symbol);
  }

  setTipoPrecio(t: TicketTipoPrecio) {
    this.ticketState.update((s) => ({ ...s, tipoPrecio: t }));
    this.syncMontoFromCantidad();
  }

  setPrecioLimite(v: number) {
    this.ticketState.update((s) => ({ ...s, precioLimite: +v >= 0 ? +v : 0 }));
    this.syncMontoFromCantidad();
  }

  setPlazo(p: TicketPlazo) {
    this.ticketState.update((s) => ({ ...s, plazo: p }));
  }

  // Cantidad es el campo primario: cada cambio recalcula Monto = cantidad ×
  // precioEfectivo (columna Venta o límite, ver precioEfectivo()). En modo
  // venta, tope duro = maxVendible() — no se puede cargar más de lo que hay
  // en Tenencias (ver [disabled] del botón + / hint "Disponible" en template).
  incCantidad() {
    const px = this.precioEfectivo();
    this.ticketState.update((s) => {
      const cantidad = Math.min(this.maxVendible(), s.cantidad + 1);
      return { ...s, cantidad, monto: px > 0 ? cantidad * px : s.monto };
    });
  }

  decCantidad() {
    const px = this.precioEfectivo();
    this.ticketState.update((s) => {
      const cantidad = Math.max(0, s.cantidad - 1);
      return { ...s, cantidad, monto: px > 0 ? cantidad * px : s.monto };
    });
  }

  setCantidad(v: number) {
    const cantidad = Math.min(this.maxVendible(), Math.max(0, Math.floor(+v) || 0));
    const px = this.precioEfectivo();
    this.ticketState.update((s) => ({ ...s, cantidad, monto: px > 0 ? cantidad * px : s.monto }));
  }

  // Monto es editable, pero nunca queda en un valor arbitrario: se recalcula
  // Cantidad = floor(monto / precioEfectivo) y con eso se vuelve a recalcular
  // Monto = cantidad × precioEfectivo (múltiplo entero de nominales). Si no
  // alcanza para 1 nominal, se conserva el valor tipeado (sin forzarlo a 0)
  // y el estado se comunica vía montoBelowMinimum() en el template.
  setMonto(v: number) {
    const montoRaw = +v >= 0 ? +v : 0;
    const px = this.precioEfectivo();
    if (px <= 0) {
      this.ticketState.update((s) => ({ ...s, monto: montoRaw }));
      return;
    }
    const cantidad = Math.floor(montoRaw / px);
    if (cantidad <= 0) {
      this.ticketState.update((s) => ({ ...s, cantidad: 0, monto: montoRaw }));
      return;
    }
    this.ticketState.update((s) => ({ ...s, cantidad, monto: cantidad * px }));
  }

  // Sincroniza Monto tras un cambio de precio (tipo o límite) que no vino de
  // Cantidad/Monto directamente, para no dejar un monto stale que ya no
  // corresponda a cantidad × precioEfectivo.
  private syncMontoFromCantidad() {
    const px = this.precioEfectivo();
    if (px <= 0) return;
    this.ticketState.update((s) => (s.cantidad > 0 ? { ...s, monto: s.cantidad * px } : s));
  }

  plazoLabel(id: TicketPlazo): string {
    return this.plazoOpts.find((p) => p.id === id)?.label ?? id;
  }

  // Fecha/hora relativa de un movimiento (tarjeta mobile de Movimientos).
  relativeTime(ts: number): string {
    const min = Math.floor((Date.now() - ts) / 60000);
    if (min < 1) return 'ahora';
    if (min < 60) return `hace ${min} min`;
    const hs = Math.floor(min / 60);
    if (hs < 24) return `hace ${hs} h`;
    return `hace ${Math.floor(hs / 24)} d`;
  }

  // "Revisar orden" — deshabilitado con cantidad=0 (ver [disabled] en el template).
  goTicketConfirmar() {
    if (this.ticketState().cantidad <= 0) return;
    this.ticketStep.set('confirmar');
  }

  // Conserva los valores cargados (ticketState no se resetea al volver).
  goTicketForm() {
    this.ticketStep.set('form');
  }

  // Sin operatoria habilitada: cero request a IOL, sólo banner informativo.
  // Elio pidió que ADEMÁS quede una simulación completa (compra + cartera +
  // movimientos) en paralelo, para mostrar cómo se vería el producto
  // terminado — no reemplaza el banner de "no habilitado", lo complementa.
  confirmarOperacion() {
    if (!this.ticketAccepted()) return;
    const symbol = this.selectedSymbol();
    if (symbol) {
      addMovement({
        symbol,
        instrumento: this.inferInstrumento(symbol),
        tipo: this.ticketTipo(),
        cantidad: this.ticketState().cantidad,
        precio: this.precioEfectivo(),
        monto: this.montoEstimado(),
        plazo: this.ticketState().plazo,
      });
      this.simulatedMovements.set(loadMovements());
    }
    this.ticketBannerShown.set(true);
  }

  goHome() {
    this.subview.set('home');
    // Si estábamos en /operar/{ticker} (navegación directa, ver goToOrder),
    // limpia la URL a /operar para que quede consistente con la vista.
    if (this.ticker()) this.router.navigate(['/operar']);
  }

  goCartera() {
    this.simulatedMovements.set(loadMovements());
    this.subview.set('cartera');
  }

  // Desde el link "Ver en Cartera" del banner de confirmación: arranca en
  // Movimientos para que el registro recién creado se vea de entrada.
  goCarteraFromTicket() {
    this.carteraTab.set('movimientos');
    this.goCartera();
  }

  // TODO etapa siguiente: navegar a Ficha con el instrumento de la fila (AL30/Caución/Plazo fijo).
  onRefRowClick(): void {}

  fmt(v: number | null | undefined, dec = 2): string {
    if (v == null || !isFinite(v)) return '–';
    return v.toLocaleString('es-AR', { maximumFractionDigits: dec, minimumFractionDigits: dec });
  }
}
