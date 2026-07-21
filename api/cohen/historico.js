// Vercel Serverless Function — proxy al feed Cohen (Primary/XOMS) que corre
// en el VPS de Boston (backend/cohen-feed/feed.py), rama histórico.
//
// El navegador llama a /api/cohen/historico?symbol=AAPL&plazo=t1&dias=30 y
// recibe HistoricoPoint[] — MISMO contrato que /api/iol/historico
// (fechaHora, apertura, maximo, minimo, ultimoPrecio, volumenNominal),
// ascendente por fecha, para que el gráfico de Ficha no distinga la fuente.
// El feed real vive detrás de un token que SOLO conoce esta función
// (env vars COHEN_FEED_URL / COHEN_FEED_TOKEN) — nunca llega al cliente.
//
// Respuestas:
//  - 200 con puntos: serie diaria de Cohen (get_trade_history vía pyRofex).
//  - 200 con []: feed alcanzable pero sin trades en el rango (símbolo sin
//    operar, plazo sin universo, o mercado cerrado sin histórico local) →
//    el frontend cae a IOL.
//  - 502/500: feed no configurado o inalcanzable → el frontend cae a IOL.

const TIMEOUT_MS = 6000;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const base = process.env.COHEN_FEED_URL;
  if (!base) {
    res.status(500).json({ error: 'COHEN_FEED_URL not configured' });
    return;
  }

  const symbol = String((req.query && req.query.symbol) || '').trim().toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: 'falta symbol' });
    return;
  }
  const rawPlazo = (req.query && req.query.plazo) || 't1';
  const plazo = rawPlazo === 't0' || rawPlazo === 't1' ? rawPlazo : 't1';
  const dias = Math.max(1, Math.min(Number(req.query && req.query.dias) || 30, 1825));

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const upstream = await fetch(
      `${base.replace(/\/+$/, '')}/historico?symbol=${encodeURIComponent(symbol)}&plazo=${plazo}&dias=${dias}`,
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
    const points = await upstream.json();
    res.status(200).json(Array.isArray(points) ? points : []);
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
