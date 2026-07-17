// pw-verify.mjs — script de verificación ad-hoc para Prompt 4 (NO es parte del
// proyecto, se borra al terminar). Corre contra el dev server ya levantado en
// http://localhost:4210. Cubre:
//   1) Comprar desde una fila de la tabla de Acciones en Home -> Ticket con
//      símbolo exacto, sin pasar por Ficha.
//   2) Comprar desde una card de Destacados en Home -> idem.
//   3) Panel (vista completa por instrumento) tiene botón Comprar por fila.
//   4) Home completo en mobile (375px) -> colapso a 1 columna, sin overflow-x roto.
import { chromium } from '@playwright/test';
import path from 'node:path';

const BASE = 'http://localhost:4210';
const OUT = 'd:\\BOSTON ASSET MANAGER\\cotizaciones-boston\\pw-out';

async function main() {
  const browser = await chromium.launch();
  const results = {};

  // ── 1) Comprar desde Acciones (Home) ──────────────────────────────────
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE, { waitUntil: 'load' });
    // Esperar a que la tabla de Acciones tenga filas reales.
    await page.waitForSelector('.op-acciones .op-buy-row-btn', { timeout: 30000 });
    const firstRow = page.locator('.op-acciones .op-table-wrap tbody tr').first();
    const symbol = await firstRow.locator('.opt-sym').innerText();
    await page.screenshot({ path: path.join(OUT, '1-home-acciones-before.png') });
    await firstRow.locator('.op-buy-row-btn').click();
    await page.waitForSelector('.op-ficha-id .fh-sym', { timeout: 10000 });
    const ticketSymbol = await page.locator('.op-ficha-id .fh-sym').innerText();
    const isTicket = await page.locator('.op-card.op-order').count();
    results.accionesComprar = { rowSymbol: symbol.trim(), ticketSymbol: ticketSymbol.trim(), onTicketForm: isTicket > 0 };
    await page.screenshot({ path: path.join(OUT, '1-home-acciones-ticket.png') });
    await page.close();
  }

  // ── 2) Comprar desde Destacados (Home) ────────────────────────────────
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('.op-destacados .op-mover .op-buy-row-btn', { timeout: 30000 });
    const firstMover = page.locator('.op-destacados .op-mover').first();
    const symbol = await firstMover.locator('.om-sym').innerText();
    await page.screenshot({ path: path.join(OUT, '2-home-destacados-before.png') });
    await firstMover.locator('.op-buy-row-btn').click();
    await page.waitForSelector('.op-ficha-id .fh-sym', { timeout: 10000 });
    const ticketSymbol = await page.locator('.op-ficha-id .fh-sym').innerText();
    const isTicket = await page.locator('.op-card.op-order').count();
    results.destacadosComprar = { rowSymbol: symbol.trim(), ticketSymbol: ticketSymbol.trim(), onTicketForm: isTicket > 0 };
    await page.screenshot({ path: path.join(OUT, '2-home-destacados-ticket.png') });
    await page.close();
  }

  // ── 2b) Click en fila de Destacados FUERA del botón Comprar -> Ficha ──
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('.op-destacados .op-mover', { timeout: 30000 });
    const firstMover = page.locator('.op-destacados .op-mover').first();
    const symbol = await firstMover.locator('.om-sym').innerText();
    await firstMover.locator('.om-sym').click(); // click fuera del botón
    await page.waitForSelector('.op-ficha-price', { timeout: 10000 });
    const fichaSymbol = await page.locator('.op-ficha-id .fh-sym').innerText();
    const isTicket = await page.locator('.op-card.op-order').count();
    results.destacadosFichaNav = { rowSymbol: symbol.trim(), fichaSymbol: fichaSymbol.trim(), onTicketForm: isTicket > 0 };
    await page.screenshot({ path: path.join(OUT, '2b-home-destacados-ficha-nav.png') });
    await page.close();
  }

  // ── 3) Panel — tabla completa por instrumento (pill Acciones) ─────────
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(BASE, { waitUntil: 'load' });
    // Esperar a que Home ya haya cargado datos reales (mismo cache que usa Panel)
    // antes de navegar a la pill, para no quedarnos en "Cargando cotizaciones…".
    await page.waitForSelector('.op-acciones .op-buy-row-btn', { timeout: 30000 });
    await page.locator('.op-pill').first().click(); // primera pill = Acciones
    await page.waitForSelector('.op-panel-title', { timeout: 10000 });
    await page.waitForSelector('.op-table-wrap tbody tr', { timeout: 15000 });
    const hasBuyBtn = await page.locator('.op-table-wrap .op-buy-row-btn').count();
    await page.screenshot({ path: path.join(OUT, '3-panel-acciones.png'), fullPage: true });
    // Test funcional: click en Comprar de una fila del Panel abre Ticket con símbolo correcto
    const firstRow = page.locator('.op-table-wrap tbody tr').first();
    let panelBuyResult = null;
    if (await firstRow.count() > 0) {
      const symbol = await firstRow.locator('.opt-sym').innerText();
      await firstRow.locator('.op-buy-row-btn').click();
      await page.waitForSelector('.op-ficha-id .fh-sym', { timeout: 10000 });
      const ticketSymbol = await page.locator('.op-ficha-id .fh-sym').innerText();
      panelBuyResult = { rowSymbol: symbol.trim(), ticketSymbol: ticketSymbol.trim() };
      await page.screenshot({ path: path.join(OUT, '3b-panel-comprar-ticket.png') });
    }
    results.panelTieneBotonComprar = hasBuyBtn > 0;
    results.panelBuyResult = panelBuyResult;
    await page.close();
  }

  // ── 4) Mobile — Home completo (375px) ─────────────────────────────────
  {
    const page = await browser.newPage({ viewport: { width: 375, height: 1400 } });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('.op-acciones .op-table-wrap', { timeout: 30000 });
    await page.waitForTimeout(500);
    // Chequeo de overflow horizontal roto en body/html
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    const accionesGridCols = await page.evaluate(() => {
      const el = document.querySelector('.op-acciones-grid');
      return el ? getComputedStyle(el).gridTemplateColumns : null;
    });
    results.mobile = { scrollWidth, clientWidth, accionesGridCols, horizontalOverflow: scrollWidth > clientWidth + 2 };
    // Diagnóstico fino: ¿la tabla de Acciones tiene overflow-x propio? ¿el
    // botón "Comprar" queda recortado/inaccesible sin scrollear la tabla?
    const tableWrapDiag = await page.evaluate(() => {
      const wrap = document.querySelector('.op-acciones .op-table-wrap');
      if (!wrap) return null;
      const table = wrap.querySelector('table');
      const btn = wrap.querySelector('.op-buy-row-btn');
      const wrapRect = wrap.getBoundingClientRect();
      const btnRect = btn ? btn.getBoundingClientRect() : null;
      return {
        wrapClientWidth: wrap.clientWidth,
        wrapScrollWidth: wrap.scrollWidth,
        tableScrollWidth: table ? table.scrollWidth : null,
        wrapHasOverflowX: wrap.scrollWidth > wrap.clientWidth,
        btnFullyVisible: btnRect ? (btnRect.right <= wrapRect.right + 0.5) : null,
        btnRect: btnRect ? { left: btnRect.left, right: btnRect.right } : null,
        wrapRect: { left: wrapRect.left, right: wrapRect.right },
      };
    });
    results.mobileTableDiag = tableWrapDiag;
    await page.screenshot({ path: path.join(OUT, '4-mobile-home-full.png'), fullPage: true });
    // Screenshot recortado sólo de la card Acciones para ver el detalle del botón.
    const accionesCard = page.locator('.op-acciones').first();
    await accionesCard.screenshot({ path: path.join(OUT, '4b-mobile-acciones-card.png') });
    await page.close();
  }

  await browser.close();
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
