# API de Cohen (Primary/XOMS) — Guía de uso

Cómo funciona la API de Cohen para extraer cotizaciones en tiempo real (CEDEARs con plazos CI y 24hs separados) y cómo la consume esta app. Cohen corre sobre la plataforma **XOMS de Primary S.A.** — la misma tecnología detrás de Matriz, eTrader y pyRofex — así que todo lo documentado acá es la API estándar de Primary apuntada al entorno de Cohen.

- **Base URL (REST):** `https://api.cohen.xoms.com.ar/`
- **WebSocket:** `wss://api.cohen.xoms.com.ar/`
- **Requisito:** usuario y contraseña de **MATRIZ** (`matriz.cohen.xoms.com.ar`). No hay API keys: el login de Matriz ES un usuario XOMS con API habilitada.

> Verificado en vivo el **2026-07-21** con la cuenta de Boston: `getToken` devuelve token, y hay marketdata completa por REST y WebSocket. **Ojo:** las credenciales de *Cohen Connect* (email) NO sirven — la API las rechaza con `Authentication fails`. Tienen que ser las de Matriz (usuario corto, sin @).

**En esta app Cohen es la fuente PRINCIPAL de CEDEARs; IOL es el fallback.** Cuando Cohen entrega filas se usan exclusivamente sus tickers; solo si el feed falla o viene vacío se cae a IOL (ver §5).

---



Las credenciales viven **solo** en `backend/cohen-feed/.env` (local y VPS, ambos fuera de git)

---

## 2. Endpoints REST útiles

Todos con header `X-Auth-Token: <token>`.

### 2.1 Lista completa de instrumentos

```
GET /rest/instruments/all
```

Devuelve TODOS los instrumentos operables en Cohen (`instruments[].instrumentId.symbol`). **Fundamental**: es la única forma de saber qué símbolos existen antes de suscribirse.

### 2.2 Marketdata puntual de un símbolo

```
GET /rest/marketdata/get?marketId=ROFX
    &symbol=MERV - XMEV - AAPL - 24hs
    &entries=BI,OF,LA,CL,EV,TC
    &depth=1
```

```json
{
  "status": "OK",
  "marketData": {
    "LA": { "price": 25660, "size": 1, "date": 1784644713000 },
    "BI": [{ "price": 25640, "size": 784 }],
    "OF": [{ "price": 25660, "size": 11000 }]
  }
}
```

Entries: `BI` bid, `OF` offer, `LA` último, `CL` cierre anterior, `EV` volumen efectivo, `TC` cantidad de operaciones.

### 2.3 Segmentos

```
GET /rest/segment/all
```

Devuelve `MERV` (BYMA — acá viven los CEDEARs), `DDF`/`DDA`/`MFCI`/`DUAL` (futuros ROFEX, no los usamos).

### 2.4 Histórico de operaciones (gráfico de Ficha)

Primary/XOMS expone histórico de trades vía `get_trade_history` (pyRofex), no
velas ya agregadas. `feed.py` agrega esos trades por día y expone:

```
GET /historico?symbol=AAPL&plazo=t0|t1&dias=30   → HistoricoPoint[]
```

Cada punto: `{ fechaHora, apertura, maximo, minimo, ultimoPrecio, volumenNominal }`
— MISMO contrato que `/api/iol/historico` (ver `operar.types.ts`), ascendente
por fecha. `[]` si no hay conexión viva o no hubo trades en el rango (el
frontend cae a IOL, ver §5.4).

---

## 3. WebSocket (streaming — lo que usa el feed)

Mensaje de suscripción (`type: "smd"`):

```json
{
  "type": "smd", "level": 1, "depth": 1,
  "entries": ["BI", "OF", "LA", "CL", "EV", "TC"],
  "products": [
    { "symbol": "MERV - XMEV - AAPL - CI",   "marketId": "ROFX" },
    { "symbol": "MERV - XMEV - AAPL - 24hs", "marketId": "ROFX" }
  ]
}
```

Cada actualización llega como mensaje `type: "Md"` con `instrumentId.symbol` y `marketData` (mismo formato que 2.2).

### ⚠️ Trades históricos: NO disponibles en Cohen

`GET /rest/data/getTrades` (lo que usa `pyRofex.get_trade_history` y el endpoint
`/historico` de `feed.py`) responde `{"status": "OK", "trades": []}` para TODO
instrumento en el entorno de Cohen. Verificado el 2026-07-22 con mercado abierto
y operaciones concretadas ese mismo día: CEDEARs (AAPL, GGAL) en CI y 24hs,
`marketId` ROFX y MERV, futuros DLR nativos, rangos largos y del día — siempre
vacío. El endpoint existe pero el entitlement de historical data no está
habilitado en el deployment de Cohen (habría que pedírselo a Cohen/Primary).

Consecuencia: el gráfico histórico de la app cae SIEMPRE al fallback IOL
(`/api/iol/historico`) — la cadena Cohen→IOL ya lo maneja solo, no es un bug.
El `/historico` de `feed.py` queda deployado por si Cohen habilita el dato.

### ⚠️ Gotcha crítico

**Si el mensaje de suscripción contiene UN solo símbolo que no existe en Cohen, el servidor rechaza el mensaje ENTERO** — ninguno de los símbolos del chunk queda suscripto. Peor: el error es solo un eco del request, sin descripción ni indicación de cuál símbolo falló:

```json
{ "status": "ERROR", "message": "<eco del smd enviado>" }
```

Por eso `feed.py` interseca el universo de `cedears-meta.ts` con `/rest/instruments/all` (vía `pyRofex.get_all_instruments()`) **antes** de suscribir (`filter_valid()`). Con el filtro entran ~1.850 de los 2.184 símbolos teóricos, y en horario de mercado hay ~850 con datos en CI y ~1.000 en 24hs. Si tocás el universo o las suscripciones, mantené ese filtro.

---

## 4. Formato de símbolos (CEDEARs en BYMA)

```
MERV - XMEV - {TICKER}{sufijo} - {plazo}
```

- **Sufijo** (pata de moneda): sin sufijo = ARS, `D` = dólar MEP, `C` = dólar cable/CCL. Ej.: `AAPL`, `AAPLD`, `AAPLC`.
- **Plazo**: `CI` (contado inmediato, T+0) o `24hs` (T+1). Cohen los separa de verdad — esta era la limitación de IOL (el panel ignora el plazo) y data912 (un solo libro).
- Los espacios alrededor de los guiones son parte del símbolo literal.

Mapeo a la app: `CI → t0`, `24hs → t1` (constante `PLAZOS` en `feed.py`, mismo contrato que `/api/iol/cedears`).

---

## 5. Cómo lo consume esta app (cadena completa)

```
Cohen WS ──► feed.py (VPS Boston, systemd cohen-feed, :8125)
                 │  snapshots HTTP con formato CedearRow
                 ▼
        /api/cohen/cedears (Vercel, api/cohen/cedears.js)
                 │  token X-Feed-Token del lado servidor
                 ▼
        frontend: fetchCedears() en app.ts — Cohen → IOL
```

### 5.1 `backend/cohen-feed/feed.py` (el puente)

Proceso Python **solo lectura** (jamás importa funciones de órdenes de pyRofex). Se suscribe por WS a todo el universo y expone:

```
GET /cedears?plazo=t0|t1   → CedearRow[]  (mismo contrato que /api/iol/cedears)
GET /health                → { mode, auth, connected, messages, symbols }
```

Config en `.env` (ver `.env.example`): `COHEN_USER` / `COHEN_PASSWORD` (Matriz), `COHEN_API_URL` / `COHEN_WS_URL`, `PORT` (8125), `FEED_HOST` (`127.0.0.1` local, `0.0.0.0` en VPS), `FEED_TOKEN` (si está seteado, `/cedears` exige header `X-Feed-Token` — así solo el proxy de Vercel puede leerlo).

Es resiliente: si la auth falla o el WS se cae, sirve libros vacíos (la app cae a IOL) y reintenta solo.

### 5.2 Proxy Vercel (`api/cohen/cedears.js`)

El navegador llama a `/api/cohen/cedears?plazo=t0|t1` (same-origin, sin CORS ni mixed content). La función lee `COHEN_FEED_URL` y `COHEN_FEED_TOKEN` (env vars de Vercel) y le pega al feed del VPS. Respuestas: `200` con filas (libro Cohen), `200` con `[]` (feed vivo pero sin datos → frontend cae a IOL), `502/500` (feed caído/no configurado → frontend cae a IOL).

### 5.3 Frontend (`market.config.ts` + `app.ts`)

- `cohenFeedBase()` devuelve la base del feed: por defecto `/api/cohen`.
- `fetchCedears(settlement)` en `app.ts` implementa la cadena: pide a Cohen; si trae filas, esas son LAS filas (tickers de Cohen, sin mezclar); si viene vacío o falla, pide a IOL. data912 quedó fuera de la cadena de CEDEARs.
- La etiqueta de estado del panel muestra quién entregó cada plazo (`· Cohen` / `· IOL`).

Overrides por máquina vía `localStorage` (dev/debug):

```js
localStorage.setItem('cohenFeedUrl', 'http://127.0.0.1:8125') // feed local
localStorage.setItem('cohenFeedUrl', 'off')                   // deshabilita Cohen → IOL directo
localStorage.removeItem('cohenFeedUrl')                       // vuelve al default /api/cohen
```

### 5.4 Gráfico histórico de Ficha (Cohen → IOL)

Mismo patrón que CEDEARs, para la serie que alimenta el gráfico de cada
símbolo en Operar › Ficha:

```
Cohen WS/REST ──► feed.py: GET /historico?symbol=…&plazo=…&dias=…
                     ▼
        /api/cohen/historico (Vercel, api/cohen/historico.js)
                     ▼
        frontend: loadHistorico() en operar.component.ts — Cohen → IOL
```

`loadHistorico()` pide primero a Cohen (`cohenHistoricoUrl()` en
`market.config.ts`, mapeando el rango de la UI a días vía `RANGO_DIAS`); si
Cohen devuelve puntos, esos son los que se grafican. Si Cohen no está
configurado (`cohenFeedBase()` → `'off'`), falla, o devuelve `[]`, cae a
`/api/iol/historico` (mismo endpoint que ya usaba el gráfico). Ambas fuentes
comparten la forma `HistoricoPoint[]` (`operar.types.ts`) — no hace falta
mapear campos en el componente, sólo reordenar a ascendente por fecha (IOL
entrega la serie descendente; Cohen ya la entrega ascendente).

---

## 6. Desarrollo local

Con `ng serve --proxy-config proxy.conf.json` el path `/api/cohen` se rutea a **producción** (`cotizaciones-boston.vercel.app`) — no hace falta correr nada extra: usás el feed real del VPS.

Para probar cambios en `feed.py` sin tocar el VPS:

```bash
cd backend/cohen-feed
python feed.py              # con credenciales en .env
python feed.py --simulate   # sin credenciales: libros falsos para probar el contrato
```

y en el navegador `localStorage.setItem('cohenFeedUrl', 'http://127.0.0.1:8125')`.

Dependencia: `pip install pyRofex`. Para apuntar pyRofex a Cohen (no al ROFEX default):

```python
pyRofex._set_environment_parameter("url", "https://api.cohen.xoms.com.ar/", Environment.LIVE)
pyRofex._set_environment_parameter("ws",  "wss://api.cohen.xoms.com.ar/",  Environment.LIVE)
pyRofex.initialize(user=..., password=..., account="N/A", environment=Environment.LIVE)
```

---

## 7. Operación en el VPS

El feed corre en el VPS de Boston como servicio systemd (deploy en `/opt/cohen-feed`, con su propio `venv`, `feed.py` y una copia de `cedears-meta.ts`):

```bash
systemctl status cohen-feed          # estado
systemctl restart cohen-feed         # reiniciar (tras subir feed.py o cambiar .env)
journalctl -u cohen-feed -f          # logs en vivo
curl http://127.0.0.1:8125/health    # desde el VPS: estado del feed
```

Un `/health` sano en horario de mercado se ve así:

```json
{ "mode": "live", "auth": "ok", "connected": true,
  "messages": 5519, "lastMessageAgoSec": 0.0,
  "symbols": { "t0": 847, "t1": 1004 } }
```

`symbols` en 0 con `connected: true` fuera de horario es **normal** (mercado cerrado, sin puntas — no es un bug). Si `auth: "rejected"`, revisar `COHEN_USER`/`COHEN_PASSWORD` en el `.env` del VPS (deben ser las de Matriz).

Para actualizar el código del feed: subir `feed.py` por `scp` a `/opt/cohen-feed/` y reiniciar el servicio. Las credenciales y el `FEED_TOKEN` ya están en el `.env` del VPS — no hace falta tocarlos.
