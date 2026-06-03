import type {
  ArbPair,
  CedearRow,
  Settlement,
  TradeResult,
} from './market.config';

/**
 * Lower/upper sanity bounds for a plausible ARS/USD rate. Anything outside this
 * range is treated as a bad/stale quote and discarded.
 */
const MIN_DOLLAR = 500;
const MAX_DOLLAR = 5000;

/** True when `n` is a usable, strictly-positive price. */
function validPrice(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/**
 * Build the arbitrage pairs from a raw feed snapshot.
 *
 * For every ARS leg (a symbol that does NOT end in 'C'/'D') we look up its USD
 * twin `base + suffix`. The dollar rate is derived per the shared convention:
 *
 *   dolarCompra = arsBid / usdAsk   (you SELL usd → bring dollars in, LOWEST)
 *   dolarVenta  = arsAsk / usdBid   (you BUY usd  → take dollars out, HIGHEST)
 *
 * For CI settlement the 24h book is widened by `ciAdjustPct` (venta up,
 * compra down), since CI typically trades with a slightly wider spread.
 */
export function buildPairs(
  rows: CedearRow[],
  opts: { suffix: 'D' | 'C'; settlement: Settlement; ciAdjustPct: number },
): ArbPair[] {
  const { suffix, settlement, ciAdjustPct } = opts;

  const bySymbol = new Map<string, CedearRow>();
  for (const row of rows) {
    if (row && typeof row.symbol === 'string') {
      bySymbol.set(row.symbol, row);
    }
  }

  const pairs: ArbPair[] = [];

  for (const ars of bySymbol.values()) {
    const base = ars.symbol;

    // Skip USD legs themselves so we only iterate ARS bases once.
    if (base.endsWith('C') || base.endsWith('D')) continue;

    const usd = bySymbol.get(base + suffix);
    if (!usd) continue;

    const arsBid = +ars.px_bid;
    const arsAsk = +ars.px_ask;
    const usdBid = +usd.px_bid;
    const usdAsk = +usd.px_ask;

    if (
      !validPrice(arsBid) ||
      !validPrice(arsAsk) ||
      !validPrice(usdBid) ||
      !validPrice(usdAsk)
    ) {
      continue;
    }

    // 24h book (real order book).
    let dolarCompra = arsBid / usdAsk;
    let dolarVenta = arsAsk / usdBid;

    // CI is estimated from the 24h book with a configurable wider spread.
    if (settlement === 'CI') {
      dolarVenta = dolarVenta * (1 + ciAdjustPct / 100);
      dolarCompra = dolarCompra * (1 - ciAdjustPct / 100);
    }

    if (
      dolarVenta < MIN_DOLLAR ||
      dolarVenta > MAX_DOLLAR ||
      dolarCompra < MIN_DOLLAR ||
      dolarCompra > MAX_DOLLAR
    ) {
      continue;
    }

    const mid = (dolarVenta + dolarCompra) / 2;
    const spreadPct = mid > 0 ? ((dolarVenta - dolarCompra) / mid) * 100 : 0;

    pairs.push({
      base,
      arsBid,
      arsAsk,
      usdBid,
      usdAsk,
      qArsBid: +ars.q_bid || 0,
      qArsAsk: +ars.q_ask || 0,
      qUsdBid: +usd.q_bid || 0,
      qUsdAsk: +usd.q_ask || 0,
      dolarCompra,
      dolarVenta,
      spreadPct,
    });
  }

  return pairs;
}

/**
 * Effective USD volume available on the BUY leg of a pair: buy the CEDEAR in
 * ARS (bounded by qArsAsk), sell it in USD (bounded by qUsdBid) — the smaller
 * depth valued at usdBid (the dollars you receive).
 */
export function buyLegUsd(p: ArbPair): number {
  return Math.min(p.qArsAsk, p.qUsdBid) * p.usdBid;
}

/**
 * Effective USD volume available on the SELL leg of a pair: buy the CEDEAR in
 * USD (bounded by qUsdAsk), sell it in ARS (bounded by qArsBid) — the smaller
 * depth valued at usdAsk (the dollars you deploy).
 */
export function sellLegUsd(p: ArbPair): number {
  return Math.min(p.qUsdAsk, p.qArsBid) * p.usdAsk;
}

/**
 * Best place to BUY dollars: the pair with the LOWEST dolarVenta
 * (cheapest rate at which you take dollars out), considering ONLY pairs whose
 * buy-leg effective USD volume is at least `minUsdVol`. `null` if none qualify.
 */
export function bestBuy(pairs: ArbPair[], minUsdVol = 0): ArbPair | null {
  let best: ArbPair | null = null;
  for (const p of pairs) {
    if (buyLegUsd(p) < minUsdVol) continue;
    if (best === null || p.dolarVenta < best.dolarVenta) best = p;
  }
  return best;
}

/**
 * Best place to SELL dollars: the pair with the HIGHEST dolarCompra
 * (best rate at which you bring dollars in), considering ONLY pairs whose
 * sell-leg effective USD volume is at least `minUsdVol`. `null` if none qualify.
 */
export function bestSell(pairs: ArbPair[], minUsdVol = 0): ArbPair | null {
  let best: ArbPair | null = null;
  for (const p of pairs) {
    if (sellLegUsd(p) < minUsdVol) continue;
    if (best === null || p.dolarCompra > best.dolarCompra) best = p;
  }
  return best;
}

/**
 * Simulate the full ARS → USD → ARS round-trip:
 *   1) Buy `n1` CEDEAR units in ARS at the buy leg's ask.
 *   2) Sell them in USD at the buy leg's bid → usdMid dollars.
 *   3) Buy `n2` CEDEAR units in USD at the sell leg's ask.
 *   4) Sell them in ARS at the sell leg's bid → arsOut.
 *
 * Returns `null` for non-positive amounts or invalid prices.
 */
export function computeTrade(
  buy: ArbPair,
  sell: ArbPair,
  opts: { amountArs: number; commissionPct: number },
): TradeResult | null {
  const { amountArs, commissionPct } = opts;

  if (!(amountArs > 0)) return null;
  if (
    !validPrice(buy.arsAsk) ||
    !validPrice(buy.usdBid) ||
    !validPrice(sell.usdAsk) ||
    !validPrice(sell.arsBid)
  ) {
    return null;
  }

  const n1 = amountArs / buy.arsAsk;
  const usdMid = n1 * buy.usdBid;
  const n2 = usdMid / sell.usdAsk;
  const arsOut = n2 * sell.arsBid;

  const grossProfit = arsOut - amountArs;
  const grossPct = (grossProfit / amountArs) * 100;

  // commissionPct is the TOTAL cost as a % of the operated amount, covering
  // both legs of the round-trip (buy + sell fees, market, etc.).
  const netProfit = grossProfit - amountArs * (commissionPct / 100);
  const netPct = (netProfit / amountArs) * 100;

  // Real tradeable depth: each leg is bounded by the two punta it crosses, and
  // the round-trip is limited by the SMALLER of the buy and sell legs.
  const buyVolUnits = Math.min(buy.qArsAsk, buy.qUsdBid);
  const sellVolUnits = Math.min(sell.qUsdAsk, sell.qArsBid);
  const tradeableUnits = Math.min(buyVolUnits, sellVolUnits);
  const tradeableArs = tradeableUnits * buy.arsAsk;
  const tradeableUsd = tradeableUnits * buy.usdBid;

  return {
    buy,
    sell,
    n1,
    usdMid,
    n2,
    arsOut,
    grossProfit,
    grossPct,
    commissionPct,
    netProfit,
    netPct,
    buyVolUnits,
    sellVolUnits,
    tradeableUnits,
    tradeableArs,
    tradeableUsd,
  };
}
