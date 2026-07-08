# UI Kit — Cotizaciones Boston

Guía del sistema de diseño de la app. Todo vive en tres lugares:

| Archivo | Qué contiene |
|---|---|
| `src/styles.css` | Tokens globales (`:root`), reset, scrollbars, utilidades numéricas |
| `src/app/app.css` | Componentes del shell: toolbar, nav, controles, subbar, tablas, footer, alert bar |
| `src/app/arbitrage.component.ts` | Estilos propios del panel de arbitraje (inline en el componente) |

Las fuentes se cargan por Google Fonts desde `src/index.html` (Geist, Geist Mono, Manrope).

---

## 1. Filosofía

**Terminal financiera, densa y funcional.** Inspirada en la colorimetría de la Terminal de Bloomberg, adaptada a fondo claro:

- **Base neutra y calma de baja fatiga**: off-white "papel" en vez de blanco puro (reduce glare en sesiones largas de mercado).
- **El color saturado se RESERVA para significado**: compra/venta, P&L, oportunidad. El verde resalta justamente porque casi todo lo demás es neutro.
- **Un único acento** (azul eléctrico), usado con moderación.
- **Números siempre en monospace** con dígitos tabulares (las columnas no "bailan" cuando los precios cambian cada segundo).
- Prohibido: púrpura "AI", glows, gradientes decorativos, cajas redondeadas de relleno.

---

## 2. Tokens (`:root` en `src/styles.css`)

### Tipografía

| Token | Valor | Uso |
|---|---|---|
| `--font-ui` | Geist, system-ui… | Texto de interfaz por defecto |
| `--font-display` | Manrope | Títulos y marca (igual que boston-ar) |
| `--font-mono` | Geist Mono, JetBrains Mono… | Todos los números, tickers, estados |

Utilidad: la clase `.mono` / `.num` (también `td.num`, `th.num`) aplica monospace + `tabular-nums`. **Toda celda numérica lleva `class="num"`** — eso da alineación a la derecha y grilla numérica estable.

### Superficies (off-white papel)

| Token | Hex | Uso |
|---|---|---|
| `--bg` | `#f3f2f0` | Fondo de la página |
| `--surface` | `#fdfdfc` | Cards, tablas, inputs, menús |
| `--surface-2` | `#efeeeb` | Headers de tabla, hover, control segmentado |
| `--surface-3` | `#e6e5e1` | Nivel más profundo (reservado) |

### Tinta (texto)

| Token | Hex | Uso |
|---|---|---|
| `--ink` | `#1a1a1d` | Datos y texto principal (casi-negro neutro) |
| `--ink-2` | `#4d4d54` | Texto secundario legible |
| `--ink-3` | `#78787f` | Labels, hints, metadatos |

### Líneas

| Token | Hex | Uso |
|---|---|---|
| `--line` | `#e4e3df` | Bordes por defecto |
| `--line-2` | `#d2d1cc` | Bordes en hover / énfasis |

### Acento (único)

| Token | Hex | Uso |
|---|---|---|
| `--accent` | `#2563eb` | Focus rings, marcador de compra |
| `--accent-2` | `#1d4ed8` | Texto sobre wash de acento |
| `--accent-sf` | `#eef3ff` | Wash de fondo (selección, hover de fila, `::selection`) |

### Semántica P&L

Cada familia tiene 4 tonos: texto (`--pos`), fondo wash (`--pos-bg`), borde (`--pos-line`) y **`--pos-strong`** — el tono más profundo, reservado para los números protagonistas (ganancia neta, volumen operable).

| Familia | Texto | Fondo | Borde | Strong | Significado |
|---|---|---|---|---|---|
| `pos` | `#15803d` | `#ecfbf1` | `#a6e6bf` | `#166534` | Ganancia, oportunidad, "en vivo" |
| `neg` | `#be1f1f` | `#fceff0` | `#f3bbbb` | `#991b1b` | Pérdida realizada, error |
| `warn` | `#b45309` | `#fcf5e6` | `#f0d384` | `#92400e` | Pausado, estimado, venta, "sin oportunidad" |

> Regla importante: un neto negativo en el simulador se trata como **"sin oportunidad" (informativo) → ámbar**, no rojo. El rojo se reserva para pérdidas realizadas y errores.

### Radios y sombras

| Token | Valor | Uso |
|---|---|---|
| `--r-sm` | 6px | Botones, inputs, chips |
| `--r` | 8px | Cajas de aviso, control segmentado |
| `--r-lg` | 12px | Cards, tablas, menús |
| `--shadow` | doble capa suave | Menús flotantes |
| `--shadow-sm` | 1px sutil | Cards, botón segmentado activo |
| `--toolbar-h` | 52px | Altura de la toolbar sticky |

---

## 3. Componentes del shell (`src/app/app.css`)

### Toolbar (`.toolbar`)
Barra única sticky de 52px con **marca · nav · controles a la misma altura**. Fondo translúcido `rgba(253,253,252,.82)` + `backdrop-filter: blur(12px)`, borde inferior `--line`.

- **Marca** (`.brand`): punto cuadrado (`.brand-dot`) + "BAM" en monospace con tracking amplio (`.brand-mono`).

### Navegación
- **Control segmentado** (`.seg` + `.seg-btn`): contenedor `--surface-2` con borde; el botón activo (`.on`) "flota" con fondo `--surface`, sombra sm y anillo interno `--line-2`. Es la nav primaria (las 4 tabs de arbitraje).
- **Dropdown "Mercados"** (`.dropdown`, `.drop-trigger`, `.menu`, `.menu-item`): colapsa los paneles de datos. El menú entra con animación `menu-in` (140ms, ease `cubic-bezier(.16,1,.3,1)`, translate + scale sutil). Cada ítem muestra label + estado en mono chico (`.mi-status`, rojo con `.err`). Un `.backdrop` fijo invisible cierra el menú al clickear afuera.

### Controles (derecha de la toolbar)
Todos miden **32px de alto**, borde `--line`, fondo `--surface`, radio `--r-sm`:

| Clase | Qué es |
|---|---|
| `.icon-btn` | Botón de ícono (refresh; el SVG gira con `.spin` al cargar) |
| `.rate` | Input del intervalo de refresco (número mono, sin spinners) |
| `.toggle` | En vivo / Pausado. Incluye `.live-dot`: punto verde con `pulse` (onda de box-shadow); pausado → `.paused` en ámbar, dot apagado |
| `.alert-toggle` | Campana de avisos; activada (`.on`) vira a familia `pos`; `.alert-badge` = contador verde |
| `.export` | Acción primaria: fondo `--ink` sólido, texto blanco (XLSX) |

Patrón de interacción compartido: hover cambia fondo/borde (transiciones de 120ms), `:active` baja 1px (`translateY(1px)`), disabled a opacidad .5.

### Alert bar (`.alert-bar`)
Banner global de oportunidades > 2% neto. Familia `pos` completa: fondo `--pos-bg`, borde inferior `--pos-line` y **barra de acento de 3px a la izquierda** (`border-left`). Cada `.alert-item` es un chip clickeable que navega a la tab: neto grande en `--pos-strong` (`.ai-net`), ticker/leyenda en mono, y chip `.ai-est` ámbar si el CI es estimado.

### Subbar (`.subbar`)
Título del panel activo (`.crumb strong` en Manrope) + estado en mono chico (`.status-cap`) + `.pill.warn` "Snapshot congelado" cuando está pausado. A la derecha, `.search` (focus = borde acento + ring de 3px `--accent-sf`) y `.count`.

### Tabla densa de datos (`.table-wrap`)
Contenedor con borde y `--r-lg`, scroll interno con `max-height`. Dentro:
- `th`: uppercase 10.5px, tracking 0.05em, `--ink-3`, fondo `--surface-2`, **sticky**.
- `td`: 7px×12px de padding, `white-space: nowrap`, fila cebra suave (`nth-child(even)`), hover con wash `--accent-sf`.
- Columnas numéricas: `th.num` / `td.num` → derecha + mono tabular.

### Otros
- `.error-box`: familia `neg`.
- `.empty`: estado vacío centrado, **borde punteado** (`dashed`).
- `.foot`: footer fijo translúcido con la fuente de datos, 11px `--ink-3`.
- Responsive (≤760px): la toolbar se apila (marca → controles → nav con scroll horizontal), paddings reducidos, search fluido.

---

## 4. Componentes del panel de arbitraje (`arbitrage.component.ts`)

### Cabecera del panel (`.arb-head`)
Fila de parámetros separada por borde inferior:
- **Badges** (`.badge`): tipo de dólar (`.dollar`, fondo `--ink` invertido) y plazo (`.plazo`, neutro con borde). Mono uppercase 11px.
- **Inputs de parámetros** (`.monto`): label uppercase chico arriba, input mono abajo. Variantes por ancho: `.comm`, `.vol`, `.ci` (100px). La de ajuste CI vira a ámbar.
- `.pair-count`: contador de pares operables, mono, alineado a la derecha (`margin-left: auto`).
- `.freeze-btn`: "Congelar para operar", estilo acción primaria (fondo `--ink`, ícono candado).

### Freeze bar (`.freeze-bar`)
Aviso de estado congelado: familia `warn` con barra izquierda de 3px, candado, texto explicativo y botón `.fb-resume` verde sólido "Reanudar en vivo".

### Avisos contextuales
- `.ci-note`: ámbar cuando el CI es estimado desde 24hs; `.ci-note.real` verde cuando el libro T+0 es real (IOL).
- `.vol-warn`: ámbar cuando ningún par pasa el volumen mínimo.

### Cards de puntas (`.grid` + `.card.buy` / `.card.sell`)
Grid `auto-fit, minmax(264px, 1fr)`. Cada card:
- `h3` con **marcador cuadrado de 7px** (`::before`) codificado por tipo: **azul = compra, ámbar = venta, verde = resultado**. Este marcador reemplaza a la franja lateral completa.
- `select` para override manual (elegir manualmente **congela** el refresh).
- `.card-ticker`: el ticker protagonista a 30px mono, coloreado por pata (`--accent-2` compra / `--warn-strong` venta).
- `.row`: filas label-valor; `.tk` = chip del ticker real; `.pv` apila precio arriba y volumen operable (`.qty`) debajo; `.row.big` es la fila protagonista con el precio del dólar a 18px.

### Plan de nominales (`.nominals` + `.nm-table`)
El output accionable: tabla de las 4 órdenes a apretar en el broker.
- **Codificación direccional estilo blotter**: la fila entera se lee por color — `tr.op-buy` wash azul `--accent-sf`, `tr.op-sell` wash ámbar `--warn-bg`, con barra interna de 3px en la celda índice (`box-shadow: inset 3px 0 0`). Mismos tokens que `.sel-buy`/`.sel-sell` de la tabla de pares → coherencia en toda la app.
- `td.nom` (nominales): el dato protagonista, 17px bold, coloreado por pata.
- `.tk` / `.cur`: chips de ticker y moneda.
- **Footer** (`.nm-foot`): sobrantes a la izquierda; a la derecha `.nm-prof` con la ganancia — wash `pos`/`neg` según signo, barra de 3px, monto a 24px mono bold en tono `strong`.
- `.nm-empty`: mensaje cuando el presupuesto no alcanza para un nominal.

### Tabla de pares
Misma receta que la tabla densa del shell, más:
- `tr.sel-buy` → wash azul; `tr.sel-sell` → wash ámbar; ambas a la vez → wash verde.
- `td.vol-lo`: volumen bajo el mínimo, apagado a `--ink-3`.
- `td.vol-sel`: el volumen operable de la punta elegida, resaltado con anillo interno `--ink` para poder seguirlo aunque cambie cada segundo.

---

## 5. Reglas de uso (cómo extender la UI)

1. **Nunca hardcodear colores** — siempre tokens. Si un color nuevo parece necesario, casi seguro corresponde a una de las tres familias semánticas o al acento.
2. **Número = mono + tabular** (`.num` o `--font-mono` + `tabular-nums`). Sin excepción; los precios refrescan cada segundo y la grilla no debe moverse.
3. **El color comunica dirección/resultado, no decora**: azul = compra, ámbar = venta/precaución/estimado, verde = ganancia/oportunidad/vivo, rojo = pérdida realizada/error. Un mismo concepto usa los mismos tokens en toda la app.
4. **Patrón "zona destacada"**: wash de fondo de la familia + `border` o `box-shadow: inset 3px 0 0` como barra izquierda de 3px + número protagonista en tono `strong`. Se repite en alert bar, freeze bar, operable, ganancia.
5. **Escala tipográfica de datos**: metadato 10–11px uppercase con tracking → cuerpo 12–13px → dato importante 16–18px mono → protagonista 22–30px mono. Los labels nunca compiten con los números.
6. **Interacción sobria**: transiciones de 120–180ms, ease `cubic-bezier(.16,1,.3,1)` para lo que entra/rota, `:active { translateY(1px) }` en botones. Nada de glows ni escalados grandes.
7. **Controles de toolbar a 32px** de alto, radio `--r-sm`; contenedores grandes (cards, tablas, menús) a `--r-lg`.
8. **Jerarquía de botones**: primario = fondo `--ink` sólido texto blanco (Export, Congelar); secundario = borde `--line` fondo `--surface`; el verde/ámbar sólido sólo para acciones de estado (Reanudar).
9. **Estados vacíos** con borde `dashed` y texto `--ink-3` centrado.
10. **Focus visible**: borde `--accent` + ring de 3px `--accent-sf` en todo input/select.
