import { Component, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import {
  CedearRow,
  ArbPair,
  TradeResult,
  DollarType,
  Settlement,
  SUFFIX,
  DEFAULTS,
  settlementLabel,
} from './market.config';

import { buildPairs, bestBuy, bestSell, computeTrade, buyLegUsd, sellLegUsd } from './arb-engine';

@Component({
  selector: 'app-arbitrage',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="arb">
      <div class="arb-head">
        <span class="badge dollar">{{ dollarType() }}</span>
        <span class="badge plazo">{{ settlementLabel(settlement()) }}</span>

        <label class="monto">
          Monto inicial ARS
          <input
            type="number"
            min="1000"
            step="1000"
            [ngModel]="amountArs()"
            (ngModelChange)="amountArs.set(+$event || 0)"
          />
        </label>

        <label class="monto comm">
          Comisión / gastos %
          <input
            type="number"
            min="0"
            step="0.1"
            [ngModel]="commissionPct()"
            (ngModelChange)="commissionPct.set(+$event >= 0 ? +$event : 0)"
          />
        </label>

        <label class="monto vol">
          Vol. mín USD
          <input
            type="number"
            min="0"
            step="100"
            [ngModel]="minUsdVol()"
            (ngModelChange)="minUsdVol.set(+$event >= 0 ? +$event : 0)"
          />
        </label>

        @if (settlement() === 'CI' && !ciIsReal()) {
          <label class="monto ci">
            Ajuste CI %
            <input
              type="number"
              step="0.05"
              [ngModel]="ciAdjustPct()"
              (ngModelChange)="ciAdjustPct.set(+$event || 0)"
            />
          </label>
        }

        <span class="pair-count">
          {{ buyOptions().length }} compra · {{ sellOptions().length }} venta
          con vol ≥ {{ fmt(minUsdVol(), 0) }} USD
          <span class="pc-total">/ {{ pairs().length }} totales</span>
        </span>

        @if (!paused()) {
          <button class="freeze-btn" (click)="freeze()" title="Pausar el refresh para operar en el broker">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            Congelar para operar
          </button>
        }
      </div>

      @if (paused()) {
        <div class="freeze-bar">
          <svg class="fb-lock" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <div class="fb-text">
            <strong>Congelado para operar</strong>
            <span>
              El refresh está pausado: la selección y los precios no cambian.
              @if (selectedBuy(); as b) { Comprás <b>{{ b.base }}</b>. }
              @if (selectedSell(); as s) { Vendés <b>{{ s.base }}</b>. }
            </span>
          </div>
          <button class="fb-resume" (click)="unfreeze()">Reanudar en vivo</button>
        </div>
      }

      @if (settlement() === 'CI') {
        @if (ciIsReal()) {
          <div class="ci-note real">
            Contado Inmediato — libro real T+0 por símbolo (IOL), sólo pares con liquidez.
          </div>
        } @else {
          <div class="ci-note">
            Contado Inmediato estimado desde el libro de 24hs (ajuste {{ fmt(ciAdjustPct(), 2) }} %) — IOL no disponible, usando data912.
          </div>
        }
      }

      @if (pairs().length === 0) {
        <div class="empty">Esperando datos de CEDEARs…</div>
      } @else {
        @if (!selectedBuy() || !selectedSell()) {
          <div class="vol-warn">
            Ningún par con volumen efectivo ≥ {{ fmt(minUsdVol(), 0) }} USD en
            @if (!selectedBuy() && !selectedSell()) { ambas puntas }
            @else if (!selectedBuy()) { la punta de compra }
            @else { la punta de venta }.
            Bajá el «Vol. mín USD» para ver más opciones.
          </div>
        }

        <!-- Auto-selección + volumen operable resumido por tipo de operación -->
        <div class="auto-banner">
          @if (selectedBuy(); as b) {
            <div class="auto-pill buy">
              <span class="auto-action">Comprás CEDEAR</span>
              <span class="auto-ticker">{{ b.base }}</span>
              <span class="auto-quote">
                <span class="auto-rate">$ {{ fmt(b.dolarVenta, 2) }}<span class="auto-unit">/USD</span></span>
                <span class="auto-vol">{{ fmt(volBuyUnits(b), 0) }} u. · {{ fmt(volBuy(b), 0) }} USD</span>
              </span>
            </div>
          }
          @if (selectedSell(); as s) {
            <div class="auto-pill sell">
              <span class="auto-action">Vendés CEDEAR</span>
              <span class="auto-ticker">{{ s.base }}</span>
              <span class="auto-quote">
                <span class="auto-rate">$ {{ fmt(s.dolarCompra, 2) }}<span class="auto-unit">/USD</span></span>
                <span class="auto-vol">{{ fmt(volSellUnits(s), 0) }} u. · {{ fmt(volSell(s), 0) }} USD</span>
              </span>
            </div>
          }
          @if (trade(); as t) {
            <div class="auto-operable">
              <span class="ao-lbl">Operable real (mín. de ambas puntas)</span>
              <span class="ao-units">{{ fmt(t.tradeableUnits, 0) }} u.</span>
              <span class="ao-sep">·</span>
              <span class="ao-mny">$ {{ fmt(t.tradeableArs, 0) }} ARS</span>
              <span class="ao-sep">·</span>
              <span class="ao-mny">USD {{ fmt(t.tradeableUsd, 2) }}</span>
            </div>
          }
        </div>

        <div class="grid">
          <!-- Compro USD -->
          <div class="card buy">
            <h3>1. Comprás CEDEAR (dólar más barato)</h3>
            <p class="hint">Auto-seleccionado: la menor cotización de venta</p>
            <select
              [ngModel]="manualBuy()"
              (ngModelChange)="onManualBuy($event)"
            >
              <option [ngValue]="null">Automático (mejor)</option>
              @for (p of buyOptions(); track p.base) {
                <option [ngValue]="p.base">
                  {{ p.base }} — $ {{ fmt(p.dolarVenta, 2) }} / USD
                </option>
              }
            </select>

            @if (selectedBuy(); as b) {
              <div class="card-body">
                <div class="row">
                  <span>Precio de compra <em class="tk">{{ b.base }}</em></span>
                  <span class="pv">
                    <strong>{{ fmt(b.arsAsk, 2) }}</strong>
                    <em class="qty">vol compra · {{ fmt(b.qArsAsk, 0) }} u.</em>
                  </span>
                </div>
                <div class="row">
                  <span>Precio de venta <em class="tk">{{ usdTicker(b.base) }}</em></span>
                  <span class="pv">
                    <strong>{{ fmt(b.usdBid, 4) }}</strong>
                    <em class="qty">vol venta · {{ fmt(b.qUsdBid, 0) }} u.</em>
                  </span>
                </div>
                <div class="row big">
                  <span>Precio dólar venta (compro USD)</span>
                  <span class="pv">
                    <strong class="hi">$ {{ fmt(b.dolarVenta, 2) }}</strong>
                    <em class="qty">operable · {{ fmt(volBuyUnits(b), 0) }} u.</em>
                  </span>
                </div>
              </div>
            }
          </div>

          <!-- Vendo USD -->
          <div class="card sell">
            <h3>2. Vendés CEDEAR (paga más ARS)</h3>
            <p class="hint">Auto-seleccionado: la mayor cotización de compra</p>
            <select
              [ngModel]="manualSell()"
              (ngModelChange)="onManualSell($event)"
            >
              <option [ngValue]="null">Automático (mejor)</option>
              @for (p of sellOptions(); track p.base) {
                <option [ngValue]="p.base">
                  {{ p.base }} — $ {{ fmt(p.dolarCompra, 2) }} / USD
                </option>
              }
            </select>

            @if (selectedSell(); as s) {
              <div class="card-body">
                <div class="row">
                  <span>Precio de compra <em class="tk">{{ usdTicker(s.base) }}</em></span>
                  <span class="pv">
                    <strong>{{ fmt(s.usdAsk, 4) }}</strong>
                    <em class="qty">vol compra · {{ fmt(s.qUsdAsk, 0) }} u.</em>
                  </span>
                </div>
                <div class="row">
                  <span>Precio de venta <em class="tk">{{ s.base }}</em></span>
                  <span class="pv">
                    <strong>{{ fmt(s.arsBid, 2) }}</strong>
                    <em class="qty">vol venta · {{ fmt(s.qArsBid, 0) }} u.</em>
                  </span>
                </div>
                <div class="row big">
                  <span>Precio dólar compra (vendo USD)</span>
                  <span class="pv">
                    <strong class="hi">$ {{ fmt(s.dolarCompra, 2) }}</strong>
                    <em class="qty">operable · {{ fmt(volSellUnits(s), 0) }} u.</em>
                  </span>
                </div>
              </div>
            }
          </div>

          <!-- Resultado -->
          <div
            class="card result"
            [class.profit]="(trade()?.netProfit ?? 0) > 0"
            [class.loss]="(trade()?.netProfit ?? 0) < 0"
          >
            <h3>3. Resultado del trade</h3>
            @if (trade(); as t) {
              @if (t.netProfit > 0) {
              <div class="steps">
                <div class="step">
                  <span class="lbl">Compro CEDEAR ARS</span>
                  <span class="val">{{ fmt(t.n1, 4) }} unid.</span>
                </div>
                <div class="step">
                  <span class="lbl">Vendo CEDEAR USD</span>
                  <span class="val">USD {{ fmt(t.usdMid, 2) }}</span>
                </div>
                <div class="step">
                  <span class="lbl">Compro CEDEAR USD</span>
                  <span class="val">{{ fmt(t.n2, 4) }} unid.</span>
                </div>
                <div class="step">
                  <span class="lbl">Vendo CEDEAR ARS</span>
                  <span class="val">$ {{ fmt(t.arsOut, 2) }}</span>
                </div>
                <hr />
                <div class="step">
                  <span class="lbl">Ganancia bruta</span>
                  <span class="val">$ {{ fmt(t.grossProfit, 2) }}</span>
                </div>
                <div class="step">
                  <span class="lbl">Rendimiento bruto</span>
                  <span class="val">{{ fmt(t.grossPct, 3) }} %</span>
                </div>
                <div class="step muted">
                  <span class="lbl">Comisión / gastos</span>
                  <span class="val">− {{ fmt(t.commissionPct, 2) }} %</span>
                </div>
                <hr />
                <div class="step net">
                  <span class="lbl">Ganancia NETA</span>
                  <span class="val">$ {{ fmt(t.netProfit, 2) }}</span>
                </div>
                <div class="step net big-net">
                  <span class="lbl">Rendimiento NETO</span>
                  <span class="val">{{ fmt(t.netPct, 3) }} %</span>
                </div>
              </div>

              <p class="disclaimer">
                Neto = bruto menos {{ fmt(t.commissionPct, 2) }} % de comisión/gastos.
                No incluye derechos de mercado, parking ni impuestos.
                Operación válida sólo hasta el volumen operable real (mínimo de ambas puntas).
              </p>
              } @else {
              <div class="no-arb">
                <strong>No hay oportunidad rentable ahora.</strong>
                <span>El mejor par da un neto de {{ fmt(t.netPct, 3) }} % tras {{ fmt(t.commissionPct, 2) }} % de comisión. Esperá a que el spread se abra.</span>
              </div>
              }
            } @else {
              <div class="empty">No hay par operable para calcular el resultado.</div>
            }
          </div>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th class="num">ARS bid</th>
                <th class="num">ARS ask</th>
                <th class="num">USD bid</th>
                <th class="num">USD ask</th>
                <th class="num">$ Compra (vendo USD)</th>
                <th class="num">$ Venta (compro USD)</th>
                <th class="num">Vol USD compra</th>
                <th class="num">Vol USD venta</th>
                <th class="num">Spread %</th>
              </tr>
            </thead>
            <tbody>
              @for (p of pairsSorted(); track p.base) {
                <tr
                  [class.sel-buy]="p.base === selectedBuy()?.base"
                  [class.sel-sell]="p.base === selectedSell()?.base"
                >
                  <td><strong>{{ p.base }}</strong></td>
                  <td class="num">{{ fmt(p.arsBid, 2) }}</td>
                  <td class="num">{{ fmt(p.arsAsk, 2) }}</td>
                  <td class="num">{{ fmt(p.usdBid, 4) }}</td>
                  <td class="num">{{ fmt(p.usdAsk, 4) }}</td>
                  <td class="num">{{ fmt(p.dolarCompra, 2) }}</td>
                  <td class="num">{{ fmt(p.dolarVenta, 2) }}</td>
                  <td class="num" [class.vol-lo]="volBuy(p) < minUsdVol()" [class.vol-sel]="p.base === selectedBuy()?.base">{{ fmt(volBuy(p), 0) }}</td>
                  <td class="num" [class.vol-lo]="volSell(p) < minUsdVol()" [class.vol-sel]="p.base === selectedSell()?.base">{{ fmt(volSell(p), 0) }}</td>
                  <td class="num">{{ fmt(p.spreadPct, 3) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
  styles: [`
    .arb { padding: 2px 0 24px; }
    .arb-head {
      display: flex; gap: 16px; align-items: flex-end; flex-wrap: wrap;
      padding-bottom: 16px; margin-bottom: 18px; border-bottom: 1px solid var(--line);
    }
    .badge {
      display: inline-flex; align-items: center; height: 24px; padding: 0 9px;
      border-radius: var(--r-sm); font-family: var(--font-mono);
      font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
      align-self: center;
    }
    .badge.dollar { background: var(--ink); color: #fff; }
    .badge.plazo { background: var(--surface-2); color: var(--ink-2); border: 1px solid var(--line); }
    .monto {
      display: flex; flex-direction: column; gap: 5px;
      font-size: 10.5px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em;
      color: var(--ink-3);
    }
    .monto input {
      width: 150px; background: var(--surface); color: var(--ink);
      font-family: var(--font-mono); font-size: 13px; font-weight: 600;
      border: 1px solid var(--line); border-radius: var(--r-sm); padding: 7px 9px;
      outline: none; transition: border-color .12s, box-shadow .12s;
    }
    .monto input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-sf); }
    .monto.comm input { width: 100px; }
    .monto.ci input { width: 100px; }
    .monto.ci { color: var(--warn); }
    .monto.ci input { border-color: var(--warn-line); }
    .monto.vol input { width: 100px; }
    .pair-count {
      margin-left: auto; align-self: center; text-align: right; line-height: 1.5;
      font-family: var(--font-mono); font-size: 11px; color: var(--ink-2);
    }
    .pc-total { color: var(--ink-3); }

    .vol-warn {
      margin: 0 0 16px; padding: 9px 13px; border-radius: var(--r);
      background: var(--warn-bg); border: 1px solid var(--warn-line); color: var(--warn);
      font-size: 12px;
    }
    td.vol-lo { color: var(--ink-3); }
    /* Vol operable de la punta elegida: resaltado para seguirlo aunque cambie cada segundo. */
    td.vol-sel { font-weight: 700; color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink); }

    /* Congelar para operar */
    .freeze-btn {
      align-self: center;
      display: inline-flex; align-items: center; gap: 6px;
      height: 32px; padding: 0 12px;
      border: 1px solid var(--ink); background: var(--ink); color: #fff;
      border-radius: var(--r-sm); cursor: pointer;
      font-family: var(--font-ui); font-size: 12.5px; font-weight: 600;
      transition: opacity .12s, transform .04s;
    }
    .freeze-btn:hover { opacity: .88; }
    .freeze-btn:active { transform: translateY(1px); }

    .freeze-bar {
      display: flex; align-items: center; gap: 14px;
      margin: 0 0 18px; padding: 12px 16px;
      border: 1px solid var(--warn-line); border-left: 3px solid var(--warn);
      background: var(--warn-bg); border-radius: var(--r-lg);
    }
    .fb-lock { color: var(--warn); flex-shrink: 0; }
    .fb-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .fb-text strong { font-family: var(--font-display); font-size: 13px; font-weight: 700; color: var(--warn); }
    .fb-text span { font-size: 12px; color: var(--ink-2); }
    .fb-text b { font-family: var(--font-mono); font-weight: 600; color: var(--ink); }
    .fb-resume {
      margin-left: auto; flex-shrink: 0;
      height: 34px; padding: 0 16px;
      border: 1px solid var(--pos); background: var(--pos); color: #fff;
      border-radius: var(--r-sm); cursor: pointer;
      font-family: var(--font-ui); font-size: 12.5px; font-weight: 600;
      transition: opacity .12s, transform .04s;
    }
    .fb-resume:hover { opacity: .9; }
    .fb-resume:active { transform: translateY(1px); }

    .ci-note {
      margin: 0 0 16px; padding: 9px 13px; border-radius: var(--r);
      background: var(--warn-bg); border: 1px solid var(--warn-line); color: var(--warn);
      font-size: 12px;
    }
    .ci-note.real {
      background: var(--pos-bg); border-color: var(--pos-line); color: var(--pos);
    }

    /* Auto-selección: una tira con dos mitades, sin gradientes (de-slop) */
    .auto-banner {
      display: grid; grid-template-columns: 1fr 1fr; margin-bottom: 18px;
      border: 1px solid var(--line); border-radius: var(--r-lg);
      background: var(--surface); box-shadow: var(--shadow-sm); overflow: hidden;
    }
    .auto-pill {
      display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px;
      padding: 14px 16px; position: relative;
    }
    .auto-pill.buy { border-left: 3px solid var(--accent); }
    .auto-pill.sell { border-left: 3px solid var(--warn); }
    .auto-pill.buy + .auto-pill.sell { border-left-color: var(--line); box-shadow: inset 3px 0 0 var(--warn); }
    .auto-pill .auto-action {
      font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--ink-3);
    }
    .auto-pill .auto-ticker {
      font-family: var(--font-mono); font-size: 22px; font-weight: 600;
      letter-spacing: -0.01em; color: var(--ink);
    }
    .auto-pill .auto-quote {
      margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; gap: 1px;
    }
    .auto-pill .auto-rate {
      font-family: var(--font-mono); font-size: 16px; font-weight: 600;
      color: var(--ink); line-height: 1.1;
    }
    .auto-pill .auto-unit { font-size: 10px; font-weight: 500; color: var(--ink-3); margin-left: 2px; }
    .auto-pill .auto-vol {
      font-family: var(--font-mono); font-size: 12.5px; font-weight: 600; color: var(--ink-2);
    }
    /* Volumen operable real, consolidado al pie de la caja de puntas.
       Es el dato que limita la operación → se trata como la zona "oportunidad":
       fondo verde, barra de acento a la izquierda y número protagonista. */
    .auto-operable {
      grid-column: 1 / -1;
      display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
      padding: 11px 16px; border-top: 1px solid var(--pos-line);
      background: var(--pos-bg); box-shadow: inset 3px 0 0 var(--pos);
    }
    .auto-operable .ao-lbl {
      font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--pos); margin-right: auto;
    }
    .auto-operable .ao-units { font-family: var(--font-mono); font-size: 17px; font-weight: 700; color: var(--pos-strong); }
    .auto-operable .ao-mny { font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--ink); }
    .auto-operable .ao-sep { color: var(--pos-line); }

    .grid {
      display: grid; gap: 14px;
      grid-template-columns: repeat(auto-fit, minmax(264px, 1fr));
      margin-bottom: 22px;
    }
    .card {
      background: var(--surface); border: 1px solid var(--line);
      border-radius: var(--r-lg); padding: 16px; box-shadow: var(--shadow-sm);
    }
    .card h3 {
      margin: 0 0 4px; font-family: var(--font-display); font-size: 13px; font-weight: 700; color: var(--ink);
      display: flex; align-items: center; gap: 8px;
    }
    /* Marcador de tipo en vez de franja lateral completa */
    .card h3::before {
      content: ''; width: 7px; height: 7px; border-radius: 2px; background: var(--ink-3);
    }
    .card.buy h3::before { background: var(--accent); }
    .card.sell h3::before { background: var(--warn); }
    .card.result.profit h3::before { background: var(--pos); }
    .card .hint { margin: 0 0 12px; font-size: 11px; color: var(--ink-3); }
    .card select {
      width: 100%; padding: 8px 10px; font-size: 13px; font-family: var(--font-ui);
      border: 1px solid var(--line); border-radius: var(--r-sm);
      background: var(--surface); color: var(--ink); outline: none;
    }
    .card select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-sf); }
    .card-body { margin-top: 12px; }
    .row {
      display: flex; justify-content: space-between; align-items: baseline; padding: 4px 0;
      font-size: 12px; color: var(--ink-2);
    }
    .row strong { color: var(--ink); font-weight: 600; font-family: var(--font-mono); }
    /* Ticker real de la punta (pesos / par en dólares) junto a su precio. */
    .row .tk {
      font-style: normal; font-family: var(--font-mono); font-size: 11px; font-weight: 600;
      color: var(--ink); background: var(--surface-2); border: 1px solid var(--line);
      padding: 1px 6px; border-radius: var(--r-sm); margin-left: 4px;
    }
    /* Precio arriba, volumen operable de esa punta debajo. */
    .row .pv { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
    .row .pv .qty {
      font-style: normal; font-family: var(--font-mono); font-size: 10.5px; font-weight: 600;
      color: var(--ink-3);
    }
    .row.big { padding: 10px 0 2px; border-top: 1px solid var(--line); margin-top: 8px; font-size: 13px; }
    .row.big .hi { font-family: var(--font-mono); font-size: 18px; font-weight: 600; color: var(--ink); }

    .card.result.profit { background: var(--pos-bg); border-color: var(--pos-line); box-shadow: var(--shadow-sm), inset 3px 0 0 var(--pos); }
    /* Neto negativo = "sin oportunidad" (informativo), no una pérdida realizada → ámbar, no rojo. */
    .card.result.loss { background: var(--warn-bg); border-color: var(--warn-line); }
    .card.result.loss h3::before { background: var(--warn); }

    .no-arb {
      display: flex; flex-direction: column; gap: 6px;
      margin-top: 8px; padding: 16px 14px; border-radius: var(--r);
      background: var(--surface); border: 1px solid var(--warn-line);
    }
    .no-arb strong { font-family: var(--font-display); font-size: 14px; font-weight: 700; color: var(--warn); }
    .no-arb span { font-size: 12px; color: var(--ink-2); line-height: 1.55; }

    .steps { display: flex; flex-direction: column; gap: 5px; }
    .step { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; color: var(--ink-2); }
    .step .val { font-family: var(--font-mono); font-weight: 600; color: var(--ink); }
    .step.muted { color: var(--ink-3); }
    .step.muted .val { color: var(--ink-3); }
    .step.net { font-size: 13px; font-weight: 600; }
    .step.net .lbl { color: var(--pos); }
    .step.net .val { color: var(--pos); }
    .step.net.big-net { font-size: 15px; }
    .step.net.big-net .lbl, .step.net.big-net .val { color: var(--pos-strong); }
    .step.net.big-net .val { font-size: 19px; font-weight: 700; }
    .card.result.loss .step.net .lbl,
    .card.result.loss .step.net .val { color: var(--neg); }
    .steps hr { border: 0; border-top: 1px solid var(--line); margin: 8px 0 6px; }
    .disclaimer { margin: 12px 0 0; font-size: 11px; color: var(--ink-3); line-height: 1.55; }

    .empty {
      padding: 40px 20px; color: var(--ink-3); font-size: 13px; text-align: center;
      border: 1px dashed var(--line); border-radius: var(--r-lg); background: var(--surface);
    }

    .table-wrap {
      border: 1px solid var(--line); border-radius: var(--r-lg);
      overflow: auto; max-height: 460px; background: var(--surface);
    }
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    thead { position: sticky; top: 0; z-index: 2; }
    th {
      text-align: left; padding: 9px 12px; background: var(--surface-2);
      font-weight: 600; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em;
      color: var(--ink-3); border-bottom: 1px solid var(--line); white-space: nowrap;
    }
    th.num, td.num { text-align: right; }
    td.num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    td {
      padding: 7px 12px; border-bottom: 1px solid var(--line);
      white-space: nowrap; color: var(--ink);
    }
    td strong { font-family: var(--font-mono); font-weight: 600; }
    tbody tr:hover td { background: var(--surface-2); }
    tr.sel-buy td { background: var(--accent-sf); }
    tr.sel-sell td { background: var(--warn-bg); }
    tr.sel-buy.sel-sell td { background: var(--pos-bg); }
  `],
})
export class ArbitrageComponent {
  // --- Inputs (signals input API) ---
  cedearRows = input<CedearRow[]>([]);
  dollarType = input<DollarType>('MEP');
  settlement = input<Settlement>('H24');
  // true = los datos ya son del plazo real (IOL t0). false = fallback data912 → se estima el CI.
  ciIsReal = input<boolean>(false);
  // Estado de pausa global (refresh congelado). Two-way con el shell.
  paused = input<boolean>(false);
  pausedChange = output<boolean>();

  // --- Internal signals ---
  amountArs = signal<number>(DEFAULTS.amountArs);
  commissionPct = signal<number>(DEFAULTS.commissionPct);
  ciAdjustPct = signal<number>(DEFAULTS.ciAdjustPct);
  // Volumen efectivo mínimo (USD) por punta para considerar un par operable.
  minUsdVol = signal<number>(DEFAULTS.minUsdVol);
  // Manual override of auto-selection (null = follow automatic best)
  manualBuy = signal<string | null>(null);
  manualSell = signal<string | null>(null);

  // Re-expose helpers for the template
  settlementLabel = settlementLabel;
  volBuy = buyLegUsd;
  volSell = sellLegUsd;
  // Profundidad operable por punta en UNIDADES (misma convención que computeTrade).
  volBuyUnits = (p: ArbPair) => Math.min(p.qArsAsk, p.qUsdBid);
  volSellUnits = (p: ArbPair) => Math.min(p.qUsdAsk, p.qArsBid);
  // Símbolo del par en dólares (ej. SHEL → SHELD) según el tipo de dólar.
  usdTicker = (base: string) => base + SUFFIX[this.dollarType()];

  // --- Pairs from shared engine ---
  pairs = computed<ArbPair[]>(() =>
    buildPairs(this.cedearRows(), {
      suffix: SUFFIX[this.dollarType()],
      settlement: this.settlement(),
      ciAdjustPct: this.settlement() === 'CI' && !this.ciIsReal() ? this.ciAdjustPct() : 0,
    })
  );

  // Solo los pares con volumen efectivo suficiente en cada punta.
  buyOptions = computed(() =>
    this.pairs()
      .filter(p => buyLegUsd(p) >= this.minUsdVol())
      .sort((a, b) => a.dolarVenta - b.dolarVenta)
  );

  sellOptions = computed(() =>
    this.pairs()
      .filter(p => sellLegUsd(p) >= this.minUsdVol())
      .sort((a, b) => b.dolarCompra - a.dolarCompra)
  );

  // Tabla: pares con al menos una punta operable al mínimo, ordenados por dolarVenta.
  pairsSorted = computed(() => {
    const min = this.minUsdVol();
    return this.pairs()
      .filter(p => buyLegUsd(p) >= min || sellLegUsd(p) >= min)
      .sort((a, b) => a.dolarVenta - b.dolarVenta);
  });

  // --- Auto-selection: mejor cotización CON volumen ≥ mínimo ----------------
  selectedBuy = computed<ArbPair | null>(() => {
    const m = this.manualBuy();
    if (m) {
      const found = this.pairs().find(p => p.base === m);
      if (found) return found;
    }
    return bestBuy(this.pairs(), this.minUsdVol());
  });

  selectedSell = computed<ArbPair | null>(() => {
    const m = this.manualSell();
    if (m) {
      const found = this.pairs().find(p => p.base === m);
      if (found) return found;
    }
    return bestSell(this.pairs(), this.minUsdVol());
  });

  // --- Trade result from shared engine (gross + net + real volume) ---
  trade = computed<TradeResult | null>(() => {
    const buy = this.selectedBuy();
    const sell = this.selectedSell();
    if (!buy || !sell) return null;
    return computeTrade(buy, sell, {
      amountArs: this.amountArs(),
      commissionPct: this.commissionPct(),
    });
  });

  // Elegir manualmente un CEDEAR congela la página (pausa el refresh) para poder
  // ir al broker y operar sin que la selección/precios cambien.
  onManualBuy(value: string | null) {
    const t = value || null;
    this.manualBuy.set(t);
    if (t) this.pausedChange.emit(true);
  }

  onManualSell(value: string | null) {
    const t = value || null;
    this.manualSell.set(t);
    if (t) this.pausedChange.emit(true);
  }

  freeze() {
    this.pausedChange.emit(true);
  }

  // Volver a vivo: descongelar y soltar la selección manual (vuelve al auto-mejor).
  unfreeze() {
    this.manualBuy.set(null);
    this.manualSell.set(null);
    this.pausedChange.emit(false);
  }

  fmt(v: number | null | undefined, dec = 2): string {
    if (v == null || !isFinite(v)) return '–';
    return v.toLocaleString('es-AR', {
      maximumFractionDigits: dec,
      minimumFractionDigits: dec,
    });
  }
}
