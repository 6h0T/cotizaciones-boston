// Smoke test local de api/iol/cedears.js: compara t0 (por símbolo) vs t1 (panel).
const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

const handler = require('../api/iol/cedears.js');

async function call(plazo) {
  const res = {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; },
  };
  const t = Date.now();
  await handler({ query: { plazo } }, res);
  res.ms = Date.now() - t;
  return res;
}

(async () => {
  const t1 = await call('t1');
  console.log(`t1: status ${t1.code}, rows ${Array.isArray(t1.body) ? t1.body.length : JSON.stringify(t1.body)}, ${t1.ms}ms`);
  const t0 = await call('t0');
  console.log(`t0: status ${t0.code}, rows ${Array.isArray(t0.body) ? t0.body.length : JSON.stringify(t0.body)}, ${t0.ms}ms`);
  if (!Array.isArray(t0.body) || !Array.isArray(t1.body)) return;

  for (const s of ['AAPL', 'AAPLD', 'AAPLC', 'TSLA', 'TSLAD', 'NVDAD']) {
    const a = t0.body.find((r) => r.symbol === s);
    const b = t1.body.find((r) => r.symbol === s);
    const f = (r) => (r ? `${r.px_bid}/${r.px_ask} q ${r.q_bid}/${r.q_ask}` : 'ausente');
    console.log(`${s.padEnd(6)} t0 ${f(a).padEnd(30)} | t1 ${f(b)}`);
  }

  const m1 = new Map(t1.body.map((r) => [r.symbol, r]));
  let diff = 0, same = 0;
  for (const r of t0.body) {
    const o = m1.get(r.symbol);
    if (!o) continue;
    if (r.px_bid !== o.px_bid || r.px_ask !== o.px_ask || r.q_bid !== o.q_bid || r.q_ask !== o.q_ask) diff++;
    else same++;
  }
  console.log(`t0 rows que difieren del panel 24hs: ${diff} / iguales: ${same}`);
})();
