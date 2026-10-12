import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderSnapshot } from '../src/snapshot';

/**
 * Checks the renderer against Playwright itself: for real pages, rendering
 * ariaSnapshotJSON({mode:'ai'}) must give exactly page.ariaSnapshot({mode:'ai'}).
 */
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser?.close();
});

const RICH_PAGE = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Rica</title></head><body>
<header><a href="/">Inicio</a><nav aria-label="Principal"><ul><li><a href="/a?x=1&y=2">Trámites: listado</a></li><li><a href="#b" aria-current="page">Sede # 2</a></li></ul></nav></header>
<main>
  <h1>Solicitud - "cita previa"</h1>
  <h2 id=h2>Datos: personales</h2>
  <p>Texto con: dos puntos, 'comillas' y "dobles". También yes/no: no</p>
  <p>   espacios   </p>
  <form>
    <label>DNI <input value="12345678Z" placeholder="00000000T"></label>
    <label>Notas <textarea>línea 1
línea 2</textarea></label>
    <label>Fecha <input type=date value="2026-10-03"></label>
    <label><input type=checkbox checked> Acepto</label>
    <label><input type=radio name=r> Opción A</label>
    <input type=checkbox aria-checked="mixed" role=checkbox aria-label="Mixto">
    <button disabled>Desactivado</button>
    <button aria-pressed="true">Pulsado</button>
    <button aria-expanded="true">Expandido</button>
    <select aria-label="Provincia"><option>Madrid</option><option selected>Álava</option></select>
    <input aria-invalid="true" aria-label="Inválido" value="x">
  </form>
  <table><tr><th>Nombre</th><th>Estado</th></tr><tr><td>Expediente 1</td><td>En trámite</td></tr></table>
  <ul><li>- empieza con guion</li><li>42</li><li>[corchete]</li><li>true</li></ul>
  <div role=alert>Error: campo obligatorio</div>
  <img alt="Escudo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
  <iframe title="marco" srcdoc="<p>Dentro del marco</p><button>Botón del marco</button><a href='https://example.org'>Fuera</a>"></iframe>
  <div style="cursor:pointer" onclick="1">Clicable</div>
  <span aria-hidden="true">oculto aria</span>
</main>
<footer><p>© 2026 Sede</p></footer>
</body></html>`;

describe('renderer parity with Playwright', () => {
  it('renders exactly like page.ariaSnapshot({ mode: "ai" })', async () => {
    await page.setContent(RICH_PAGE);
    await page.locator('iframe').contentFrame().locator('button').waitFor();
    await page.getByLabel('DNI').focus();
    const expected = await page.ariaSnapshot({ mode: 'ai' });
    const json = await page.ariaSnapshotJSON({ mode: 'ai' });
    const rendered = renderSnapshot(json, { budget: 1_000_000 });
    expect(rendered.text).toBe(expected);
    expect(expected).toContain('Botón del marco'); // iframe content included
  });

  it('keeps refs resolvable after rendering from JSON', async () => {
    await page.setContent(RICH_PAGE);
    const json = await page.ariaSnapshotJSON({ mode: 'ai' });
    const rendered = renderSnapshot(json, { budget: 1_000_000 });
    const ref = /button "Botón del marco" \[ref=(f\d+e\d+)\]/.exec(rendered.text)?.[1];
    expect(ref).toBeDefined();
    expect(await page.locator(`aria-ref=${ref}`).count()).toBe(1);
  });

  it('truncates a real, large page within budget keeping the form', async () => {
    const links = Array.from(
      { length: 300 },
      (_, i) => `<li><a href="/m/${i}">Menú ${i}</a></li>`,
    ).join('');
    const text = Array.from(
      { length: 120 },
      (_, i) => `<p>Párrafo ${i}: información general sobre el trámite y sus requisitos.</p>`,
    ).join('');
    const options = Array.from({ length: 250 }, (_, i) => `<option>País ${i}</option>`).join('');
    await page.setContent(`<!doctype html><meta charset=utf-8>
      <div id=cookies role=dialog aria-label="Cookies"><p>Usamos cookies técnicas y analíticas.</p><button>Aceptar todas</button><button>Rechazar</button></div>
      <nav><ul>${links}</ul></nav>
      <main><h1>Cita previa</h1>${text}
        <form><label>NIE <input></label><label>País <select>${options}</select></label><button>Siguiente</button></form>
      </main>
      <footer><ul>${links}</ul></footer>`);
    const json = await page.ariaSnapshotJSON({ mode: 'ai' });
    const full = renderSnapshot(json, { budget: 1_000_000 });
    expect(full.text.length).toBeGreaterThan(30_000);
    const r = renderSnapshot(json, { budget: 6_000 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(6_000);
    for (const kept of [
      'heading "Cita previa"',
      'textbox "NIE"',
      'combobox "País"',
      'button "Siguiente"',
      'button "Aceptar todas"',
      'button "Rechazar"',
    ]) {
      expect(r.text).toContain(kept);
    }
    expect(r.text).not.toContain('Menú 250');
    // Every ref still resolves in the page.
    for (const m of r.text.matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)) {
      expect(await page.locator(`aria-ref=${m[1]}`).count()).toBe(1);
    }
  });
});
