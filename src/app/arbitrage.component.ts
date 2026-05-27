import { Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

interface CedearRow {
  symbol: string;
  q_bid: number;
  px_bid: number;
  px_ask: number;
  q_ask: number;
  v: number;
  q_op: number;
  c: number;
  pct_change: number;
}

interface Pair {
  base: string;
  arsBid: number;
  arsAsk: number;
  usdBid: number;
  usdAsk: number;
  qArsBid: number;
  qArsAsk: number;
  qUsdBid: number;
  qUsdAsk: number;
  dolarVenta: number;
  dolarCompra: number;
  spreadPct: number;
}

const REASONABLE_MIN = 500;
const REASONABLE_MAX = 5000;

@Component({
  selector: 'app-arbitrage',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="arb">
      <div class="arb-head">
        <div class="seg">
          <button
            class="seg-btn"
            [class.on]="variant() === 'D'"
            (click)="variant.set('D')"
          >MEP (D)</button>
          <button
            class="seg-btn"
            [class.on]="variant() === 'C'"
            (click)="variant.set('C')"
          >CCL (C)</button>
        </div>

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

        <span class="pair-count">{{ pairs().length }} pares disponibles</span>
      </div>

      @if (pairs().length === 0) {
        <div class="empty">Esperando datos de CEDEARs…</div>
      } @else {
        <div class="grid">
          <!-- Compro USD -->
          <div class="card buy">
            <h3>1. Compro USD con</h3>
            <p class="hint">El CEDEAR con el dólar más barato</p>
            <select
[ngModel]="buyTicker()"
              (ngModelChange)="buyTicker.set($event)"
            >
              @for (p of buyOptions(); track p.base) {
                <option [value]="p.base">
                  {{ p.base }} — $ {{ fmt(p.dolarVenta, 2) }} / USD
                </option>
              }
            </select>

            @if (selectedBuy(); as b) {
              <div class="card-body">
                <div class="row">
                  <span>Pago en ARS (ask)</span>
                  <strong>{{ fmt(b.arsAsk, 2) }}</strong>
                </div>
                <div class="row">
                  <span>Recibo en USD (bid)</span>
                  <strong>{{ fmt(b.usdBid, 4) }}</strong>
                </div>
                <div class="row big">
                  <span>$ Venta efectivo</span>
                  <strong class="hi">$ {{ fmt(b.dolarVenta, 2) }}</strong>
                </div>
                <div class="row small">
                  <span>Liquidez ARS (ask × q)</span>
                  <span>$ {{ fmt(b.qArsAsk * b.arsAsk, 0) }}</span>
                </div>
              </div>
            }
          </div>

          <!-- Vendo USD -->
          <div class="card sell">
            <h3>2. Vendo USD con</h3>
            <p class="hint">El CEDEAR que paga más ARS por dólar</p>
            <select
[ngModel]="sellTicker()"
              (ngModelChange)="sellTicker.set($event)"
            >
              @for (p of sellOptions(); track p.base) {
                <option [value]="p.base">
                  {{ p.base }} — $ {{ fmt(p.dolarCompra, 2) }} / USD
                </option>
              }
            </select>

            @if (selectedSell(); as s) {
              <div class="card-body">
                <div class="row">
                  <span>Pago en USD (ask)</span>
                  <strong>{{ fmt(s.usdAsk, 4) }}</strong>
                </div>
                <div class="row">
                  <span>Recibo en ARS (bid)</span>
                  <strong>{{ fmt(s.arsBid, 2) }}</strong>
                </div>
                <div class="row big">
                  <span>$ Compra efectivo</span>
                  <strong class="hi">$ {{ fmt(s.dolarCompra, 2) }}</strong>
                </div>
                <div class="row small">
                  <span>Liquidez ARS (bid × q)</span>
                  <span>$ {{ fmt(s.qArsBid * s.arsBid, 0) }}</span>
                </div>
              </div>
            }
          </div>

          <!-- Resultado -->
          <div class="card result" [class.profit]="(trade()?.profit ?? 0) > 0" [class.loss]="(trade()?.profit ?? 0) < 0">
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
                <div class="step total">
                  <span class="lbl">Ganancia bruta</span>
                  <span class="val">$ {{ fmt(t.profit, 2) }}</span>
                </div>
                <div class="step total">
                  <span class="lbl">Rendimiento</span>
                  <span class="val">{{ fmt(t.profitPct, 3) }} %</span>
                </div>
              </div>
              <p class="disclaimer">
                Bruto — no incluye comisiones, derechos de mercado, parking ni impuestos.
                Operación válida sólo si hay liquidez en ambas puntas (ver arriba).
              </p>
            } @else {
              <div class="empty">Seleccioná un par para ver el resultado.</div>
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
    .seg { display: inline-flex; border: 1px solid #d1d5db; border-radius: 8px; overflow: hidden; }
    .seg-btn {
      background: #ffffff; border: 0; padding: 8px 14px; font-size: 13px; color: #374151;
      cursor: pointer; border-right: 1px solid #d1d5db;
    }
    .seg-btn:last-child { border-right: 0; }
    .seg-btn.on { background: #16a34a; color: #ffffff; font-weight: 600; }
    .monto { font-size: 13px; color: #374151; display: inline-flex; align-items: center; gap: 6px; }
    .monto input {
      width: 140px; background: #ffffff; color: #111827;
      border: 1px solid #d1d5db; border-radius: 6px; padding: 6px 8px; font-size: 13px;
    }
    .pair-count { margin-left: auto; font-size: 12px; color: #6b7280; }

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
    .card select:disabled { background: #f3f4f6; color: #6b7280; }
    .card-body { margin-top: 12px; }
    .row {
      display: flex; justify-content: space-between; padding: 4px 0;
      font-size: 12px; color: #6b7280;
    }
    .row strong { color: #111827; font-weight: 600; }
    .row.big { padding: 10px 0 4px; border-top: 1px dashed #e5e7eb; margin-top: 8px; font-size: 13px; }
    .row.big .hi { font-size: 18px; font-weight: 700; color: #0f172a; }
    .row.small { font-size: 11px; color: #9ca3af; }

    .card.buy { border-left: 3px solid #2563eb; }
    .card.sell { border-left: 3px solid #f59e0b; }
    .card.result { border-left: 3px solid #94a3b8; }
    .card.result.profit { border-left-color: #16a34a; background: #f0fdf4; }
    .card.result.loss { border-left-color: #dc2626; background: #fef2f2; }

    .steps { display: flex; flex-direction: column; gap: 4px; }
    .step { display: flex; justify-content: space-between; font-size: 12px; color: #374151; }
    .step .val { font-variant-numeric: tabular-nums; font-weight: 600; color: #111827; }
    .step.total { font-size: 14px; }
    .steps hr { border: 0; border-top: 1px dashed #e5e7eb; margin: 8px 0 6px; }
    .disclaimer { margin: 10px 0 0; font-size: 11px; color: #6b7280; line-height: 1.5; }

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
  cedearRows = input<any[]>([]);

  variant = signal<'D' | 'C'>('D');
  amountArs = signal(1_000_000);
  buyTicker = signal('');
  sellTicker = signal('');

  private rowMap = computed(() => {
    const map = new Map<string, CedearRow>();
    for (const r of (this.cedearRows() ?? []) as CedearRow[]) {
      if (r?.symbol) map.set(r.symbol, r);
    }
    return map;
  });

  pairs = computed<Pair[]>(() => {
    const map = this.rowMap();
    const suffix = this.variant();
    const out: Pair[] = [];
    for (const [sym, ars] of map) {
      const usd = map.get(sym + suffix);
      if (!usd) continue;
      const arsBid = +ars.px_bid, arsAsk = +ars.px_ask;
      const usdBid = +usd.px_bid, usdAsk = +usd.px_ask;
      if (!arsBid || !arsAsk || !usdBid || !usdAsk) continue;
      const dolarVenta = arsAsk / usdBid;
      const dolarCompra = arsBid / usdAsk;
      if (dolarVenta < REASONABLE_MIN || dolarVenta > REASONABLE_MAX) continue;
      if (dolarCompra < REASONABLE_MIN || dolarCompra > REASONABLE_MAX) continue;
      const mid = (dolarVenta + dolarCompra) / 2;
      const spreadPct = mid > 0 ? ((dolarVenta - dolarCompra) / mid) * 100 : 0;
      out.push({
        base: sym,
        arsBid, arsAsk, usdBid, usdAsk,
        qArsBid: +ars.q_bid || 0,
        qArsAsk: +ars.q_ask || 0,
        qUsdBid: +usd.q_bid || 0,
        qUsdAsk: +usd.q_ask || 0,
        dolarVenta, dolarCompra, spreadPct,
      });
    }
    return out;
  });

  buyOptions = computed(() =>
    [...this.pairs()].sort((a, b) => a.dolarVenta - b.dolarVenta)
  );

  sellOptions = computed(() =>
    [...this.pairs()].sort((a, b) => b.dolarCompra - a.dolarCompra)
  );

  pairsSorted = computed(() =>
    [...this.pairs()].sort((a, b) => a.dolarVenta - b.dolarVenta)
  );

  selectedBuy = computed<Pair | null>(() => {
    const t = this.buyTicker();
    return this.pairs().find(p => p.base === t) ?? this.buyOptions()[0] ?? null;
  });

  selectedSell = computed<Pair | null>(() => {
    const t = this.sellTicker();
    return this.pairs().find(p => p.base === t) ?? this.sellOptions()[0] ?? null;
  });

  trade = computed(() => {
    const buy = this.selectedBuy();
    const sell = this.selectedSell();
    const amt = this.amountArs();
    if (!buy || !sell || !amt || amt <= 0) return null;
    const n1 = amt / buy.arsAsk;
    const usdMid = n1 * buy.usdBid;
    const n2 = usdMid / sell.usdAsk;
    const arsOut = n2 * sell.arsBid;
    const profit = arsOut - amt;
    const profitPct = (profit / amt) * 100;
    return { n1, usdMid, n2, arsOut, profit, profitPct };
  });

  fmt(v: number | null | undefined, dec = 2): string {
    if (v == null || !isFinite(v)) return '–';
    return v.toLocaleString('es-AR', {
      maximumFractionDigits: dec,
      minimumFractionDigits: dec,
    });
  }
}
