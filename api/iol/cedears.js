// Vercel Serverless Function — proxy autenticado a la API de InvertirOnline (IOL).
//
// El navegador llama a /api/iol/cedears?plazo=t0 (o t1) y recibe un array con la
// MISMA forma que el feed de data912 (CedearRow), para que el frontend y el motor
// de arbitraje no distingan la fuente. Las credenciales viven SOLO como env vars
// del lado servidor (IOL_USERNAME / IOL_PASSWORD) — nunca llegan al cliente.
//
// Plazos (auditoría 2026-06-09):
//  - El PANEL (/api/v2/Cotizaciones/cedears/argentina/Todos) IGNORA el parámetro
//    plazo: siempre devuelve el libro de 24hs (t0/t1/orleans dan lo mismo).
//  - El único endpoint que honra el plazo es la cotización POR SÍMBOLO
//    (/api/v2/bCBA/Titulos/{sym}/Cotizacion?model.plazo=t0).
//
// Por eso:
//  - plazo=t1 → panel completo (libro 24hs real, ~900 símbolos).
//  - plazo=t0 → panel para descubrir pares (base + baseD/baseC) con liquidez,
//    y luego cotización por símbolo en paralelo acotado SOLO para ese subset.
//    Devuelve menos filas, pero todas con libro CI (T+0) real.

const IOL = 'https://api.invertironline.com';

// Selección del subset CI: pares con volumen efectivo (USD) mínimo en alguna
// punta, rankeados por liquidez, con tope por sufijo para acotar las llamadas.
const CI_MIN_USD = Number(process.env.IOL_CI_MIN_USD) || 500;
const CI_TOP_PER_SUFFIX = Number(process.env.IOL_CI_TOP) || 30;
const CI_CONCURRENCY = 20;

// Cache corto del panel (las requests t0 y t1 llegan casi juntas cada ~3s;
// el panel es idéntico para ambas, no hace falta bajarlo dos veces).
const PANEL_TTL_MS = 2000;
let panelCache = { rows: null, exp: 0 };

// Cache del token a nivel de módulo (persiste entre invocaciones "warm").
let tokenCache = { access: null, refresh: null, exp: 0 };

async function authPassword() {
  const username = process.env.IOL_USERNAME;
  const password = process.env.IOL_PASSWORD;
  if (!username || !password) {
    throw new Error('IOL credentials not configured (set IOL_USERNAME / IOL_PASSWORD)');
  }
  const body = new URLSearchParams({ grant_type: 'password', username, password });
  return fetch(`${IOL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

async function authRefresh(refresh) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh });
  return fetch(`${IOL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

async function getToken() {
  const now = Date.now();
  // Token vigente (con 30s de margen).
  if (tokenCache.access && now < tokenCache.exp - 30_000) return tokenCache.access;

  // 1) Intento refrescar si tengo refresh_token.
  let res = null;
  if (tokenCache.refresh) {
    try {
      res = await authRefresh(tokenCache.refresh);
      if (!res.ok) res = null;
    } catch {
      res = null;
    }
  }
  // 2) Si no, auth con usuario/contraseña.
  if (!res) res = await authPassword();
  if (!res.ok) {
    throw new Error(`IOL auth failed (${res.status})`);
  }

  const j = await res.json();
  tokenCache = {
    access: j.access_token,
    refresh: j.refresh_token || tokenCache.refresh,
    exp: Date.now() + (Number(j.expires_in) || 1200) * 1000,
  };
  return tokenCache.access;
}

// IOL titulo del panel → CedearRow (misma forma que data912 /live/arg_cedears).
function mapRow(t) {
  const p = t.puntas || {};
  return {
    symbol: t.simbolo,
    q_bid: Number(p.cantidadCompra) || 0,
    px_bid: Number(p.precioCompra) || 0,
    px_ask: Number(p.precioVenta) || 0,
    q_ask: Number(p.cantidadVenta) || 0,
    v: Number(t.volumen) || 0,
    q_op: Number(t.cantidadOperaciones) || 0,
    c: Number(t.ultimoCierre) || 0,
    pct_change: Number(t.variacionPorcentual) || 0,
  };
}

// Panel completo de CEDEARs (libro 24hs). Reintenta una vez ante 401.
async function fetchPanel(token) {
  if (panelCache.rows && Date.now() < panelCache.exp) return panelCache.rows;
  const url =
    `${IOL}/api/v2/Cotizaciones/cedears/argentina/Todos` +
    `?cotizacionInstrumentoModel.instrumento=cedears` +
    `&cotizacionInstrumentoModel.pais=argentina`;

  let r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  // 401 → token vencido en medio: forzar re-auth una vez.
  if (r.status === 401) {
    tokenCache = { access: null, refresh: null, exp: 0 };
    const fresh = await getToken();
    r = await fetch(url, { headers: { Authorization: `Bearer ${fresh}` } });
  }

  if (!r.ok) {
    const err = new Error(`IOL panel error (${r.status})`);
    err.status = 502;
    throw err;
  }

  const data = await r.json();
  const rows = (data.titulos || []).map(mapRow).filter((x) => x.symbol);
  panelCache = { rows, exp: Date.now() + PANEL_TTL_MS };
  return rows;
}

// Cotización por símbolo con plazo REAL. puntas[0] = tope del libro.
async function fetchT0Quote(token, sym) {
  const url =
    `${IOL}/api/v2/bCBA/Titulos/${encodeURIComponent(sym)}/Cotizacion` +
    `?model.mercado=bCBA&model.simbolo=${encodeURIComponent(sym)}&model.plazo=t0`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const j = await r.json();
  const p = (Array.isArray(j.puntas) && j.puntas[0]) || {};
  return {
    symbol: sym,
    q_bid: Number(p.cantidadCompra) || 0,
    px_bid: Number(p.precioCompra) || 0,
    px_ask: Number(p.precioVenta) || 0,
    q_ask: Number(p.cantidadVenta) || 0,
    v: Number(j.volumenNominal) || 0,
    q_op: Number(j.cantidadOperaciones) || 0,
    c: Number(j.cierreAnterior) || 0,
    pct_change: Number(j.variacion) || 0,
  };
}

// Desde el panel de 24hs, elegir los símbolos (base + pata USD) de los pares
// más líquidos por sufijo. Volumen efectivo = misma convención que el motor:
//   buyLeg  = min(qArsAsk, qUsdBid) * usdBid
//   sellLeg = min(qUsdAsk, qArsBid) * usdAsk
function pickLiquidSymbols(rows, minUsd, topPerSuffix) {
  const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
  const picked = new Set();

  for (const suffix of ['D', 'C']) {
    const scored = [];
    for (const ars of rows) {
      const base = ars.symbol;
      if (base.endsWith('C') || base.endsWith('D')) continue;
      const usd = bySymbol.get(base + suffix);
      if (!usd) continue;
      if (!(ars.px_bid > 0 && ars.px_ask > 0 && usd.px_bid > 0 && usd.px_ask > 0)) continue;
      const buyLeg = Math.min(ars.q_ask, usd.q_bid) * usd.px_bid;
      const sellLeg = Math.min(usd.q_ask, ars.q_bid) * usd.px_ask;
      const vol = Math.max(buyLeg, sellLeg);
      if (vol < minUsd) continue;
      scored.push({ base, usdSym: base + suffix, vol });
    }
    scored.sort((a, b) => b.vol - a.vol);
    for (const s of scored.slice(0, topPerSuffix)) {
      picked.add(s.base);
      picked.add(s.usdSym);
    }
  }
  return [...picked];
}

// map con concurrencia acotada; los fallos individuales devuelven null.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).catch(() => null);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = async (req, res) => {
  try {
    const raw = (req.query && req.query.plazo) || 't1';
    const plazo = raw === 't0' || raw === 't1' || raw === 't2' ? raw : 't1';

    const token = await getToken();
    const panel = await fetchPanel(token);

    // 24hs (o t2): el panel ya es ese libro.
    if (plazo !== 't0') {
      res.setHeader('Cache-Control', 's-maxage=2, stale-while-revalidate=5');
      res.status(200).json(panel);
      return;
    }

    // CI: cotización por símbolo (plazo real) para el subset líquido.
    const symbols = pickLiquidSymbols(panel, CI_MIN_USD, CI_TOP_PER_SUFFIX);
    const quotes = await mapLimit(symbols, CI_CONCURRENCY, (s) => fetchT0Quote(token, s));
    const rows = quotes.filter((q) => q && q.symbol && (q.px_bid > 0 || q.px_ask > 0));

    // Si el burst falló por completo, [] dispara el fallback (data912 estimado)
    // en el frontend en vez de mostrar un CI "real" vacío.
    res.setHeader('Cache-Control', 's-maxage=3, stale-while-revalidate=6');
    res.status(200).json(rows);
  } catch (e) {
    const status = (e && e.status) || 500;
    res.status(status).json({ error: String((e && e.message) || e) });
  }
};
