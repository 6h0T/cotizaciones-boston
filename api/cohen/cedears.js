// Vercel Serverless Function — proxy al feed Cohen (Primary/XOMS) que corre
// en el VPS de Boston (backend/cohen-feed/feed.py).
//
// El navegador llama a /api/cohen/cedears?plazo=t0|t1 y recibe CedearRow[]
// (mismo contrato que /api/iol/cedears). El feed real vive detrás de un token
// que SOLO conoce esta función (env vars COHEN_FEED_URL / COHEN_FEED_TOKEN) —
// nunca llega al cliente. Servidor→servidor no hay mixed content, así el
// sitio HTTPS puede consumir un feed HTTP interno.
//
// Respuestas:
//  - 200 con filas: libro Cohen del plazo pedido.
//  - 200 con []: feed alcanzable pero sin datos (auth Cohen pendiente,
//    mercado cerrado o sin puntas) → el frontend cae a IOL.
//  - 502/500: feed no configurado o inalcanzable → el frontend cae a IOL.

const TIMEOUT_MS = 4000;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const base = process.env.COHEN_FEED_URL;
  if (!base) {
    res.status(500).json({ error: 'COHEN_FEED_URL not configured' });
    return;
  }

  const raw = (req.query && req.query.plazo) || 't1';
  const plazo = raw === 't0' || raw === 't1' ? raw : 't1';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const upstream = await fetch(
      `${base.replace(/\/+$/, '')}/cedears?plazo=${plazo}`,
      {
        headers: process.env.COHEN_FEED_TOKEN
          ? { 'X-Feed-Token': process.env.COHEN_FEED_TOKEN }
          : {},
        signal: controller.signal,
      },
    );
    clearTimeout(timer);

    if (!upstream.ok) {
      res.status(502).json({ error: `feed responded ${upstream.status}` });
      return;
    }
    const rows = await upstream.json();
    res.status(200).json(Array.isArray(rows) ? rows : []);
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
