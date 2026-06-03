/**
 * market.config.ts — Hogar canónico de tipos compartidos y configuración.
 * Los demás módulos (motor de arbitraje, UI, data layer) importan desde acá.
 * NO incluir lógica de cálculo de pares (eso vive en el motor).
 */

// ── Tipos de dólar y plazo ──────────────────────────────────────────────────
export type DollarType = 'MEP' | 'CCL';
export type Settlement = 'CI' | 'H24'; // CI=T+0 (estimado), H24=T+1/24hs (libro real)

// ── Fila cruda del libro de un CEDEAR ───────────────────────────────────────
export interface CedearRow {
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

/**
 * Par de un activo cotizado en ARS y en USD.
 * Convención de dólar (la usa el motor):
 *   dolarCompra = arsBid / usdAsk  (vendés USD, valor más bajo)
 *   dolarVenta  = arsAsk / usdBid  (comprás USD, valor más alto)
 * Siempre dolarCompra < dolarVenta.
 */
export interface ArbPair {
  base: string;
  arsBid: number;
  arsAsk: number;
  usdBid: number;
  usdAsk: number;
  qArsBid: number;
  qArsAsk: number;
  qUsdBid: number;
  qUsdAsk: number;
  dolarCompra: number;
  dolarVenta: number;
  spreadPct: number;
}

// ── Resultado de una operación de arbitraje round-trip ──────────────────────
export interface TradeResult {
  buy: ArbPair;
  sell: ArbPair;
  n1: number;
  usdMid: number;
  n2: number;
  arsOut: number;
  grossProfit: number;
  grossPct: number;
  commissionPct: number;
  netProfit: number;
  netPct: number;
  buyVolUnits: number;
  sellVolUnits: number;
  tradeableUnits: number;
  tradeableArs: number;
  tradeableUsd: number;
}

// Sufijo de ticker según tipo de dólar (MEP→D, CCL→C).
export const SUFFIX: Record<DollarType, 'D' | 'C'> = { MEP: 'D', CCL: 'C' };

// ── Defaults editables (la UI puede sobreescribirlos) ───────────────────────
export const DEFAULTS = {
  refreshSec: 3,      // refresco por defecto
  commissionPct: 2,   // gastos/comisión estándar round-trip
  ciAdjustPct: 0.30,  // ajuste para estimar CI desde 24hs
  amountArs: 1_000_000,
} as const;

// ── Fuentes de datos de CEDEARs ─────────────────────────────────────────────
// IOL (vía serverless function /api/iol/cedears) entrega precios reales por
// plazo (t0=CI, t1=24hs). data912 es el fallback (un solo libro ≈ 24hs).
export const IOL_PLAZO: Record<Settlement, 't0' | 't1'> = { CI: 't0', H24: 't1' };
export const iolCedearsUrl = (s: Settlement): string =>
  `/api/iol/cedears?plazo=${IOL_PLAZO[s]}`;
export const DATA912_CEDEARS_URL = '/api/data912/live/arg_cedears';

// ── Matriz de pestañas de arbitraje (moneda × plazo) ────────────────────────
export interface ArbTab {
  id: string;
  label: string;
  short: string;
  dollarType: DollarType;
  settlement: Settlement;
}

export const ARB_TABS: ArbTab[] = [
  { id: 'mep-ci', label: 'Dólar MEP · Contado Inmediato (T+0)', short: 'MEP CI',  dollarType: 'MEP', settlement: 'CI'  },
  { id: 'mep-24', label: 'Dólar MEP · 24 horas (T+1)',          short: 'MEP 24h', dollarType: 'MEP', settlement: 'H24' },
  { id: 'ccl-ci', label: 'CCL · Contado Inmediato (T+0)',       short: 'CCL CI',  dollarType: 'CCL', settlement: 'CI'  },
  { id: 'ccl-24', label: 'CCL · 24 horas (T+1)',                short: 'CCL 24h', dollarType: 'CCL', settlement: 'H24' },
];

/**
 * Estima el Contado Inmediato (T+0) a partir de un valor del libro de 24hs.
 * Función pura — documenta el modelo de estimación.
 *   side 'venta':  value * (1 + ciAdjustPct/100)
 *   side 'compra': value * (1 - ciAdjustPct/100)
 */
export function estimateCi(value: number, ciAdjustPct: number, side: 'compra' | 'venta'): number {
  const factor = side === 'venta' ? 1 + ciAdjustPct / 100 : 1 - ciAdjustPct / 100;
  return value * factor;
}

// Etiqueta legible del plazo de liquidación.
export function settlementLabel(s: Settlement): string {
  return s === 'CI' ? 'Contado Inmediato (T+0)' : '24 horas (T+1)';
}
