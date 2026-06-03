import { Component, computed, input, signal } from '@angular/core';
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

import { buildPairs, bestBuy, bestSell, computeTrade } from './arb-engine';

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

        <span class="pair-count">{{ pairs().length }} pares disponibles</span>
      </div>

      @if (settlement() === 'CI') {
        @if (ciIsReal()) {
          <div class="ci-note real">
            Contado Inmediato — precios reales de pantalla (IOL, plazo t0).
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
        <!-- Auto-selección prominente -->
        <div class="auto-banner">
          @if (selectedBuy(); as b) {
            <div class="auto-pill buy">
              <span class="auto-action">Comprás CEDEAR</span>
              <span class="auto-ticker">{{ b.base }}</span>
              <span class="auto-rate">$ {{ fmt(b.dolarVenta, 2) }} / USD</span>
            </div>
          }
          @if (selectedSell(); as s) {
            <div class="auto-pill sell">
              <span class="auto-action">Vendés CEDEAR</span>
              <span class="auto-ticker">{{ s.base }}</span>
              <span class="auto-rate">$ {{ fmt(s.dolarCompra, 2) }} / USD</span>
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
              (ngModelChange)="manualBuy.set($event || null)"
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
                <div class="row ticker-row">
                  <span>CEDEAR a comprar</span>
                  <strong class="ticker-chip">{{ b.base }}</strong>
                </div>
                <div class="row">
                  <span>Pago en ARS (ask)</span>
                  <strong>{{ fmt(b.arsAsk, 2) }}</strong>
                </div>
                <div class="row">
                  <span>Recibo en USD (bid)</span>
                  <strong>{{ fmt(b.usdBid, 4) }}</strong>
                </div>
                <div class="row big">
                  <span>$ Venta (compro USD)</span>
                  <strong class="hi">$ {{ fmt(b.dolarVenta, 2) }}</strong>
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
              (ngModelChange)="manualSell.set($event || null)"
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
                <div class="row ticker-row">
                  <span>CEDEAR a vender</span>
                  <strong class="ticker-chip">{{ s.base }}</strong>
                </div>
                <div class="row">
                  <span>Pago en USD (ask)</span>
                  <strong>{{ fmt(s.usdAsk, 4) }}</strong>
                </div>
                <div class="row">
                  <span>Recibo en ARS (bid)</span>
                  <strong>{{ fmt(s.arsBid, 2) }}</strong>
                </div>
                <div class="row big">
                  <span>$ Compra (vendo USD)</span>
                  <strong class="hi">$ {{ fmt(s.dolarCompra, 2) }}</strong>
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

              <!-- Volumen operable real de AMBAS puntas -->
              <div class="vol-box">
                <div class="vol-title">Volumen operable real = mínimo(compra, venta)</div>
                <div class="vol-grid">
                  <div class="vol-cell">
                    <span class="vol-lbl">Lado compra</span>
                    <span class="vol-val">{{ fmt(t.buyVolUnits, 0) }} u.</span>
                  </div>
                  <div class="vol-cell">
                    <span class="vol-lbl">Lado venta</span>
                    <span class="vol-val">{{ fmt(t.sellVolUnits, 0) }} u.</span>
                  </div>
                  <div class="vol-cell hero">
                    <span class="vol-lbl">Operable (mín.)</span>
                    <span class="vol-val">{{ fmt(t.tradeableUnits, 0) }} u.</span>
                  </div>
                </div>
                <div class="vol-foot">
                  <span>$ {{ fmt(t.tradeableArs, 0) }} ARS</span>
                  <span>USD {{ fmt(t.tradeableUsd, 2) }}</span>
                </div>
              </div>

              <p class="disclaimer">
                Neto = bruto menos {{ fmt(t.commissionPct, 2) }} % de comisión/gastos.
                No incluye derechos de mercado, parking ni impuestos.
                Operación válida sólo hasta el volumen operable real (mínimo de ambas puntas).
              </p>
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
    .arb { padding: 4px 0 24px; }
    .arb-head {
      display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
      margin-bottom: 18px;
    }
    .badge {
      display: inline-flex; align-items: center; padding: 6px 12px;
      border-radius: 8px; font-size: 13px; font-weight: 700; letter-spacing: 0.02em;
    }
    .badge.dollar { background: #16a34a; color: #ffffff; }
    .badge.plazo { background: #eef2ff; color: #4338ca; border: 1px solid #c7d2fe; }
    .monto { font-size: 13px; color: #374151; display: inline-flex; align-items: center; gap: 6px; }
    .monto input {
      width: 140px; background: #ffffff; color: #111827;
      border: 1px solid #d1d5db; border-radius: 6px; padding: 6px 8px; font-size: 13px;
    }
    .monto.comm input { width: 90px; }
    .monto.ci input { width: 90px; }
    .monto.ci { color: #b45309; font-weight: 600; }
    .pair-count { margin-left: auto; font-size: 12px; color: #6b7280; }

    .ci-note {
      margin: 0 0 16px; padding: 10px 14px; border-radius: 8px;
      background: #fffbeb; border: 1px solid #fde68a; color: #92400e; font-size: 12px;
    }
    .ci-note.real {
      background: #f0fdf4; border-color: #bbf7d0; color: #166534;
    }

    .auto-banner {
      display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px;
    }
    .auto-pill {
      flex: 1 1 240px; display: flex; align-items: baseline; gap: 10px;
      padding: 12px 16px; border-radius: 12px; color: #ffffff;
    }
    .auto-pill.buy { background: linear-gradient(135deg, #2563eb, #1d4ed8); }
    .auto-pill.sell { background: linear-gradient(135deg, #f59e0b, #d97706); }
    .auto-pill .auto-action { font-size: 13px; font-weight: 500; opacity: 0.92; }
    .auto-pill .auto-ticker { font-size: 22px; font-weight: 800; letter-spacing: 0.02em; }
    .auto-pill .auto-rate { margin-left: auto; font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }

    .grid {
      display: grid; gap: 14px;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      margin-bottom: 22px;
    }
    .card {
      background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px;
    }
    .card h3 { margin: 0 0 4px; font-size: 14px; font-weight: 700; color: #0f172a; }
    .card .hint { margin: 0 0 12px; font-size: 11px; color: #9ca3af; }
    .card select {
      width: 100%; padding: 8px 10px; font-size: 13px;
      border: 1px solid #d1d5db; border-radius: 8px; background: #ffffff; color: #111827;
    }
    .card-body { margin-top: 12px; }
    .row {
      display: flex; justify-content: space-between; padding: 4px 0;
      font-size: 12px; color: #6b7280;
    }
    .row strong { color: #111827; font-weight: 600; }
    .row.ticker-row { padding-bottom: 8px; }
    .ticker-chip {
      background: #f1f5f9; padding: 2px 10px; border-radius: 6px;
      font-size: 14px; font-weight: 800; color: #0f172a;
    }
    .row.big { padding: 10px 0 4px; border-top: 1px dashed #e5e7eb; margin-top: 8px; font-size: 13px; }
    .row.big .hi { font-size: 18px; font-weight: 700; color: #0f172a; }

    .card.buy { border-left: 3px solid #2563eb; }
    .card.sell { border-left: 3px solid #f59e0b; }
    .card.result { border-left: 3px solid #94a3b8; }
    .card.result.profit { border-left-color: #16a34a; background: #f0fdf4; }
    .card.result.loss { border-left-color: #dc2626; background: #fef2f2; }

    .steps { display: flex; flex-direction: column; gap: 4px; }
    .step { display: flex; justify-content: space-between; font-size: 12px; color: #374151; }
    .step .val { font-variant-numeric: tabular-nums; font-weight: 600; color: #111827; }
    .step.muted { color: #9ca3af; }
    .step.muted .val { color: #9ca3af; }
    .step.net { font-size: 14px; font-weight: 700; }
    .step.net .lbl { color: #065f46; }
    .step.net .val { color: #065f46; }
    .step.net.big-net { font-size: 17px; }
    .step.net.big-net .val { font-size: 18px; }
    .card.result.loss .step.net .lbl,
    .card.result.loss .step.net .val { color: #991b1b; }
    .steps hr { border: 0; border-top: 1px dashed #e5e7eb; margin: 8px 0 6px; }
    .disclaimer { margin: 10px 0 0; font-size: 11px; color: #6b7280; line-height: 1.5; }

    .vol-box {
      margin-top: 14px; padding: 12px; border-radius: 10px;
      background: #f8fafc; border: 1px solid #e2e8f0;
    }
    .vol-title { font-size: 12px; font-weight: 700; color: #0f172a; margin-bottom: 10px; }
    .vol-grid { display: flex; gap: 8px; }
    .vol-cell {
      flex: 1; display: flex; flex-direction: column; gap: 2px;
      padding: 8px; border-radius: 8px; background: #ffffff; border: 1px solid #e5e7eb;
    }
    .vol-cell.hero { background: #ecfdf5; border-color: #6ee7b7; }
    .vol-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7280; }
    .vol-val { font-size: 15px; font-weight: 700; color: #111827; font-variant-numeric: tabular-nums; }
    .vol-cell.hero .vol-val { color: #047857; }
    .vol-foot {
      display: flex; justify-content: space-between; margin-top: 8px;
      font-size: 12px; font-weight: 600; color: #374151; font-variant-numeric: tabular-nums;
    }

    .empty { padding: 24px; color: #9ca3af; font-size: 13px; text-align: center; }

    .table-wrap {
      border: 1px solid #e5e7eb; border-radius: 10px;
      overflow: auto; max-height: 460px; background: #ffffff;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    thead { position: sticky; top: 0; background: #f9fafb; z-index: 2; }
    th {
      text-align: left; padding: 10px 12px;
      font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
      color: #6b7280; border-bottom: 1px solid #e5e7eb; white-space: nowrap;
    }
    th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
    td {
      padding: 8px 12px; border-bottom: 1px solid #f1f3f5;
      white-space: nowrap; color: #1f2937;
    }
    tr:hover td { background: #f9fafb; }
    tr.sel-buy td { background: #eff6ff; }
    tr.sel-sell td { background: #fffbeb; }
    tr.sel-buy.sel-sell td { background: #ecfeff; }
  `],
})
export class ArbitrageComponent {
  // --- Inputs (signals input API) ---
  cedearRows = input<CedearRow[]>([]);
  dollarType = input<DollarType>('MEP');
  settlement = input<Settlement>('H24');
  // true = los datos ya son del plazo real (IOL t0). false = fallback data912 → se estima el CI.
  ciIsReal = input<boolean>(false);

  // --- Internal signals ---
  amountArs = signal<number>(DEFAULTS.amountArs);
  commissionPct = signal<number>(DEFAULTS.commissionPct);
  ciAdjustPct = signal<number>(DEFAULTS.ciAdjustPct);
  // Manual override of auto-selection (null = follow automatic best)
  manualBuy = signal<string | null>(null);
  manualSell = signal<string | null>(null);

  // Re-expose helper for the template
  settlementLabel = settlementLabel;

  // --- Pairs from shared engine ---
  pairs = computed<ArbPair[]>(() =>
    buildPairs(this.cedearRows(), {
      suffix: SUFFIX[this.dollarType()],
      settlement: this.settlement(),
      ciAdjustPct: this.settlement() === 'CI' && !this.ciIsReal() ? this.ciAdjustPct() : 0,
    })
  );

  buyOptions = computed(() =>
    [...this.pairs()].sort((a, b) => a.dolarVenta - b.dolarVenta)
  );

  sellOptions = computed(() =>
    [...this.pairs()].sort((a, b) => b.dolarCompra - a.dolarCompra)
  );

  // Table: ordered by dolarVenta asc
  pairsSorted = computed(() =>
    [...this.pairs()].sort((a, b) => a.dolarVenta - b.dolarVenta)
  );

  // --- Auto-selection (always populated; manual override optional) ---
  selectedBuy = computed<ArbPair | null>(() => {
    const m = this.manualBuy();
    if (m) {
      const found = this.pairs().find(p => p.base === m);
      if (found) return found;
    }
    return bestBuy(this.pairs());
  });

  selectedSell = computed<ArbPair | null>(() => {
    const m = this.manualSell();
    if (m) {
      const found = this.pairs().find(p => p.base === m);
      if (found) return found;
    }
    return bestSell(this.pairs());
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

  fmt(v: number | null | undefined, dec = 2): string {
    if (v == null || !isFinite(v)) return '–';
    return v.toLocaleString('es-AR', {
      maximumFractionDigits: dec,
      minimumFractionDigits: dec,
    });
  }
}
