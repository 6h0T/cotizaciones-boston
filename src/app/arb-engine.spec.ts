import { describe, expect, it } from 'vitest';
import type { CedearRow } from './market.config';
import { bestBuy, bestSell, buildPairs, computeTrade } from './arb-engine';

/** Minimal CedearRow factory with sane defaults. */
function row(symbol: string, p: Partial<CedearRow> = {}): CedearRow {
  return {
    symbol,
    q_bid: 100,
    px_bid: 1000,
    px_ask: 1010,
    q_ask: 100,
    v: 0,
    q_op: 0,
    c: 0,
    pct_change: 0,
    ...p,
  };
}

/**
 * A synthetic AAPL pair where the ARS leg trades ~1450 ARS and the USD (MEP)
 * leg ~1 USD, so the derived dollar lands in a realistic ~1450 range.
 */
function aaplRows(): CedearRow[] {
  return [
    row('AAPL', { px_bid: 14520, px_ask: 14580, q_bid: 50, q_ask: 40 }),
    row('AAPLD', { px_bid: 10, px_ask: 10.02, q_bid: 30, q_ask: 25 }),
  ];
}

describe('buildPairs', () => {
  it('builds the correct pair and keeps dolarCompra < dolarVenta', () => {
    const pairs = buildPairs(aaplRows(), {
      suffix: 'D',
      settlement: 'H24',
      ciAdjustPct: 0.3,
    });
    expect(pairs).toHaveLength(1);
    const p = pairs[0];
    expect(p.base).toBe('AAPL');
    // dolarCompra = arsBid/usdAsk, dolarVenta = arsAsk/usdBid
    expect(p.dolarCompra).toBeCloseTo(14520 / 10.02, 6);
    expect(p.dolarVenta).toBeCloseTo(14580 / 10, 6);
    expect(p.dolarCompra).toBeLessThan(p.dolarVenta);
  });

  it('discards symbols without a USD leg', () => {
    const rows: CedearRow[] = [
      ...aaplRows(),
      // KO has no KOD leg → must be skipped.
      row('KO', { px_bid: 14000, px_ask: 14100 }),
    ];
    const pairs = buildPairs(rows, {
      suffix: 'D',
      settlement: 'H24',
      ciAdjustPct: 0.3,
    });
    expect(pairs.map((p) => p.base)).toEqual(['AAPL']);
  });

  it('does not treat a symbol ending in D/C as a base', () => {
    // Only the USD legs exist; nothing should pair.
    const rows: CedearRow[] = [
      row('AAPLD', { px_bid: 10, px_ask: 10.02 }),
      row('AAPLC', { px_bid: 10.4, px_ask: 10.42 }),
    ];
    const pairs = buildPairs(rows, {
      suffix: 'D',
      settlement: 'H24',
      ciAdjustPct: 0.3,
    });
    expect(pairs).toHaveLength(0);
  });

  it('discards pairs with zero/invalid prices', () => {
    const rows: CedearRow[] = [
      row('AAPL', { px_bid: 0, px_ask: 14580 }),
      row('AAPLD', { px_bid: 10, px_ask: 10.02 }),
    ];
    const pairs = buildPairs(rows, {
      suffix: 'D',
      settlement: 'H24',
      ciAdjustPct: 0.3,
    });
    expect(pairs).toHaveLength(0);
  });

  it('discards rates outside the [500, 5000] band', () => {
    // arsAsk/usdBid ≈ 1 → way below MIN_DOLLAR.
    const rows: CedearRow[] = [
      row('AAPL', { px_bid: 9.9, px_ask: 10 }),
      row('AAPLD', { px_bid: 10, px_ask: 10.02 }),
    ];
    const pairs = buildPairs(rows, {
      suffix: 'D',
      settlement: 'H24',
      ciAdjustPct: 0.3,
    });
    expect(pairs).toHaveLength(0);
  });

  it('CI widens the spread: venta up and compra down vs H24', () => {
    const h24 = buildPairs(aaplRows(), {
      suffix: 'D',
      settlement: 'H24',
      ciAdjustPct: 0.3,
    })[0];
    const ci = buildPairs(aaplRows(), {
      suffix: 'D',
      settlement: 'CI',
      ciAdjustPct: 0.3,
    })[0];

    expect(ci.dolarVenta).toBeGreaterThan(h24.dolarVenta);
    expect(ci.dolarCompra).toBeLessThan(h24.dolarCompra);
    expect(ci.dolarVenta).toBeCloseTo(h24.dolarVenta * 1.003, 6);
    expect(ci.dolarCompra).toBeCloseTo(h24.dolarCompra * 0.997, 6);
    // Spread must remain consistent.
    expect(ci.dolarCompra).toBeLessThan(ci.dolarVenta);
  });

  it('works with the C suffix (CCL)', () => {
    const rows: CedearRow[] = [
      row('AAPL', { px_bid: 14520, px_ask: 14580 }),
      row('AAPLC', { px_bid: 9.6, px_ask: 9.62 }),
    ];
    const pairs = buildPairs(rows, {
      suffix: 'C',
      settlement: 'H24',
      ciAdjustPct: 0.3,
    });
    expect(pairs).toHaveLength(1);
    expect(pairs[0].dolarCompra).toBeLessThan(pairs[0].dolarVenta);
  });
});

describe('bestBuy / bestSell', () => {
  const pairs = buildPairs(
    [
      // AAPL: cheaper dollar.
      row('AAPL', { px_bid: 14520, px_ask: 14580 }),
      row('AAPLD', { px_bid: 10, px_ask: 10.02 }),
      // KO: more expensive dollar.
      row('KO', { px_bid: 15020, px_ask: 15080 }),
      row('KOD', { px_bid: 10, px_ask: 10.02 }),
    ],
    { suffix: 'D', settlement: 'H24', ciAdjustPct: 0.3 },
  );

  it('bestBuy returns the pair with the lowest dolarVenta', () => {
    const buy = bestBuy(pairs);
    expect(buy?.base).toBe('AAPL');
    const minVenta = Math.min(...pairs.map((p) => p.dolarVenta));
    expect(buy?.dolarVenta).toBe(minVenta);
  });

  it('bestSell returns the pair with the highest dolarCompra', () => {
    const sell = bestSell(pairs);
    expect(sell?.base).toBe('KO');
    const maxCompra = Math.max(...pairs.map((p) => p.dolarCompra));
    expect(sell?.dolarCompra).toBe(maxCompra);
  });

  it('returns null for empty input', () => {
    expect(bestBuy([])).toBeNull();
    expect(bestSell([])).toBeNull();
  });
});

describe('computeTrade', () => {
  const pairs = buildPairs(
    [
      row('AAPL', {
        px_bid: 14520,
        px_ask: 14580,
        q_bid: 50,
        q_ask: 40,
      }),
      row('AAPLD', { px_bid: 10, px_ask: 10.02, q_bid: 30, q_ask: 25 }),
      row('KO', { px_bid: 15020, px_ask: 15080, q_bid: 60, q_ask: 55 }),
      row('KOD', { px_bid: 10, px_ask: 10.02, q_bid: 20, q_ask: 35 }),
    ],
    { suffix: 'D', settlement: 'H24', ciAdjustPct: 0.3 },
  );
  const buy = bestBuy(pairs)!;
  const sell = bestSell(pairs)!;

  it('computes a coherent round-trip', () => {
    const t = computeTrade(buy, sell, {
      amountArs: 1_000_000,
      commissionPct: 0,
    })!;
    expect(t.n1).toBeCloseTo(1_000_000 / buy.arsAsk, 6);
    expect(t.usdMid).toBeCloseTo(t.n1 * buy.usdBid, 6);
    expect(t.n2).toBeCloseTo(t.usdMid / sell.usdAsk, 6);
    expect(t.arsOut).toBeCloseTo(t.n2 * sell.arsBid, 6);
    expect(t.grossProfit).toBeCloseTo(t.arsOut - 1_000_000, 6);
    expect(t.commissionPct).toBe(0);
  });

  it('higher commissionPct yields lower netProfit', () => {
    const low = computeTrade(buy, sell, {
      amountArs: 1_000_000,
      commissionPct: 0.5,
    })!;
    const high = computeTrade(buy, sell, {
      amountArs: 1_000_000,
      commissionPct: 1.5,
    })!;
    expect(high.netProfit).toBeLessThan(low.netProfit);
    // grossProfit is unaffected by commission.
    expect(high.grossProfit).toBeCloseTo(low.grossProfit, 6);
  });

  it('tradeableUnits = min of the four relevant depths', () => {
    const t = computeTrade(buy, sell, {
      amountArs: 1_000_000,
      commissionPct: 0,
    })!;
    // buy = AAPL: qArsAsk=40, qUsdBid=30 → buyVol=30
    // sell = KO:  qUsdAsk=35, qArsBid=60 → sellVol=35
    expect(t.buyVolUnits).toBe(Math.min(buy.qArsAsk, buy.qUsdBid));
    expect(t.sellVolUnits).toBe(Math.min(sell.qUsdAsk, sell.qArsBid));
    expect(t.tradeableUnits).toBe(
      Math.min(buy.qArsAsk, buy.qUsdBid, sell.qUsdAsk, sell.qArsBid),
    );
    expect(t.tradeableUnits).toBe(30);
    expect(t.tradeableArs).toBeCloseTo(30 * buy.arsAsk, 6);
    expect(t.tradeableUsd).toBeCloseTo(30 * buy.usdBid, 6);
  });

  it('returns null for non-positive amount', () => {
    expect(
      computeTrade(buy, sell, { amountArs: 0, commissionPct: 0 }),
    ).toBeNull();
    expect(
      computeTrade(buy, sell, { amountArs: -100, commissionPct: 0 }),
    ).toBeNull();
  });
});
