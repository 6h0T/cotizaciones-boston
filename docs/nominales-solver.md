# Solver de nominales enteros para el broker

> Spec / diseño. **NO implementa código.** Sirve de fuente de verdad para la
> tarea de ingeniería. Tono y vocabulario consistentes con el resto de la app.

## 1. Problema

Hoy el motor (`computeTrade` en `src/app/arb-engine.ts`) calcula el round-trip
ARS→USD→ARS con cantidades **fraccionarias** (`n1`, `n2` son `number` con
decimales). Eso sirve para estimar el rendimiento porcentual, pero el operador
no puede cargar 3,3185 nominales en el broker: tiene que apretar un **entero**.
Necesitamos un solver paralelo que, dado un presupuesto en ARS, devuelva
**cuántos nominales enteros** hay que comprar y vender en cada una de las 4
acciones del broker (compro pesos / vendo dólares / compro dólares / vendo
pesos), respetando que cada compra se hace con `floor` del dinero disponible y
que la segunda pata se financia **con los dólares realmente obtenidos** en la
primera, no con el presupuesto en ARS. El resultado incluye los sobrantes
("no me alcanza para otro nominal") y la ganancia realizada sobre esos enteros.

## 2. Algoritmo (paso a paso)

Entrada: `buy: ArbPair`, `sell: ArbPair`, `budgetArs`, `commissionPct`.

Precios usados (mismos campos que `ArbPair`/`computeTrade`):
- `buy.arsAsk`  → precio al que **compro** el CEDEAR en pesos (pata 1).
- `buy.usdBid`  → precio al que **vendo** su par en dólares (pata 2).
- `sell.usdAsk` → precio al que **compro** el CEDEAR en dólares (pata 3).
- `sell.arsBid` → precio al que **vendo** su par en pesos (pata 4).

Profundidad de libro (clamp, nunca recomendar más de lo que sostiene el book):
- pata de compra (buy): `Math.min(buy.qArsAsk, buy.qUsdBid)`
- pata de venta (sell): `Math.min(sell.qUsdAsk, sell.qArsBid)`
  (idéntica convención que `buyVolUnits`/`sellVolUnits` en `computeTrade`).

Pasos:

```
1) nBuy  = floor(budgetArs / buy.arsAsk)
   nBuy  = min(nBuy, floor(buy depth))          // clamp por profundidad de la pata de compra
   arsSpent     = nBuy * buy.arsAsk
   arsLeftover  = budgetArs - arsSpent

2) usdObtained = nBuy * buy.usdBid               // dólares REALMENTE obtenidos

3) nSell = floor(usdObtained / sell.usdAsk)      // limitado por los USD del paso 2, NO por budgetArs
   nSell = min(nSell, floor(sell depth))         // clamp por profundidad de la pata de venta
   usdSpent     = nSell * sell.usdAsk
   usdLeftover  = usdObtained - usdSpent

4) arsOut = nSell * sell.arsBid                   // pesos de salida
```

Ganancia: se despliegan TODOS los dólares obtenidos en la 1.ª pata. El `floor`
de `nSell` deja USD ociosos (`usdLeftover`); valuarlos al tipo de la pata
vendedora equivale a desplegarlos y evita subestimar la ganancia (comparar lo
invertido contra el ARS de MENOS dólares de los que se obtuvieron da pérdidas
falsas).

```
usdSellRate    = sell.arsBid / sell.usdAsk      // ARS por USD en la pata vendedora
usdLeftoverArs = usdLeftover * usdSellRate       // valor en ARS del sobrante USD
arsOutFull     = arsOut + usdLeftoverArs          // = usdObtained * usdSellRate
grossProfit    = arsOutFull - arsSpent
netProfit      = grossProfit - arsSpent * (commissionPct / 100)
netPct         = arsSpent > 0 ? (netProfit / arsSpent) * 100 : 0
```

> Nota de diseño: la ganancia se mide contra `arsSpent` (lo efectivamente
> invertido), no contra `budgetArs`, porque el `arsLeftover` nunca entró al
> trade. El `usdLeftover` SÍ entra (valuado a `usdSellRate`), porque son dólares
> que ya tenés. Esto difiere de `computeTrade`, que usa el monto teórico completo.

**Por qué el paso 3 usa los USD obtenidos y no el presupuesto** (caso canónico):
con $150.000 y TMUS @ 8200, `floor(150000/8200)=18` sería **incorrecto**; el
límite real son los 100,38 USD que entraron del paso 2 → `floor(100.38/5.62)=17`.

### Casos nulos (devolver `null`)
- `budgetArs <= 0`.
- Algún precio inválido: `buy.arsAsk`, `buy.usdBid`, `sell.usdAsk`, `sell.arsBid`
  no finito o `<= 0` (misma validación `validPrice` que usa el motor).
- `nBuy === 0` (el presupuesto no alcanza ni para 1 nominal de la pata de
  compra, o la profundidad del libro es 0). En ese caso no hay plan operable.

## 3. Firma propuesta + tipos

### `NominalsPlan` (agregar a `src/app/market.config.ts`)

```ts
export interface NominalsPlan {
  // Identidad de las patas
  buyBase: string;       // buy.base (ticker en ARS de la pata de compra)
  buyArsTicker: string;  // = buy.base (alias explícito: lo que se compra en pesos)
  sellUsdTicker: string; // par en dólares de la pata de compra (buy.base + sufijo), lo que se VENDE en USD
  buyUsdTicker: string;  // par en dólares de la pata de venta (sell.base + sufijo), lo que se COMPRA en USD (fila 3)
  sellBase: string;      // sell.base (ticker en ARS de la pata de venta)

  // Precios unitarios de cada acción (plan autosuficiente para la UI)
  buyArsAsk: number;     // fila 1 (buy.arsAsk)
  buyUsdBid: number;     // fila 2 (buy.usdBid)
  sellUsdAsk: number;    // fila 3 (sell.usdAsk)
  sellArsBid: number;    // fila 4 (sell.arsBid)

  // Paso 1 — compro CEDEAR en ARS
  nBuy: number;          // nominales enteros comprados
  arsSpent: number;      // nBuy * buy.arsAsk
  arsLeftover: number;   // budgetArs - arsSpent

  // Paso 2 — vendo su par en USD
  usdObtained: number;   // nBuy * buy.usdBid

  // Paso 3 — compro CEDEAR en USD
  nSell: number;         // nominales enteros comprados con usdObtained
  usdSpent: number;      // nSell * sell.usdAsk
  usdLeftover: number;   // usdObtained - usdSpent

  // Paso 4 — vendo su par en ARS
  arsOut: number;        // nSell * sell.arsBid

  // Resultado realizado sobre los ENTEROS
  commissionPct: number; // entrada, eco para la UI/disclaimer
  grossProfit: number;   // arsOut - arsSpent
  netProfit: number;     // grossProfit - arsSpent * commissionPct/100
  netPct: number;        // netProfit / arsSpent * 100
}
```

> El sufijo USD se deriva con `SUFFIX[dollarType]`, pero el solver es puro y no
> conoce el `dollarType`. Opciones: (a) pasar `usdSuffix` en `opts`, o
> (b) que el componente complete `sellUsdTicker` con `usdTicker(buyBase)`. Se
> recomienda (b): el solver setea `sellUsdTicker = buyBase` provisional y la UI
> ya tiene `usdTicker()`; o más simple, agregar `usdSuffix: 'D' | 'C'` a `opts`.
> **Decisión:** agregar `usdSuffix` a `opts` para que el plan sea autosuficiente.

### Firma de la función pura (agregar a `src/app/arb-engine.ts`)

```ts
export function solveNominals(
  buy: ArbPair,
  sell: ArbPair,
  opts: { budgetArs: number; commissionPct: number; usdSuffix: 'D' | 'C' },
): NominalsPlan | null
```

- Pura, sin efectos secundarios, no muta la entrada (igual que `computeTrade`).
- Reutiliza la misma `validPrice` interna.
- `sellUsdTicker = buy.base + opts.usdSuffix`; `buyArsTicker = buy.base`.

## 4. Las 4 acciones del broker (lo que renderiza la UI)

Tabla que **espeja el layout del Excel** `Arbitrage.xlsx`:

| # | Acción            | Ticker          | Precio              | Nominales | Monto                 |
|---|-------------------|-----------------|---------------------|-----------|-----------------------|
| 1 | Compro (ARS)      | `buyArsTicker`  | `buy.arsAsk` ARS    | `nBuy`    | `arsSpent` ARS        |
| 2 | Vendo (USD)       | `sellUsdTicker` | `buy.usdBid` USD    | `nBuy`    | `usdObtained` USD     |
| 3 | Compro (USD)      | `sell USD tk`   | `sell.usdAsk` USD   | `nSell`   | `usdSpent` USD        |
| 4 | Vendo (ARS)       | `sellBase`      | `sell.arsBid` ARS   | `nSell`   | `arsOut` ARS          |

Más una línea de **sobrante** al pie:

```
Sobrante: $ {arsLeftover} ARS  ·  USD {usdLeftover}
("no alcanza para otro nominal con el dinero disponible")
```

- El ticker USD de la fila 3 es el par en dólares del `sellBase`
  (`sellBase + usdSuffix`). Conviene exponerlo también en el plan o derivarlo en
  la UI con `usdTicker(sellBase)`.
- Formatear con el helper existente `fmt()`: ARS con 0–2 dec, USD con 2 dec,
  nominales con 0 dec.

## 5. Casos de test (TDD)

Tests unitarios del solver (Vitest/Jasmine, archivo en `tests/` o junto al
motor según convención del repo). **Escribir estos tests ANTES de implementar.**

### Caso canónico KEEL/TMUS (fuente de verdad — Arbitrage.xlsx)
Budget = 150000, commissionPct arbitrario (ej. 0).
- `buy`:  KEEL `arsAsk = 45200`, `usdBid = 33.46` (par KEELD), depth alta.
- `sell`: TMUS `arsBid = 8200`,  `usdAsk = 5.62`  (par TMUSD), depth alta.

Esperado:
- `nBuy === 3`
- `arsSpent === 135600`, `arsLeftover === 14400`
- `usdObtained === 100.38`  (3 × 33.46)
- `nSell === 17`  (floor(100.38 / 5.62) = 17, **no** 18)
- `usdSpent === 95.54`, `usdLeftover ≈ 4.84` (tolerancia float)
- `arsOut === 139400`  (17 × 8200, sólo los enteros vendidos)
- `usdSellRate === 8200 / 5.62`; `usdLeftoverArs ≈ 4.84 × 8200/5.62 ≈ 7061.92`
- `arsOutFull ≈ 100.38 × 8200/5.62 ≈ 146461.92`  (desplegar los 100.38 USD)
- `grossProfit ≈ 146461.92 - 135600 ≈ 10861.92`  (cuenta el sobrante USD; NO 3800,
  que era el cálculo naïve del Excel sin valuar el sobrante)

### Edge cases
1. **Presupuesto insuficiente para 1 nominal**: `budgetArs = 40000`, `buy.arsAsk
   = 45200` → `nBuy = 0` → devuelve `null` (no hay plan operable).
2. **Profundidad limita los nominales**: budget alcanzaría para 5 pero
   `min(qArsAsk,qUsdBid) = 2` → `nBuy === 2` (clamp). Análogo para `nSell` con
   `min(qUsdAsk,qArsBid)`.
3. **Budget cero o negativo**: `budgetArs = 0` y `budgetArs = -100` → `null`.
4. **Precio inválido**: `buy.arsAsk = 0` (o NaN) → `null`. Idem `buy.usdBid`,
   `sell.usdAsk`, `sell.arsBid`.
5. **USD obtenidos no alcanzan para 1 nominal de venta**: `nBuy ≥ 1` pero
   `usdObtained < sell.usdAsk` → `nSell === 0`, `arsOut === 0`. Definir si esto
   es plan válido (con netProfit negativo) o `null`. **Decisión:** devolver el
   plan con `nSell = 0` (es informativo: compraste pero no podés cerrar), salvo
   que se prefiera `null`; documentarlo en el test elegido.
6. **netPct sobre arsSpent**: verificar que el denominador es `arsSpent`, no
   `budgetArs` (con leftover grande los números difieren).

## 6. Integración en la UI

Archivo: `src/app/arbitrage.component.ts` (componente single-file con
signals/computed).

- **Ubicación del panel**: una nueva `card` dentro de `.grid` (o un bloque
  propio debajo del `.auto-banner`), titulada p.ej. *"Nominales a operar en el
  broker"*. Encaja naturalmente junto a la card "3. Resultado del trade".
- **Reutilizar selección existente**: `selectedBuy()` y `selectedSell()` ya dan
  los `ArbPair` elegidos (auto o manual). No duplicar lógica de selección.
- **Nueva signal de presupuesto**: `budgetArs = signal<number>(...)`
  independiente de `amountArs` (este último es el monto teórico para el %).
  Alternativa: reusar `amountArs()` como presupuesto. **Decisión:** señal
  separada `budgetArs` con su propio `<input>` (mismo patrón `.monto` que los
  inputs existentes), porque el usuario querrá un número "real de bolsillo".
- **Computed del plan**:
  ```ts
  nominalsPlan = computed<NominalsPlan | null>(() => {
    const buy = this.selectedBuy(), sell = this.selectedSell();
    if (!buy || !sell) return null;
    return solveNominals(buy, sell, {
      budgetArs: this.budgetArs(),
      commissionPct: this.commissionPct(),
      usdSuffix: SUFFIX[this.dollarType()],
    });
  });
  ```
- **Render**: tabla de 4 filas (sección 4) con `@if (nominalsPlan(); as plan)`.
  Si es `null`, mostrar mensaje tipo `.empty` ("El presupuesto no alcanza para
  un nominal" / "Sin par operable").
- **Diseño**: usar el sistema de variables CSS existente —
  `var(--ink)`, `var(--ink-2)`, `var(--ink-3)`, `var(--surface)`,
  `var(--surface-2)`, `var(--line)`, `var(--pos)`, `var(--pos-bg)`,
  `var(--pos-line)`, `var(--pos-strong)`, `var(--warn)`, `var(--font-mono)`,
  `var(--r-lg)`, `var(--shadow-sm)`. Reusar clases `.card`, `.row`, `.tk`,
  `.pv`, `.step` y el helper `fmt()`. La línea de sobrante puede ir con el
  tratamiento ámbar (`var(--warn-bg)`/`var(--warn-line)`) o neutro `var(--ink-3)`.
- **Congelar para operar**: el panel es justo lo que el usuario mira cuando
  aprieta "Congelar para operar"; debe seguir visible y estable bajo `paused()`.

## 7. Orden de implementación

1. **Tipos + motor + tests (TDD primero)**:
   - Agregar `NominalsPlan` a `market.config.ts`.
   - Implementar `solveNominals` en `arb-engine.ts`.
   - Escribir los tests de la sección 5 **antes** de la implementación; el caso
     KEEL/TMUS (3 y 17 + sobrantes) es el verde obligatorio.
   - `npm test` y `npm run build` en verde.
2. **UI del componente**:
   - Signal `budgetArs`, computed `nominalsPlan`, input y tabla de 4 acciones +
     sobrante en `arbitrage.component.ts`, con el design system existente.
3. **QA manual**:
   - Dev server Angular en `localhost:4200`. Verificar contra el Excel con
     budget $150.000 que las 4 acciones muestran KEEL ×3, KEELD ×3, TMUSD ×17,
     TMUS ×17 y los sobrantes 14.400 ARS / ~4,84 USD.
   - Probar congelar/operar, budget chico (panel vacío), y profundidad limitante.

## 8. Estado de implementación (QA — 2026-06-17)

**Implementado y verificado.**

- **Motor**: `solveNominals()` en `arb-engine.ts` (pura, con `floorQty()` robusto a
  ruido IEEE-754) + tipo `NominalsPlan` en `market.config.ts` (incluye los 4
  tickers y los 4 precios unitarios → plan autosuficiente) + `DEFAULTS.budgetArs`.
- **UI**: panel *"Nominales a apretar en el broker"* en `arbitrage.component.ts`
  (signal `budgetArs`, computed `nominalsPlan`, input de presupuesto, tabla de 4
  acciones + sobrante + ganancia neta), con el design system existente.
- **Tests (TDD)**: 15 casos en `arb-engine.spec.ts`, incluido el canónico del
  Excel (KEEL ×3 / TMUS ×17, sobrantes 14.400 ARS / ~4,84 USD), clamps de
  profundidad, nulos, `nSell=0`, no-mutación, par-consigo-mismo y el guard de
  punto flotante. **`ng test`: 45/45 verde.**
- **Build**: `ng build --configuration production` limpio (se subió el budget de
  `anyComponentStyle` a 14 kB en `angular.json`; techo de error 16 kB intacto).
- **Review independiente**: sin blockers; la matemática coincide con el Excel.
  Aplicados SF1 (precios en el plan, sin `selectedBuy()!`), SF2 (doc), SF3
  (`min=1000`), SF4 (test par-consigo-mismo), SF5 (floor robusto). NITs N1
  (`buyBase` redundante) y N3 (regla CSS vacía) no aplicados por ser cosméticos.
- **Pendiente conocido (pre-existente, ajeno a este feature)**: `app.spec.ts` no
  importa `describe` de vitest y sólo corre bajo `ng test` (no bajo `npx vitest`
  crudo). No se tocó.
