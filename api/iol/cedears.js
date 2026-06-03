// Vercel Serverless Function — proxy autenticado a la API de InvertirOnline (IOL).
//
// El navegador llama a /api/iol/cedears?plazo=t0 (o t1) y recibe un array con la
// MISMA forma que el feed de data912 (CedearRow), para que el frontend y el motor
// de arbitraje no distingan la fuente. Las credenciales viven SOLO como env vars
// del lado servidor (IOL_USERNAME / IOL_PASSWORD) — nunca llegan al cliente.
//
// IOL expone el plazo de liquidación real: t0 = Contado Inmediato (CI), t1 = 24hs.

const IOL = 'https://api.invertironline.com';

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

// IOL titulo → CedearRow (misma forma que data912 /live/arg_cedears).
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

module.exports = async (req, res) => {
  try {
    const raw = (req.query && req.query.plazo) || 't1';
    const plazo = raw === 't0' || raw === 't1' || raw === 't2' ? raw : 't1';

    const token = await getToken();
    const url =
      `${IOL}/api/v2/Cotizaciones/cedears/argentina/Todos` +
      `?cotizacionInstrumentoModel.instrumento=cedears` +
      `&cotizacionInstrumentoModel.pais=argentina` +
      `&cotizacionInstrumentoModel.plazo=${plazo}`;

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

    // Cache de borde corto: el dashboard refresca cada ~3s.
    res.setHeader('Cache-Control', 's-maxage=2, stale-while-revalidate=5');
    res.status(200).json(rows);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
