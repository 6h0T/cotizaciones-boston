# Investigación: Flujos y Pantallas de Operaciones (Compra/Venta)

**Objetivo:** relevar cómo la competencia resuelve las pantallas de operatoria para clientes (compra/venta, historial, estados de órdenes) y, en base a eso, diseñar el apartado de **Operaciones** de nuestra plataforma, atado a cualquier mercado (CEDEARs, acciones, bonos, ONs, FCIs, dólar MEP).

**Responsable:** Vicente
**Entrega:** documento de benchmark + wireframes/mockups de las pantallas propuestas.

---

## 1. Qué hay que investigar (benchmark de competencia)

Relevar pantalla por pantalla cómo cada broker resuelve la operatoria. Para cada uno, capturar screenshots (o grabar el flujo) y anotar qué hace bien y qué hace mal.

### Brokers locales (prioridad alta — son nuestra competencia directa)

| Broker | Qué mirar |
|---|---|
| **Cocos Capital** (cocos.capital) | Referente en UX mobile-first local. Flujo de compra en pocos pasos, claridad de precios. |
| **Balanz** | Plataforma completa: libro de órdenes, panel de cotizaciones, ticket de orden avanzado. |
| **IOL (InvertirOnline)** | El más usado. Ticket de compra/venta clásico, estados de órdenes, historial detallado. |
| **PPI (Portfolio Personal)** | Operatoria multi-instrumento, dólar MEP simplificado. |
| **Bull Market Brokers** | Panel para operadores más activos. |

### Internacionales (referencia de diseño)

- **Robinhood** — simplicidad extrema del flujo comprar/vender, confirmaciones claras.
- **eToro** — presentación de instrumentos y estados de posición.
- **Interactive Brokers (IBKR)** — ticket de orden profesional: tipos de orden, validez, previsualización de costos.

> Tip: si no se tiene cuenta en alguno, usar **Mobbin** (mobbin.com) o AppShots para ver las pantallas reales sin registrarse: [pantallas de Robinhood en Mobbin](https://mobbin.com/apps/robinhood-ios-fc10375f-48a8-4492-9787-448261f297e0/_/screens) y la [categoría Finance](https://mobbin.com/explore/mobile/app-categories/finance).

### Qué documentar de cada broker

1. **Flujo completo de compra** — desde que el cliente ve el instrumento hasta la confirmación: cuántos pasos, qué datos pide, cómo muestra precio/monto/comisiones.
2. **Flujo de venta** — diferencias con compra (tenencia disponible, venta parcial).
3. **Ticket de orden** — campos: cantidad vs. monto, tipo de orden (mercado/límite), plazo (CI/24hs), validez, previsualización del total con comisiones e impuestos.
4. **Confirmación y feedback** — pantalla de revisión previa, confirmación post-envío, estados (pendiente / parcialmente ejecutada / ejecutada / cancelada / rechazada).
5. **Historial de operaciones** — cómo listan órdenes y movimientos, filtros (fecha, instrumento, estado, mercado), detalle de cada operación, boletos/comprobantes descargables.
6. **Manejo de errores** — qué pasa si no hay saldo, mercado cerrado, precio fuera de banda.
7. **Multi-mercado / multi-moneda** — cómo diferencian BYMA vs. exterior, pesos vs. dólares (MEP/CCL), y cómo lo comunican al cliente.

---

## 2. Qué hay que diseñar (entregables)

Con el benchmark hecho, diseñar wireframes (baja fidelidad primero, luego mockups) de:

1. **Apartado "Operaciones"** — sección nueva de la app, agnóstica de mercado: el cliente elige instrumento de cualquier panel (CEDEARs, acciones, bonos, etc.) y llega al mismo flujo de operatoria.
2. **Pantalla de compra/venta (ticket de orden)** con:
   - Instrumento + precio en vivo (puntas compra/venta, último precio).
   - Toggle Comprar / Vender bien diferenciado (verde/rojo).
   - Cantidad **o** monto (calcular el otro automáticamente).
   - Tipo de orden: mercado / límite. Plazo: CI / 24hs.
   - Resumen previo a confirmar: total estimado, comisiones, mercado, moneda.
   - Confirmación en 2 pasos (revisar → confirmar) para evitar errores de dedo.
3. **Historial de operaciones**:
   - Lista de órdenes con estado visible de un vistazo (color + etiqueta).
   - Filtros: fecha, instrumento, tipo, estado, mercado.
   - Detalle de cada orden (precio de ejecución, cantidad ejecutada, comisiones, boleto).
4. **Estados y notificaciones** — cómo se entera el cliente de que su orden se ejecutó.

**Formato de entrega:** Figma o stitch + un doc breve por pantalla explicando las decisiones y qué se tomó de cada competidor. Respetar la estética existente de la app — ver `docs/ui-kit.md` (tipografías Geist/Manrope, paleta y componentes ya definidos).

---

## 3. Documentación y lecturas de apoyo

Leer antes de diseñar (todas gratuitas):

### Diseño de plataformas de trading
- [Trading App Design: guía completa de UI, UX y arquitectura (Lollypop, 2026)](https://lollypop.design/blog/2026/june/trading-app-design/) — la más completa; cubre ticket de orden, progressive disclosure y riesgo en la colocación de órdenes.
- [Trading Platform UX/UI: tendencias (Devexperts)](https://devexperts.com/blog/trading-platform-ux-ui-latest-trends/)
- [Errores comunes de UX/UI en plataformas de trading (Devexperts)](https://devexperts.com/blog/trading-platform-ux-ui-design-no-nos/) — qué NO hacer.
- [Rethinking UX/UI para trading online (Devexperts)](https://devexperts.com/blog/ux-ui-design-for-online-trading-platforms/)
- [Guía de UX para apps de trading (Medium)](https://medium.com/@markpascal4343/user-experience-design-for-trading-apps-a-comprehensive-guide-b29445203c71)
- [Caso: rediseño de TradingView (Ron Design Lab)](https://rondesignlab.com/cases/tradingview-platform-for-traders)
- [8 prácticas de diseño para plataformas de inversión (Ron Design Lab)](https://rondesignlab.com/blog/design-news/most-sucessful-practices-for-investment-platform-ui-ux)

### UX fintech en general (confianza, transacciones, historial)
- [Mastering Fintech UX — case study (Toptal)](https://www.toptal.com/designers/ux/mastering-fintech-ux-case-study)
- [Fintech UX: confianza, onboarding y diseño de transacciones (Lazarev)](https://www.lazarev.agency/articles/fintech-ux-case-study)
- [Tendencias de UX fintech con casos (Design Studio)](https://www.designstudiouiux.com/blog/fintech-ux-design-trends/)
- [Los trucos de UX de Robinhood (Medium/Bootcamp)](https://medium.com/design-bootcamp/ux-tricks-from-robinhood-app-c485d6fba7a8)
- [Dónde buscar inspiración de diseño fintech (Medium)](https://medium.com/@jayhan/best-places-to-get-fintech-design-and-ux-inspirations-d708b86d8880)

### Contexto de brokers argentinos (para entender qué valora el usuario local)
- [Balanz vs Cocos Capital (Rankia)](https://www.rankia.com.ar/blog/trading-argentina/6922032-balanz-vs-cocos-capital-cual-mejor-broker)
- [Cocos Capital vs IOL: plataforma y servicios (Rankia)](https://www.rankia.com.ar/blog/trading-argentina/6956458-cocos-capital-vs-iol-comisones-plataforma-servicios)
- [IOL vs Balanz 2026 (Rankia)](https://www.rankia.com.ar/blog/trading-argentina/6997064-iol-vs-balanz-que-broker-eligen-nuevos-inversores)
- [Review Cocos Capital (Awake Trader)](https://www.awaketrader.com/educacion/cocos-capital-review)

---

## 4. Principios que ya sabemos (no negociables)

Extraído de la bibliografía — aplicarlos en las propuestas:

1. **La colocación de una orden es la interacción de mayor riesgo** de toda la plataforma: inputs ambiguos o confirmaciones poco claras generan errores con plata real. Siempre: revisión previa + desglose de costos + confirmación explícita.
2. **Menos es más, con disclosure progresivo**: pantalla simple por defecto (comprar X por $Y), opciones avanzadas (límite, validez, plazo) accesibles pero no invasivas.
3. **Estados legibles de un vistazo**: color + etiqueta para cada estado de orden; el historial debe responder "¿qué pasó con mi plata?" sin clicks extra.
4. **Precio en vivo sin parpadeos**: el precio dentro del ticket debe actualizarse suave; lag o flickering rompen la confianza.
5. **Mobile y desktop desde el día uno**: diseñar ambos layouts, no adaptar a último momento.

---

## 5. Plan de trabajo sugerido

| Etapa | Tarea | Tiempo estimado |
|---|---|---|
| 1 | Leer bibliografía de la sección 3 | 1 día |
| 2 | Benchmark de brokers locales (screenshots + notas por flujo) | 2–3 días |
| 3 | Benchmark internacionales vía Mobbin | 1 día |
| 4 | Síntesis: matriz comparativa + decisiones de diseño | 1 día |
| 5 | Wireframes de las 4 pantallas (sección 2) | 2–3 días |
| 6 | Revisión conjunta y ajustes → mockups finales | 2 días |

**Al terminar cada etapa, compartir avance** — no esperar al final para mostrar todo junto.
