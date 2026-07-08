// Vercel Serverless Function — panel genérico de cotizaciones de IOL.
//
// El navegador llama a /api/iol/panel?id=bonos (acciones | bonos | letras |
// ons | opciones | usa) y recibe un array con la MISMA forma que los feeds de
// data912, para que el frontend no distinga la fuente. IOL es la fuente
// PRIMARIA de la pantalla Cotizaciones; si esta función falla o devuelve
// vacío, el frontend cae a data912 (ver refreshFast en app.ts). Las
// credenciales viven SOLO como env vars del lado servidor
// (IOL_USERNAME / IOL_PASSWORD) — nunca llegan al cliente.

const IOL = 'https://api.invertironline.com';

// id de panel del frontend → {instrumento, pais} de IOL (relevado 2026-07-08:
// 'bonos' devuelve 0 títulos; los bonos soberanos viven en 'titulosPublicos').
const PANELS = {
  acciones: { instrumento: 'acciones',                pais: 'argentina' },
  bonos:    { instrumento: 'titulosPublicos',         pais: 'argentina' },
  letras:   { instrumento: 'letras',                  pais: 'argentina' },
  ons:      { instrumento: 'obligacionesNegociables', pais: 'argentina' },
  opciones: { instrumento: 'opciones',                pais: 'argentina' },
  usa:      { instrumento: 'acciones',                pais: 'estados_Unidos' },
};

// Cache corto por panel: dedupea el polling de 1s del frontend (6 paneles)
// sin sumar staleness relevante — estos paneles no son el camino crítico del
// arbitraje (ese sigue en api/iol/cedears.js con su propio ciclo).
const PANEL_TTL_MS = 3000;
const cache = new Map(); // id -> { rows, exp }

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
  if (tokenCache.access && now < tokenCache.exp - 30_000) return tokenCache.access;

  let res = null;
  if (tokenCache.refresh) {
    try {
      res = await authRefresh(tokenCache.refresh);
      if (!res.ok) res = null;
    } catch {
      res = null;
    }
  }
  if (!res) res = await authPassword();
  if (!res.ok) throw new Error(`IOL auth failed (${res.status})`);

  const j = await res.json();
  tokenCache = {
    access: j.access_token,
    refresh: j.refresh_token || tokenCache.refresh,
    exp: Date.now() + (Number(j.expires_in) || 1200) * 1000,
  };
  return tokenCache.access;
}

// IOL titulo del panel → misma forma que data912, más `desc` (descripción
// legible del título; data912 no la trae y para ONs/bonos suma mucho).
function mapRow(t) {
  const p = t.puntas || {};
  const row = {
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
  if (t.descripcion) row.desc = t.descripcion;
  return row;
}

module.exports = async (req, res) => {
  try {
    const id = (req.query && req.query.id) || '';
    const def = PANELS[id];
    if (!def) {
      res.status(400).json({ error: `panel desconocido: ${id}` });
      return;
    }

    const hit = cache.get(id);
    if (hit && Date.now() < hit.exp) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(hit.rows);
      return;
    }

    const token = await getToken();
    const url =
      `${IOL}/api/v2/Cotizaciones/${def.instrumento}/${def.pais}/Todos` +
      `?cotizacionInstrumentoModel.instrumento=${def.instrumento}` +
      `&cotizacionInstrumentoModel.pais=${def.pais}`;

    let r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    // 401 → token vencido en medio: forzar re-auth una vez.
    if (r.status === 401) {
      tokenCache = { access: null, refresh: null, exp: 0 };
      const fresh = await getToken();
      r = await fetch(url, { headers: { Authorization: `Bearer ${fresh}` } });
    }

    if (!r.ok) {
      res.status(502).json({ error: `IOL panel error (${r.status})` });
      return;
    }

    const data = await r.json();
    const rows = (data.titulos || []).map(mapRow).filter((x) => x.symbol);
    cache.set(id, { rows, exp: Date.now() + PANEL_TTL_MS });

    // no-store: el CDN no debe servir cotizaciones viejas.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(rows);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
