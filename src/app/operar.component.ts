import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { forkJoin, catchError, of } from 'rxjs';

import { iolCedearsUrl, CedearRow } from './market.config';
import {
  PanelRow,
  OperarSubview,
  InstrumentId,
  InstrumentPill,
  INSTRUMENT_PILLS,
  DolarStripRow,
  MoverRow,
  FondoCard,
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
import { SimulatedMovement, loadMovements, addMovement } from './operar-storage';

// Tira de dólares — hardcodeada, sin proxy propio todavía.
// TODO: wire a /Cotizaciones/MEP cuando haya proxy.
const DOLAR_STRIP: DolarStripRow[] = [
  { label: 'Oficial', value: 1230 },
  { label: 'MEP', value: 1418 },
  { label: 'CCL', value: 1432 },
];

// Fondos del Home — hardcodeados, sin fetch todavía.
// TODO: /api/v2/Titulos/FCI.
const FONDOS: FondoCard[] = [
  { name: 'Liquidez Pesos', category: 'Money Market', detail: 'TNA 28,4 %' },
  { name: 'Renta Fija Pesos', category: 'Renta Fija ARS', detail: 'TNA 31,2 %' },
  { name: 'Renta Fija Dólares', category: 'Renta Fija USD', detail: 'TNA 6,8 %' },
  { name: 'Renta Variable', category: 'Acciones', detail: '+18,3 % (12 m)' },
];

@Component({
  selector: 'app-operar',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="operar">
      @if (subview() === 'home') {
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

          <button class="op-cartera-btn op-subtab on" type="button" (click)="goCartera()" title="Cartera" aria-label="Ver cartera">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
            <span>Cartera</span>
            @if (tenencias().length) {
              <span class="op-cartera-badge">{{ tenencias().length }}</span>
            }
          </button>
        </div>

        <div class="op-pills">
          @for (p of pills; track p.id) {
            <button class="op-pill" (click)="selectInstrument(p.id)">
              <span class="op-pill-circle">{{ p.initials }}</span>
              <span class="op-pill-label">{{ p.label }}</span>
            </button>
          }
        </div>

        <div class="op-card op-dolares">
          <h3>Dólares</h3>
          <div class="op-dolares-row">
            @for (d of dolarStrip; track d.label) {
              <div class="op-dollar-item">
                <span class="od-lbl">{{ d.label }}</span>
                <span class="od-val num">$ {{ fmt(d.value) }}</span>
              </div>
            }
          </div>
        </div>

        <div class="op-card op-ref">
          <h3>Referencia</h3>
          <div class="op-ref-list">
            <button class="op-ref-row" type="button" (click)="onRefRowClick()">
              <span class="orr-lbl">AL30</span>
              <span class="orr-right">
                @if (al30(); as b) {
                  <span class="orr-val num">$ {{ fmt(price(b)) }}</span>
                  <span class="ori-chip" [class.pos]="b.pct_change >= 0" [class.neg]="b.pct_change < 0">
                    {{ b.pct_change >= 0 ? '+' : '' }}{{ fmt(b.pct_change) }}%
                  </span>
                } @else {
                  <span class="orr-val num">—</span>
                  <span class="ori-chip">sin datos</span>
                }
              </span>
              <span class="orr-chevron">›</span>
            </button>
            <button class="op-ref-row" type="button" (click)="onRefRowClick()">
              <span class="orr-lbl">Caución</span>
              <span class="orr-right">
                <span class="orr-val num">TNA 32,5 %</span>
                <span class="ori-chip warn">estimado</span>
                <!-- TODO: /api/v2/operar/CPD/Comisiones para tasa real -->
              </span>
              <span class="orr-chevron">›</span>
            </button>
            <button class="op-ref-row" type="button" (click)="onRefRowClick()">
              <span class="orr-lbl">Plazo fijo</span>
              <span class="orr-right">
                <span class="orr-val num">TNA 28,0 %</span>
                <span class="ori-chip warn">estimado</span>
                <!-- TODO: fuente de tasas de plazo fijo -->
              </span>
              <span class="orr-chevron">›</span>
            </button>
          </div>
        </div>

        <div class="op-card op-destacados">
          <h3>Destacados</h3>
          @if (destacados().length) {
            <div class="op-movers-grid">
              @for (m of destacados(); track m.symbol) {
                <div class="op-mover">
                  <span class="om-sym">{{ m.symbol }}</span>
                  <span class="om-px num">$ {{ fmt(m.price) }}</span>
                  <span class="om-chip" [class.pos]="m.pctChange >= 0" [class.neg]="m.pctChange < 0">
                    {{ m.pctChange >= 0 ? '+' : '' }}{{ fmt(m.pctChange) }}%
                  </span>
                </div>
              }
            </div>
          } @else {
            <div class="op-empty">Esperando cotizaciones…</div>
          }
        </div>

        <div class="op-card op-fondos">
          <h3>Fondos</h3>
          <div class="op-fondos-grid">
            @for (f of fondos; track f.name) {
              <div class="op-fondo">
                <span class="of-name">{{ f.name }}</span>
                <span class="of-cat">{{ f.category }}</span>
                <span class="of-detail num">{{ f.detail }}</span>
              </div>
            }
          </div>
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
                </tr>
              </thead>
              <tbody>
                @for (r of panelSortedRows(); track r.symbol) {
                  <tr (click)="selectSymbol(r)">
                    <td>
                      <span class="opt-sym">{{ r.symbol }}</span>
                      @if (r.desc) { <span class="opt-desc">{{ r.desc }}</span> }
                    </td>
                    <td class="num">{{ fmt(price(r)) }}</td>
                    <td class="num" [class.pos]="r.pct_change >= 0" [class.neg]="r.pct_change < 0">
                      {{ r.pct_change >= 0 ? '+' : '' }}{{ fmt(r.pct_change) }}%
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

        <div class="op-rango-pills">
          @for (r of chartRangos; track r.id) {
            <button class="op-rango-pill" type="button" [class.on]="chartRango() === r.id" (click)="selectRango(r.id)">
              {{ r.label }}
            </button>
          }
        </div>

        @if (historicoData().length > 1) {
          <svg class="fc-svg" viewBox="0 0 600 160" preserveAspectRatio="none">
            <polyline class="fc-line" [class.pos]="chartIsPos()" [class.neg]="!chartIsPos()" [attr.points]="chartPoints()" />
          </svg>
        } @else if (historicoLoading()) {
          <div class="op-empty">Cargando gráfico…</div>
        } @else {
          <div class="op-empty">Sin datos históricos para este rango.</div>
        }

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

          <div class="op-card op-book">
            <div class="ob-title-wrap">
              <h3>Puntas</h3>
              @if (bookIsEmpty(selectedRow())) { <span class="ori-chip warn">estimado</span> }
            </div>
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
          </div>

          <button class="op-buy-sticky op-buy-sticky-sm" type="button" [disabled]="ticketState().cantidad <= 0" (click)="goTicketConfirmar()">
            Revisar orden
          </button>
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
                  @for (t of tenencias(); track t.symbol) {
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
              @for (t of tenencias(); track t.symbol) {
                <div class="op-card" (click)="toggleTenenciaExpandida(t.symbol)">
                  <div class="of-row">
                    <span>
                      <span class="opt-sym">{{ t.symbol }}</span>
                      <span class="ori-chip">{{ instrumentoLabel[t.instrumento] }}</span>
                      @if (t.estimado) { <span class="ori-chip warn">estimado</span> }
                    </span>
                    <span class="num">{{ fmt(t.cantidad, 0) }}</span>
                  </div>
                  <div class="op-dolares-row">
                    <div class="op-dollar-item">
                      <span class="od-lbl">Precio prom.</span>
                      <span class="od-val num">{{ fmt(t.precioPromedio) }}</span>
                    </div>
                    <div class="op-dollar-item">
                      <span class="od-lbl">Valor actual</span>
                      <span class="od-val num">{{ fmt(t.valorActual) }}</span>
                    </div>
                  </div>
                  <div class="op-resumen-prof" [class.pos]="t.pnl >= 0" [class.neg]="t.pnl < 0">
                    <span class="rp-val num">{{ t.pnl >= 0 ? '+' : '' }}{{ fmt(t.pnl) }}</span>
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
                <div class="op-card">
                  <div class="of-row">
                    <span>
                      <span class="opt-sym">{{ m.symbol }}</span>
                      <span class="ori-chip" [class.accent]="m.tipo === 'compra'" [class.warn]="m.tipo === 'venta'">
                        {{ m.tipo === 'compra' ? 'Compra' : 'Venta' }}
                      </span>
                    </span>
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
                  <span class="ori-chip" [class.warn]="m.estado === 'simulada_pendiente'" [class.pos]="m.estado === 'simulada_liquidada'">
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
    .op-search-wrap { position: relative; }
    .op-search {
      width: 100%; height: 40px; padding: 0 14px;
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

    /* Cards genéricas */
    .op-card {
      border: 1px solid var(--line); border-radius: var(--r-lg);
      background: var(--surface); box-shadow: var(--shadow-sm); padding: 14px 16px;
    }
    .op-card h3 {
      margin: 0 0 12px; font-family: var(--font-display); font-size: 14px; font-weight: 700; color: var(--ink);
    }

    /* Dólares — una card, 3 columnas divididas (label arriba, valor mono debajo) */
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

    /* Referencia — una card, filas apiladas (lista), no grilla. Bleed horizontal
       a los bordes de la card (mismo padding que .op-card, en negativo) para que
       el hover cubra el ancho completo, como una fila de menú. */
    .op-ref-list { display: flex; flex-direction: column; margin: 0 -16px; }
    .op-ref-row {
      display: flex; align-items: center; gap: 10px; width: 100%;
      padding: 10px 16px; border: 0; border-bottom: 1px solid var(--line);
      background: transparent; cursor: pointer; text-align: left;
      font-family: var(--font-ui); color: var(--ink);
      transition: background .14s;
    }
    .op-ref-row:last-child { border-bottom: 0; }
    .op-ref-row:hover { background: var(--accent-sf); }
    .orr-lbl {
      font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
      color: var(--ink-3); flex-shrink: 0;
    }
    .orr-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
    .orr-val { font-size: 15px; font-weight: 600; color: var(--ink); }
    .orr-chevron { color: var(--ink-3); font-size: 15px; line-height: 1; flex-shrink: 0; }

    /* Destacados */
    .op-movers-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
    .op-mover {
      display: flex; flex-direction: column; gap: 4px;
      padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r);
    }
    .om-sym { font-family: var(--font-mono); font-weight: 600; font-size: 13px; color: var(--ink); }
    .om-px { font-size: 13px; color: var(--ink-2); }
    .om-chip { align-self: flex-start; }

    /* Fondos */
    .op-fondos-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
    .op-fondo {
      display: flex; flex-direction: column; gap: 4px;
      padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--r);
    }
    .of-name { font-size: 13px; font-weight: 600; color: var(--ink); }
    .of-cat { font-size: 11px; color: var(--ink-3); }
    .of-detail { font-size: 12.5px; font-weight: 600; color: var(--ink-2); margin-top: 2px; }

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

    /* Ficha — selector de rango, mismo espíritu que las pills de instrumento */
    .op-rango-pills { display: inline-flex; gap: 2px; padding: 3px; align-self: flex-start;
      border: 1px solid var(--line); border-radius: var(--r); background: var(--surface-2);
    }
    .op-rango-pill {
      height: 28px; min-width: 44px; padding: 0 10px; border: 0; border-radius: var(--r-sm);
      background: transparent; color: var(--ink-2);
      font-family: var(--font-mono); font-size: 12px; font-weight: 700; cursor: pointer;
      transition: background .14s, box-shadow .14s, color .14s;
    }
    .op-rango-pill.on { background: var(--surface); color: var(--ink); box-shadow: var(--shadow-sm); }
    .op-rango-pill:not(.on):hover { color: var(--ink); }

    /* Ficha — gráfico SVG a mano, sin librería. Color = familia pos/neg según
       último cierre vs. primero del rango, nunca decorativo. */
    .fc-svg { width: 100%; height: 160px; display: block; }
    .fc-line { fill: none; stroke-width: 2; }
    .fc-line.pos { stroke: var(--pos); }
    .fc-line.neg { stroke: var(--neg); }

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

    /* Ticket — card "Orden" (Precio/Plazo/Cantidad/Monto), separada de Puntas */
    .op-order-body { display: flex; flex-direction: column; gap: 18px; }

    /* Ticket — fila de selects (Precio / Precio límite / Plazo) */
    .op-ticket-row { display: flex; gap: 14px; flex-wrap: wrap; }
    .op-field { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 140px; }
    .of-lbl { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-3); }
    .op-select, .op-input {
      height: 40px; padding: 0 12px; border: 1px solid var(--line); border-radius: var(--r-sm);
      background: var(--surface); color: var(--ink); font-family: var(--font-ui); font-size: 14px; outline: none;
      transition: border-color .12s, box-shadow .12s;
    }
    .op-select:focus, .op-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-sf); }
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

    .op-home-head { display: flex; align-items: flex-start; gap: 10px; }
    .op-home-head .op-search-wrap { flex: 1; }
    .op-cartera-btn { flex-shrink: 0; position: relative; display: inline-flex; align-items: center; gap: 6px; height: 40px; }
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

    @media (max-width: 760px) {
      .op-dolares-row { flex-direction: column; }
      .op-dollar-item { padding: 0; border-right: 0; border-bottom: 1px solid var(--line); }
      .op-dollar-item:not(:first-child) { padding-top: 8px; }
      .op-dollar-item:not(:last-child) { padding-bottom: 8px; }
      .op-dollar-item:last-child { border-bottom: 0; }
      .op-ref-row { flex-wrap: wrap; }
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

  pills: InstrumentPill[] = INSTRUMENT_PILLS;
  dolarStrip: DolarStripRow[] = DOLAR_STRIP;
  fondos: FondoCard[] = FONDOS;
  currencyPills = CURRENCY_PILLS;
  chartRangos = CHART_RANGOS;

  subview = signal<OperarSubview>('home');
  selectedInstrumentId = signal<InstrumentId | null>(null);
  selectedSymbol = signal<string | null>(null);
  query = signal('');

  accionesRows = signal<PanelRow[]>([]);
  cedearsRows = signal<CedearRow[]>([]);
  bonosRows = signal<PanelRow[]>([]);
  letrasRows = signal<PanelRow[]>([]);
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
  ticketTipo = signal<TicketTipoOperacion>('compra');
  ticketOrigin = signal<'ficha' | 'cartera'>('ficha');

  // Estado propio de la subvista Cartera — simulación en localStorage, ver
  // operar-storage.ts y operar.types.ts §Cartera simulada.
  carteraTab = signal<'tenencias' | 'movimientos'>('tenencias');
  simulatedMovements = signal<SimulatedMovement[]>(loadMovements());
  // Symbol de Tenencias con las acciones "Comprar más"/"Vender" desplegadas.
  tenenciaExpandida = signal<string | null>(null);
  instrumentoLabel = INSTRUMENTO_CHIP_LABEL;

  private homeLoaded = false;
  // Ids ya fetcheados en esta sesión del componente (letras/ons son lazy;
  // acciones/cedears/bonos ya vienen del prefetch de Home).
  private lazyFetched = new Set<'letras' | 'ons'>();
  private usaFetched = false;
  // Cache de serie histórica por symbol+rango — no se re-fetchea si ya se pidió.
  private historicoCache = new Map<string, HistoricoPoint[]>();

  // Prefetch al entrar a Home; sólo una vez por sesión del componente (Panel/
  // Ficha/Ticket no tienen fetch propio todavía).
  private prefetchHome = effect(() => {
    if (this.subview() === 'home' && !this.homeLoaded) {
      this.homeLoaded = true;
      this.loadHome();
    }
  });

  // Fetch de la serie histórica al entrar a Ficha o al cambiar de rango
  // (cacheado por symbol+rango en loadHistorico, ver más abajo).
  private fichaFetch = effect(() => {
    const sym = this.selectedSymbol();
    const rango = this.chartRango();
    if (this.subview() !== 'ficha' || !sym) return;
    this.loadHistorico(sym, rango);
  });

  searchResults = computed<PanelRow[]>(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return [];
    const all: PanelRow[] = [...this.accionesRows(), ...this.cedearsRows()];
    return all
      .filter((r) => String(r.symbol ?? '').toLowerCase().includes(q) || String(r.desc ?? '').toLowerCase().includes(q))
      .slice(0, 8);
  });

  // AL30 vive en el panel de bonos (IOL mapea bonos soberanos a titulosPublicos).
  al30 = computed<PanelRow | null>(() => this.bonosRows().find((r) => r.symbol === 'AL30') ?? null);

  // Top 4 movers por variación absoluta, 100% real sobre acciones+cedears cacheados.
  destacados = computed<MoverRow[]>(() => {
    const all: PanelRow[] = [...this.accionesRows(), ...this.cedearsRows()];
    return [...all]
      .filter((r) => r?.symbol)
      .sort((a, b) => Math.abs(b.pct_change || 0) - Math.abs(a.pct_change || 0))
      .slice(0, 4)
      .map((r) => ({ symbol: r.symbol, price: this.price(r), pctChange: r.pct_change || 0 }));
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

  // Polyline del gráfico: cierres normalizados a un viewBox fijo de 600x160.
  // IOL no trae un campo "cierre" en la serie histórica: en una serie diaria,
  // `ultimoPrecio` de cada día ES el cierre de esa rueda (ver operar.types.ts).
  chartPoints = computed<string>(() => {
    const d = this.historicoData();
    if (d.length < 2) return '';
    const W = 600, H = 160, PAD = 6;
    const closes = d.map((p) => +p.ultimoPrecio || 0);
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const span = max - min || 1;
    const stepX = (W - PAD * 2) / (d.length - 1);
    return closes
      .map((c, i) => {
        const x = PAD + i * stepX;
        const y = H - PAD - ((c - min) / span) * (H - PAD * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  });

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

  selectSymbol(row: PanelRow) {
    this.selectedSymbol.set(row.symbol);
    this.chartRango.set('1M');
    this.fichaBookOpen.set(true);
    this.subview.set('ficha');
  }

  selectRango(r: ChartRango) {
    this.chartRango.set(r);
  }

  private loadHistorico(symbol: string, rango: ChartRango) {
    const key = `${symbol}:${rango}`;
    const cached = this.historicoCache.get(key);
    if (cached) {
      this.historicoData.set(cached);
      return;
    }
    this.historicoLoading.set(true);
    this.http.get<HistoricoPoint[]>(`/api/iol/historico?mercado=bCBA&simbolo=${encodeURIComponent(symbol)}&rango=${rango}`).pipe(
      catchError((err: HttpErrorResponse) => {
        // Sin este log, un 404/500 del proxy queda indistinguible de "sin
        // datos" (array vacío legítimo) — costó un diagnóstico entero
        // encontrar que esto tapaba un 404 real. El fallback a [] sigue
        // igual (estado vacío en el gráfico), pero el error ya no es mudo.
        console.error('[Ficha] error cargando histórico', { symbol, rango, status: err.status, body: err.error });
        return of([] as HistoricoPoint[]);
      })
    ).subscribe((points) => {
      // IOL devuelve la serie más reciente primero (descendente); el gráfico
      // necesita orden cronológico ascendente (viejo -> nuevo, izq -> der).
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
    this.openTicket('compra', symbol, 'ficha');
  }

  // Desde Tenencias de Cartera (ver toggleTenenciaExpandida): abre el mismo
  // Ticket sin pasar por Ficha, tipo='compra'/'venta' según la acción.
  comprarMasDesdeCartera(symbol: string) {
    this.openTicket('compra', symbol, 'cartera');
  }

  venderDesdeCartera(symbol: string) {
    this.openTicket('venta', symbol, 'cartera');
  }

  private openTicket(tipo: TicketTipoOperacion, symbol: string, origin: 'ficha' | 'cartera') {
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
  // botón "Comprar" de una ficha, Cartera si vino de Tenencias.
  goBackFromTicketForm() {
    this.subview.set(this.ticketOrigin() === 'cartera' ? 'cartera' : 'ficha');
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
