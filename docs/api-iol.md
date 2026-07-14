# API de InvertirOnline (IOL) — Guía de uso

Cómo funciona la API v2 de IOL para extraer cotizaciones (CEDEARs, bonos, letras, ONs, acciones, opciones) y, a futuro, para **operar** (comprar/vender, historial de órdenes, portafolio). Documenta tanto los endpoints oficiales como la forma en que esta app los consume.

- **Base URL:** `https://api.invertironline.com`
- **Documentación oficial (Swagger):** `https://api.invertironline.com/` (el JSON del spec vive en `/v2/swagger`)
- **Requisito:** usuario y contraseña de una cuenta IOL con API habilitada. No hay API keys: se autentica con las credenciales de la cuenta.

> Verificado contra el swagger oficial el **2026-07-14**. Las notas de comportamiento real (qué ignora el panel, qué paneles vienen vacíos) salen de auditorías propias hechas con la cuenta de Boston — están fechadas en cada caso.

---

## 1. Autenticación

OAuth2 con `grant_type=password`. Se piden tokens a `/token` (form-urlencoded, **no** JSON):

```
POST https://api.invertironline.com/token
Content-Type: application/x-www-form-urlencoded

grant_type=password&username=USUARIO&password=CONTRASEÑA
```

Respuesta:

```json
{
  "access_token": "…",
  "token_type": "bearer",
  "expires_in": 899,
  "refresh_token": "…"
}
```

- El `access_token` dura ~15 minutos (`expires_in` en segundos). Se manda en cada request como `Authorization: Bearer <token>`.
- El `refresh_token` permite renovar sin re-enviar la contraseña:

```
POST /token
grant_type=refresh_token&refresh_token=…
```

### Cómo lo maneja esta app

Las credenciales viven **solo del lado servidor** como env vars (`IOL_USERNAME` / `IOL_PASSWORD` en Vercel); el navegador nunca las ve. Los proxies serverless (`api/iol/*.js`) cachean el token a nivel de módulo (persiste entre invocaciones "warm"), renuevan con `refresh_token` cuando pueden, y ante un `401` en medio de una request fuerzan re-auth una sola vez y reintentan.

---

## 2. Cotizaciones

### 2.1 Panel completo por instrumento

Un solo request devuelve **todos** los títulos de un tipo de instrumento:

```
GET /api/v2/Cotizaciones/{Instrumento}/{Pais}/Todos
    ?cotizacionInstrumentoModel.instrumento={instrumento}
    &cotizacionInstrumentoModel.pais={pais}
```

Valores válidos de `instrumento` (enum oficial): `acciones`, `cedears`, `aDRs`, `titulosPublicos`, `letras`, `obligacionesNegociables`, `opciones`, `cauciones`, `cHPD`, `futuros`.
`pais`: `argentina` | `estados_Unidos`.

**Trampas conocidas (auditadas con la cuenta real):**

| Qué | Detalle |
|---|---|
| Bonos soberanos | El instrumento `bonos` **no existe** / devuelve 0 títulos. Los soberanos (AL30, GD30, …) viven en **`titulosPublicos`** (relevado 2026-07-08). |
| Plazo | El panel **IGNORA cualquier parámetro de plazo**: siempre devuelve el libro de 24hs. `t0`/`t1`/las variantes orleans dan lo mismo (auditoría 2026-06-09). El único endpoint que honra el plazo es la cotización por símbolo (§2.2). |
| Índices internacionales y ETFs | IOL **no los expone**: los paneles `indices`/`eTFs` devuelven 0 títulos para todos los países, y la cotización por símbolo trae datos viejos (auditado 2026-07-08). Por eso la app usa Yahoo Finance para esos dos casilleros. |

Cada título del array `titulos` de la respuesta trae:

```json
{
  "simbolo": "AL30",
  "descripcion": "BONOS ARGENTINA USD 2030 L.A",
  "puntas": {
    "cantidadCompra": 1000, "precioCompra": 68000.0,
    "precioVenta": 68150.0, "cantidadVenta": 500
  },
  "ultimoPrecio": 68100.0,
  "variacionPorcentual": 0.44,
  "apertura": 67800.0, "maximo": 68200.0, "minimo": 67750.0,
  "ultimoCierre": 67800.0,
  "volumen": 1234567,
  "cantidadOperaciones": 321,
  "moneda": "peso_Argentino"
}
```

Variantes del mismo panel:

- `GET /api/v2/Cotizaciones/{Instrumento}/{Panel}/{Pais}` — un sub-panel específico (los nombres de panel se descubren con §2.5).
- `GET /api/v2/cotizaciones-orleans/{Instrumento}/{Pais}/Todos` y `…/Operables` — variante "orleans" del mismo dato (y `cotizaciones-orleans-panel/…`). En la práctica devuelven el mismo libro de 24hs.

### 2.2 Cotización por símbolo (el único endpoint que respeta el plazo)

```
GET /api/v2/{Mercado}/Titulos/{Simbolo}/Cotizacion
    ?model.mercado=bCBA&model.simbolo=AL30&model.plazo=t0
```

- `mercado`: `bCBA` (BYMA), `nYSE`, `nASDAQ`, `aMEX`, `bCS`, `rOFX`.
- `model.plazo`: `t0` (Contado Inmediato), `t1` (24hs), `t2` (72hs), `t3`.

La respuesta trae el libro del plazo pedido: `puntas` es un **array** ordenado por profundidad (`puntas[0]` = tope del libro), más `ultimoPrecio`, `cierreAnterior`, `volumenNominal`, `cantidadOperaciones`, `variacion`, etc.

Es el endpoint clave para el arbitraje CI: como el panel ignora el plazo, el libro T+0 real solo se consigue **símbolo por símbolo**. Es caro (1 request por título), así que hay que acotar a un subset (ver §3.2).

### 2.3 Ficha y detalle de un título

- `GET /api/v2/{mercado}/Titulos/{simbolo}` — datos estáticos del título (descripción, moneda, lote, etc.).
- `GET /api/v2/{mercado}/Titulos/{simbolo}/CotizacionDetalle` — cotización + profundidad de libro.
- `GET /api/v2/{mercado}/Titulos/{simbolo}/CotizacionDetalleMobile/{plazo}` — ídem, formato compacto, con plazo en el path.
- `GET /api/v2/{mercado}/Titulos/{simbolo}/Opciones` — cadena de opciones de un subyacente.

### 2.4 Serie histórica

```
GET /api/v2/{mercado}/Titulos/{simbolo}/Cotizacion/seriehistorica/{fechaDesde}/{fechaHasta}/{ajustada}
```

- Fechas `yyyy-MM-dd`; `ajustada` ∈ `ajustada` | `sinAjustar`.
- Devuelve OHLC + volumen diario. Sirve para variaciones semana/año y para gráficos.

### 2.5 Descubrimiento de instrumentos y paneles

- `GET /api/v2/{pais}/Titulos/Cotizacion/Instrumentos` — qué instrumentos existen para un país.
- `GET /api/v2/{pais}/Titulos/Cotizacion/Paneles/{instrumento}` — qué sub-paneles tiene un instrumento (ej.: acciones → líder / general).

### 2.6 Dólar MEP

- `GET /api/v2/Cotizaciones/MEP/{simbolo}` — cotización MEP implícita de un símbolo (ej. AL30).
- `POST /api/v2/Cotizaciones/MEP` — body `{ simbolo, idPlazoOperatoriaCompra, idPlazoOperatoriaVenta }` para el MEP con plazos específicos.

### 2.7 FCIs (consulta)

- `GET /api/v2/Titulos/FCI` — todos los fondos.
- `GET /api/v2/Titulos/FCI/{simbolo}` — un fondo.
- `GET /api/v2/Titulos/FCI/Administradoras`, `…/Administradoras/{adm}/TipoFondos`, `…/TipoFondos` — catálogo por administradora/tipo.

---

## 3. Cómo consume esta app las cotizaciones

El navegador **nunca** habla directo con IOL: pega a proxies serverless de Vercel que autentican, normalizan y cachean. Ambos proxies devuelven filas con la **misma forma que data912** (`CedearRow`), así el frontend y el motor de arbitraje no distinguen la fuente.

### 3.1 `api/iol/panel.js` → `/api/iol/panel?id={panel}`

Fuente primaria de la pantalla **Cotizaciones**. Mapeo interno:

| `id` del frontend | Instrumento IOL | País |
|---|---|---|
| `acciones` | `acciones` | `argentina` |
| `bonos` | `titulosPublicos` | `argentina` |
| `letras` | `letras` | `argentina` |
| `ons` | `obligacionesNegociables` | `argentina` |
| `opciones` | `opciones` | `argentina` |
| `usa` | `acciones` | `estados_Unidos` |

Cache de 3s por panel (dedupea el polling de 1s del frontend). Si IOL falla o devuelve vacío, el frontend cae a data912 (`refreshFast()` en `app.ts` pide ambos en paralelo y elige).

Mapeo de campos IOL → forma común:

| Campo app | Campo IOL |
|---|---|
| `symbol` | `simbolo` |
| `px_bid` / `q_bid` | `puntas.precioCompra` / `puntas.cantidadCompra` |
| `px_ask` / `q_ask` | `puntas.precioVenta` / `puntas.cantidadVenta` |
| `v` | `volumen` |
| `q_op` | `cantidadOperaciones` |
| `c` | `ultimoCierre` |
| `pct_change` | `variacionPorcentual` |
| `desc` | `descripcion` (solo panel.js; suma para bonos/ONs) |

### 3.2 `api/iol/cedears.js` → `/api/iol/cedears?plazo=t0|t1`

Feed de CEDEARs para el arbitraje, con lógica por plazo:

- **`plazo=t1` (24hs):** un solo request al panel (§2.1) → ~900 símbolos con libro 24hs real.
- **`plazo=t0` (CI):** el panel no sirve (ignora plazo), entonces:
  1. Pide el panel de 24hs para **descubrir pares líquidos** (base + baseD/baseC) con volumen efectivo ≥ `IOL_CI_MIN_USD` (default USD 500), top `IOL_CI_TOP` por sufijo (default 30).
  2. Cotiza **símbolo por símbolo** (§2.2) con `model.plazo=t0`, concurrencia acotada a 20.
  3. Devuelve menos filas, pero todas con libro CI **real**. Si el burst falla, devuelve `[]` y el frontend estima el CI desde 24hs.

En la cadena de fuentes de CEDEARs, IOL es el **fallback de Cohen** (feed Primary/XOMS en el VPS): Cohen → IOL; data912 quedó fuera.

### 3.3 Buenas prácticas ya incorporadas (mantener al extender)

- `Cache-Control: no-store` en todas las respuestas de cotizaciones (el CDN no debe servir precios viejos).
- Token cacheado con margen de 30s antes de expirar; re-auth única ante 401.
- Concurrencia acotada en bursts por símbolo (`mapLimit`), fallos individuales → `null`, nunca tiran todo el burst.
- IOL no publica rate limits formales, pero el burst CI es el patrón más agresivo que usamos (~60 requests); no escalarlo sin medir.

---

## 4. Operatoria (para la futura pantalla **Operar**)

> ⚠️ **Estado actual:** la cuenta IOL del empleado todavía **no tiene la API de operatoria habilitada**. Esta sección documenta los endpoints oficiales para que la pantalla se diseñe contra el contrato real, y se conecte cuando esté el permiso. Todos requieren el mismo Bearer token de §1.

### 4.1 Estado de cuenta y portafolio

```
GET /api/v2/estadocuenta
```

Devuelve `EstadoCuentaModel`: array de `cuentas` + `totalEnPesos`. Cada cuenta:

| Campo | Valores / significado |
|---|---|
| `tipo` | `inversion_Argentina_Pesos`, `inversion_Argentina_Dolares`, `inversion_Estados_Unidos_Dolares`, variantes `administrada_…` |
| `moneda` | `peso_Argentino`, `dolar_Estadounidense`, … |
| `disponible` | saldo operable (lo que valida "¿alcanza para esta orden?") |
| `comprometido` | retenido por órdenes pendientes |
| `saldo`, `titulosValorizados`, `total` | composición de la cuenta |
| `estado` | `operable` \| `cerrada` \| `bloqueada` |

```
GET /api/v2/portafolio/{pais}        (argentina | estados_Unidos)
```

Devuelve `PortafolioModel` con los `activos` en cartera (título, cantidad, precio promedio, valorizado). Es la fuente de la **tenencia disponible para vender**.

```
GET /api/v2/datos-perfil
```

Datos del titular (nombre, perfil inversor).

### 4.2 Enviar órdenes

```
POST /api/v2/operar/Comprar
POST /api/v2/operar/Vender
Content-Type: application/json
```

Body (`ComprarBindingModel` / `VenderBindingModel`):

| Campo | Tipo | Valores / notas |
|---|---|---|
| `mercado` | string | `bCBA`, `nYSE`, `nASDAQ`, `aMEX`, `bCS`, `rOFX` |
| `simbolo` | string | ticker (ej. `AL30`, `AAPL` — CEDEAR es `bCBA`) |
| `cantidad` | number | nominales. En compra se puede omitir y mandar `monto` |
| `monto` | number | (solo Comprar) importe total; IOL calcula la cantidad |
| `precio` | number | obligatorio si `tipoOrden=precioLimite` |
| `tipoOrden` | string | `precioLimite` \| `precioMercado` |
| `plazo` | string | `t0` (CI), `t1` (24hs), `t2` (72hs), `t3` |
| `validez` | string | fecha `yyyy-MM-dd` hasta la que vive la orden |
| `idFuente` | int | opcional, identificador de origen |

La respuesta exitosa incluye el/los **número(s) de operación** con los que después se consulta o cancela.

Variantes:

- `POST /api/v2/operar/ComprarEspecieD` / `VenderEspecieD` — compra/venta de la especie D (pata en dólares; es lo que se usa para armar MEP manualmente). Existe también `POST /api/v2/asesores/operar/VenderEspecieD` (rol asesor).
- `POST /api/v2/operar/suscripcion/fci` — body `{ simbolo, monto, soloValidar }`.
- `POST /api/v2/operar/rescate/fci` — body `{ simbolo, cantidad, soloValidar }`. El flag `soloValidar: true` **simula** la operación (valida saldo/mercado sin ejecutar) — útil para la previsualización del ticket.
- `POST /api/v2/operar/Token` — token de operatoria (segundo factor para ciertas cuentas).
- Cauciones/CPD: `POST /api/v2/operar/CPD`, `GET /api/v2/operar/CPD/Comisiones/{importe}/{plazo}/{tasa}`, `GET /api/v2/operar/CPD/PuedeOperar`.

### 4.3 Historial, detalle y cancelación de órdenes

```
GET /api/v2/operaciones
    ?filtro.estado=todas|pendientes|terminadas|canceladas
    &filtro.fechaDesde=2026-07-01
    &filtro.fechaHasta=2026-07-14
    &filtro.pais=argentina
    &filtro.numero=…
```

Devuelve array de `OperacionModel`:

```json
{
  "numero": 123456,
  "fechaOrden": "2026-07-14T11:03:00",
  "tipo": "compra",
  "estado": "parcialmente_Terminada",
  "mercado": "bcba",
  "simbolo": "AL30",
  "cantidad": 100, "precio": 68000.0, "monto": 6800000.0,
  "modalidad": "precio_Limite",
  "cantidadOperada": 60, "precioOperado": 67990.0, "montoOperado": 4079400.0,
  "plazo": "a24horas",
  "fechaOperada": "2026-07-14T11:04:12"
}
```

- `GET /api/v2/operaciones/{numero}` — detalle completo (`OperacionDetalleModel`): agrega `estados` (trazabilidad), `aranceles` (comisiones ARS/USD), y `operaciones` (los fills parciales: fecha/cantidad/precio de cada ejecución).
- `DELETE /api/v2/operaciones/{numero}` — **cancela** una orden pendiente.

### 4.4 Estados de una orden (enum oficial → UI)

Estados posibles de `estado` / `estadoActual`, con el mapeo sugerido a las familias semánticas del UI kit (`docs/ui-kit.md`):

| Estado IOL | Significado | Familia UI |
|---|---|---|
| `iniciada` | recibida por IOL, aún no en mercado | neutro |
| `en_Proceso` | en el mercado, sin ejecutar | `accent` (azul) |
| `parcialmente_Terminada` | ejecutada en parte | `warn` (ámbar) |
| `terminada` | ejecutada por completo | `pos` (verde) |
| `pendiente_Cancelacion` | cancelación pedida, no confirmada | `warn` |
| `parcialmente_Terminada_Con_Pedido_Cancelacion` | fill parcial + cancelación pedida | `warn` |
| `cancelada` | cancelada | neutro (`ink-3`) |
| `cancelada_Por_Vencimiento_Validez` | venció la validez sin ejecutarse | neutro |
| `en_Modificacion` | siendo modificada | `warn` |

Tipos de operación (`tipo`): `compra`, `venta`, `caucion`, `suscripcion`, `rescate`, `suscripcionPrimaria`, `suscripcionFCI`, `rescateFCI`.
Plazos en respuestas: `inmediata` (CI), `a24horas`, `a48horas`, `a72horas`, `sinValor`.

### 4.5 Operatoria simplificada (dólar MEP "en un paso")

Para replicar el MEP simple estilo IOL (sin operar las dos patas a mano):

- `GET /api/v2/OperatoriaSimplificada/{idTipoOperatoria}/Parametros` — parámetros vigentes (plazos, símbolos usados).
- `GET /api/v2/OperatoriaSimplificada/Validar/{monto}/{idTipoOperatoria}` — valida si el monto es operable.
- `GET /api/v2/OperatoriaSimplificada/MontosEstimados/{monto}` — cuántos USD salen de X pesos (compra MEP).
- `GET /api/v2/OperatoriaSimplificada/VentaMepSimple/MontosEstimados/{monto}` — inverso (venta MEP).
- `POST /api/v2/OperatoriaSimplificada/Comprar` — ejecuta.

### 4.6 Rol Asesor

Boston es **asesor** (no ALyC). El swagger expone endpoints específicos del rol: `POST /api/v2/asesores/operar/VenderEspecieD`, `GET|POST /api/v2/asesores/test-inversor` (+ `/{idClienteAsesorado}`), `POST /api/v2/Asesor/Movimientos`. La operatoria sobre cuentas asesoradas depende de los permisos que IOL habilite a la cuenta — validar con IOL qué alcance tiene el permiso de API que se está tramitando para el empleado.

### 4.7 Plan de integración sugerido (cuando la API esté habilitada)

1. **Nuevo proxy serverless** `api/iol/operar.js` con el mismo patrón que `panel.js` (token server-side, re-auth ante 401), exponiendo solo lo que la pantalla necesita: `GET estadocuenta`, `GET portafolio`, `GET/DELETE operaciones`, `POST comprar/vender`.
2. **Nunca** exponer el token al navegador ni aceptar del cliente campos que no valide el server (whitelist de mercado/símbolo/plazo).
3. Usar `soloValidar`/previsualización para el paso "Revisar" del ticket antes del envío real.
4. Polling de `GET /api/v2/operaciones?filtro.estado=pendientes` para refrescar estados (no hay webhooks/streaming en la API REST).
