/**
 * market.config.ts — Hogar canónico de tipos compartidos y configuración.
 * Los demás módulos (motor de arbitraje, UI, data layer) importan desde acá.
 * NO incluir lógica de cálculo de pares (eso vive en el motor).
 */

// ── Tipos de dólar y plazo ──────────────────────────────────────────────────
export type DollarType = 'MEP' | 'CCL';
export type Settlement = 'CI' | 'H24'; // CI=T+0 (IOL por símbolo, o estimado), H24=T+1/24hs (panel)

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

/**
 * Plan de nominales ENTEROS a operar en el broker, derivado de un presupuesto
 * en ARS. A diferencia de `TradeResult` (cantidades fraccionarias), acá cada
 * compra se redondea con `floor` al dinero disponible y la segunda pata se
 * financia con los dólares REALMENTE obtenidos en la primera. Espeja las 4
 * acciones del broker del ejercicio de arbitraje (Arbitrage.xlsx).
 */
export interface NominalsPlan {
  // Identidad de las patas / tickers de las 4 acciones del broker
  buyBase: string;       // buy.base
  buyArsTicker: string;  // = buy.base   — fila 1: lo que COMPRO en pesos
  sellUsdTicker: string; // buy.base + sufijo — fila 2: lo que VENDO en dólares
  buyUsdTicker: string;  // sell.base + sufijo — fila 3: lo que COMPRO en dólares
  sellBase: string;      // = sell.base  — fila 4: lo que VENDO en pesos

  // Precios unitarios de cada acción (el plan es autosuficiente para la UI)
  buyArsAsk: number;     // fila 1: precio al que compro en ARS  (buy.arsAsk)
  buyUsdBid: number;     // fila 2: precio al que vendo en USD   (buy.usdBid)
  sellUsdAsk: number;    // fila 3: precio al que compro en USD  (sell.usdAsk)
  sellArsBid: number;    // fila 4: precio al que vendo en ARS   (sell.arsBid)

  // Paso 1 — compro CEDEAR en ARS
  nBuy: number;          // nominales enteros comprados
  arsSpent: number;      // nBuy * buy.arsAsk
  arsLeftover: number;   // budgetArs - arsSpent ("no alcanza para otro nominal")

  // Paso 2 — vendo su par en USD
  usdObtained: number;   // nBuy * buy.usdBid

  // Paso 3 — compro CEDEAR en USD (limitado por usdObtained, no por el budget)
  nSell: number;         // nominales enteros comprados con usdObtained
  usdSpent: number;      // nSell * sell.usdAsk
  usdLeftover: number;   // usdObtained - usdSpent

  // Paso 4 — vendo su par en ARS
  arsOut: number;        // nSell * sell.arsBid (sólo los nominales ENTEROS vendidos)

  // Sobrante USD desplegado: el floor de nSell deja dólares ociosos; se valúan al
  // tipo de cambio de la pata vendedora para no subestimar la ganancia (equivale a
  // desplegar TODOS los dólares obtenidos en la 1.ª pata).
  usdSellRate: number;   // sell.arsBid / sell.usdAsk — ARS por USD en la pata vendedora
  usdLeftoverArs: number;// usdLeftover * usdSellRate — valor en ARS del sobrante USD
  arsOutFull: number;    // arsOut + usdLeftoverArs (= usdObtained * usdSellRate)

  // Resultado medido contra lo realmente invertido (arsSpent, no el budget),
  // contando el sobrante en dólares (arsOutFull, no arsOut).
  commissionPct: number;
  grossProfit: number;   // arsOutFull - arsSpent (cuenta el sobrante USD)
  netProfit: number;     // grossProfit - arsSpent * commissionPct/100
  netPct: number;        // netProfit / arsSpent * 100
}

// Sufijo de ticker según tipo de dólar (MEP→D, CCL→C).
export const SUFFIX: Record<DollarType, 'D' | 'C'> = { MEP: 'D', CCL: 'C' };

// ── Defaults editables (la UI puede sobreescribirlos) ───────────────────────
export const DEFAULTS = {
  refreshSec: 3,      // refresco por defecto
  commissionPct: 2,   // gastos/comisión estándar round-trip
  ciAdjustPct: 0.30,  // ajuste para estimar CI desde 24hs
  amountArs: 1_000_000,
  budgetArs: 150_000, // presupuesto real "de bolsillo" para el solver de nominales enteros
  minUsdVol: 1000,    // volumen efectivo mínimo (USD) por punta para considerar un par
} as const;

// ── Fuentes de datos de CEDEARs ─────────────────────────────────────────────
// IOL (vía serverless function /api/iol/cedears): t1 = panel completo (libro
// 24hs); t0 = cotización POR SÍMBOLO (el panel de IOL ignora el plazo) sólo
// para el subset líquido. data912 es el fallback (un solo libro ≈ 24hs).
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

// ── Composición del panel de acciones ARG "Líder" ───────────────────────────
// data912 (`/api/data912/live/arg_stocks`) devuelve TODAS las acciones ARG en
// un solo listado plano, sin campo de categoría/panel — no hay forma de
// derivar "Panel Líder" desde el feed. Esta lista replica la categorización
// real y pública de bostonam.com/cotizaciones/panel-lider (relevado
// 2026-07-06): son los ~21 blue-chips que el mercado/la exchange define como
// panel líder, no un recorte arbitrario. Panel General se arma en el cliente
// como TODO lo que no está en esta lista (ver cotizaciones.component.ts) —
// así cualquier ticker nuevo o no listado aquí no desaparece de la app.
export const PANEL_LIDER: string[] = [
  'ALUA', 'BBAR', 'BMA', 'BYMA', 'CEPU', 'COME', 'CRES', 'EDN', 'GGAL',
  'IRSA', 'LOMA', 'MIRG', 'PAMP', 'SUPV', 'TECO2', 'TGNO4', 'TGSU2',
  'TRAN', 'TXAR', 'VALO', 'YPFD',
];
