/**
 * Codemode's Playwright locators (locator.ts) on a real page: chains as data, Playwright's
 * strictness, reads, page code, and the guarantee that page code never runs while a secret the
 * app typed is on the page.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeTarget, type LocatorChain } from '../src/locator';
import { createTestService, page, refOf, startServer, type TestServer } from './helpers';

const OFFICES = page(
  `<h1>Cita previa</h1>
   <label>Oficina <select id=oficina>
     <option value="">Elige</option>
     <option value="mad-centro">Madrid Centro</option>
     <option value="mad-sur">Madrid Sur</option>
     <option value="sev">Sevilla Triana</option>
   </select></label>
   <table class=citas>
     <tr><td>12/11 09:10</td><td>Libre</td></tr>
     <tr><td>12/11 09:40</td><td>Ocupada</td></tr>
     <tr><td>13/11 10:30</td><td>Libre</td></tr>
   </table>
   <button>Enviar</button><button>Enviar más tarde</button>
   <form action="/hecho"><label>Contraseña <input type=password name=clave></label><button>Entrar</button></form>`,
  'Cita previa',
);

let server: TestServer;
let t: ReturnType<typeof createTestService>;
const id = 'locators';

beforeAll(async () => {
  server = await startServer({ '/citas': OFFICES, '/hecho': page('<p>Hecho</p>', 'Hecho') });
  t = createTestService();
  await t.service.open(id, `${server.origin}/citas`);
});

afterAll(async () => {
  await t?.cleanup();
  await server?.close();
});

const target = (chain: LocatorChain) => encodeTarget(chain);

describe('locator chains', () => {
  it('read structured data with Playwright locators, filters and page code', async () => {
    const free = target([
      ['locator', 'table.citas tr', null],
      ['filter', { hasText: 'Libre' }],
    ]);
    expect(await t.service.query(id, free, 'count')).toBe(2);
    expect(await t.service.query(id, free, 'allInnerTexts')).toEqual([
      '12/11 09:10\tLibre',
      '13/11 10:30\tLibre',
    ]);
    const options = await t.service.query(
      id,
      target([['getByLabel', 'Oficina', null]]),
      'evaluate',
      {
        fn: '(select) => Array.from(select.options).filter((o) => o.value).map((o) => ({ value: o.value, label: o.text }))',
      },
    );
    expect(options).toEqual([
      { value: 'mad-centro', label: 'Madrid Centro' },
      { value: 'mad-sur', label: 'Madrid Sur' },
      { value: 'sev', label: 'Sevilla Triana' },
    ]);
    expect(await t.service.query(id, '', 'evaluate', { fn: '() => document.title' })).toBe(
      'Cita previa',
    );
  });

  it('act through the same paths as refs, strict like Playwright', async () => {
    const office = target([['getByRole', 'combobox', { name: 'Oficina' }]]);
    await t.service.select(id, office, ['Madrid Sur']);
    expect(await t.service.query(id, office, 'inputValue')).toBe('mad-sur');
    // Two buttons match "Enviar" without exact: Playwright's strictness, in plain words.
    await expect(
      t.service.click(id, target([['getByRole', 'button', { name: 'Enviar' }]])),
    ).rejects.toThrow(/matches 2 elements: make it specific/);
    expect(
      await t.service.query(
        id,
        target([['getByRole', 'button', { name: 'Enviar', exact: true }]]),
        'count',
      ),
    ).toBe(1);
    // Refs from a snapshot work as before.
    const snapshot = await t.service.snapshot(id);
    expect(
      await t.service.query(id, refOf(snapshot.snapshot, 'heading "Cita previa"'), 'textContent'),
    ).toBe('Cita previa');
  });

  it('refuse unknown steps and say what matched nothing', async () => {
    await expect(t.service.query(id, 'loc:[["context"]]', 'count')).rejects.toThrow(
      /Unknown locator step "context"/,
    );
    await expect(
      t.service.click(id, target([['getByText', 'No existe', { exact: true }]])),
    ).rejects.toThrow(/matches no element/);
  });
});

describe('secrets typed by the app', () => {
  it('are never read back: page code waits until the page that holds them is gone', async () => {
    const password = target([['getByLabel', 'Contraseña', null]]);
    await t.service.type(id, password, 'clave-secreta-123', { secret: true });
    await expect(
      t.service.query(id, '', 'evaluate', {
        fn: '() => document.querySelector("input[type=password]").value',
      }),
    ).rejects.toThrow(/refused while a secret the app typed is on this page/);
    await expect(t.service.query(id, password, 'inputValue')).rejects.toThrow(/never read/);
    // A new document (the form is submitted): page code works again, and the secret is gone.
    await t.service.click(id, target([['getByRole', 'button', { name: 'Entrar' }]]));
    await t.service.wait(id, { text: 'Hecho' });
    const url = await t.service.query(id, '', 'evaluate', { fn: '() => location.href' });
    expect(url).not.toContain('clave-secreta-123');
    expect(String(url)).toContain('/hecho');
  });
});
