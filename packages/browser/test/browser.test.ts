import fs from 'node:fs';
import type { BrowserObservation } from '@sa/shared';
import { chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestService, page, refOf, sendHtml, startServer, type TestServer } from './helpers';

const PDF = (label: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${label}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );

const esc = (s: string | null | undefined) =>
  (s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

let a: TestServer;
let b: TestServer;
let t: ReturnType<typeof createTestService>;
let generated = 0;

beforeAll(async () => {
  // Second site (different host => cross-site, out-of-process iframe).
  b = await startServer(
    {
      '/frame': page(
        `<label>Nombre en iframe <input id=n></label>
         <button onclick="document.getElementById('o').textContent='Enviado: '+document.getElementById('n').value">Enviar iframe</button>
         <p id=o></p>`,
        'Marco',
      ),
    },
    { host: '127.0.0.1' },
  );
  a = await startServer({
    '/': page(
      `<h1>Sede de pruebas</h1>
       <a href="/form">Ir al formulario</a>
       <a href="/popup" target="_blank">Abrir ventana</a>
       <button onclick="window.open('/popup', 'pop', 'width=500,height=400')">Abrir popup</button>
       <iframe title="Marco externo" src="${b.origin}/frame" width=400 height=150></iframe>`,
      'Inicio',
    ),
    '/popup': page('<h1>Ventana emergente</h1><p>Contenido del popup</p>', 'Popup'),
    '/form': page(
      `<h1>Formulario</h1>
       <form action="/result" method="get">
         <label>Nombre <input name=nombre></label>
         <label>Contraseña <input name=clave type=password></label>
         <label>Provincia <select name=prov><option value="">Elige</option><option value="28">Madrid</option><option value="08">Barcelona</option><option value="01">Álava</option></select></label>
         <label><input type=checkbox name=acepto> Acepto las condiciones</label>
         <label>Código <input name=codigo onkeyup="document.getElementById('teclas').textContent='Teclas: '+this.value.length"></label>
         <p id=teclas></p>
         <button>Enviar</button>
       </form>
       <label>DNI <input id=dni></label> <button id=go disabled>Continuar</button>
       <script>dni.addEventListener('keyup', () => { go.disabled = dni.value.length !== 9; });</script>`,
      'Formulario',
    ),
    '/result': (req, res) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      sendHtml(
        res,
        page(
          `<h1>Resultado</h1><p>Hola, ${esc(q.get('nombre'))}</p><p>Provincia: ${esc(q.get('prov'))}</p>
           <p>Acepta: ${esc(q.get('acepto') ?? 'no')}</p><p>Clave recibida: ${esc(q.get('clave'))}</p>`,
          'Resultado',
        ),
      );
    },
    '/delayed': page(
      `<p id=s>Cargando datos</p><script>setTimeout(() => { document.getElementById('s').textContent = 'Listo'; }, 2500)</script>`,
    ),
    '/dialogs': page(
      `<button onclick="alert('Guardado correctamente')">Alerta</button>
       <button onclick="document.getElementById('r').textContent = confirm('¿Seguro?') ? 'confirmado' : 'cancelado'">Confirmar</button>
       <button onclick="document.getElementById('r').textContent = 'prompt: ' + prompt('Tu nombre')">Preguntar</button>
       <p id=r></p>`,
    ),
    '/leave': page(
      `<script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });</script>
       <input aria-label="Notas"><a href="/popup">Salir</a>`,
    ),
    '/echo-alert': page(
      `<script>alert('Tu clave: ' + new URL(location.href).searchParams.get('v'))</script><p>Hecho</p>`,
    ),
    '/prefilled': page('<label>Clave guardada <input type=password value="user-typed-pw"></label>'),
    '/downloads': page(
      `<a href="/file.pdf">Descargar justificante</a> <a href="/inline.pdf">Ver PDF</a>
       <a href="/con.pdf">Ver informe</a>
       <form method=post action="/gen.pdf"><button>Generar PDF</button></form>`,
    ),
    '/file.pdf': (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="justificante.pdf"',
      });
      res.end(PDF('adjunto'));
    },
    '/inline.pdf': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(PDF('en linea'));
    },
    // A name Windows reserves for a device.
    '/con.pdf': (_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-disposition': 'inline; filename="CON.pdf"',
      });
      res.end(PDF('reservado'));
    },
    '/gen.pdf': (req, res) => {
      generated++;
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-disposition': 'inline; filename="recibo-123.pdf"',
      });
      res.end(PDF(`generado ${generated} ${req.method}`));
    },
    '/upload': page(
      `<label for=f>Documento</label> <input type=file id=f multiple onchange="show(this)">
       <input type=file id=h style="display:none" onchange="show(this)">
       <button onclick="document.getElementById('h').click()">Adjuntar</button>
       <p id=out></p>
       <script>function show(i) { document.getElementById('out').textContent = Array.from(i.files).map((f) => f.name + ' (' + f.size + ' bytes)').join(', '); }</script>`,
    ),
    '/clave-error': page(
      '<h1>Error</h1><p>003002 - Authentication Failed (no se ha presentado ningún certificado)</p>',
      'Cl@ve',
    ),
    '/Sede/errores/erro4033.html': page('<h1>Error 403</h1>', 'Agencia Tributaria: 403'),
    '/captcha': page(
      '<img alt="captcha" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><label>Introduce los caracteres de la imagen <input></label>',
    ),
    '/state': (_req, res) =>
      sendHtml(res, page(`<script>localStorage.setItem('ls', 'hola')</script><p>ok</p>`), {
        'set-cookie': 'sid=abc123; Path=/',
      }),
    '/show-state': (req, res) =>
      sendHtml(
        res,
        page(
          `<p>Cookies: ${esc(req.headers.cookie)}</p><p id=ls></p>
           <script>document.getElementById('ls').textContent = 'LS: ' + localStorage.getItem('ls')</script>`,
        ),
      ),
  });
  t = createTestService();
});

afterAll(async () => {
  await t?.cleanup();
  await a?.close();
  await b?.close();
});

describe('snapshots and refs', () => {
  it('returns refs for the page and a cross-site iframe; actions work inside it', async () => {
    const obs = await t.service.open('snap', `${a.origin}/`);
    expect(obs.url).toBe(`${a.origin}/`);
    expect(obs.title).toBe('Inicio');
    expect(obs.truncated).toBe(false);
    expect(obs.snapshot).toContain('heading "Sede de pruebas" [level=1]');
    expect(obs.snapshot).toMatch(/- iframe \[ref=e\d+\]:/);
    expect(obs.tabs).toEqual([{ index: 0, url: `${a.origin}/`, title: 'Inicio', active: true }]);
    expect(obs.imageId, t.log.join('\n')).toMatch(/^img-/);
    expect(t.media.at(-1)?.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG

    const box = refOf(obs.snapshot, 'textbox "Nombre en iframe"');
    expect(box).toMatch(/^f\d+e\d+$/);
    let next = await t.service.type('snap', box, 'Juan');
    next = await t.service.click('snap', refOf(next.snapshot, 'button "Enviar iframe"'));
    expect(next.snapshot).toContain('Enviado: Juan');
  });

  it('explains stale and invalid refs', async () => {
    const obs = await t.service.open('stale', `${a.origin}/form`);
    const ref = refOf(obs.snapshot, 'button "Enviar"');
    await t.service.open('stale', `${a.origin}/popup`);
    await expect(t.service.click('stale', ref)).rejects.toMatchObject({
      code: 'stale_ref',
      message: `Ref ${ref} not found — take a new snapshot (the page may have changed) and use a ref from it.`,
    });
    await expect(t.service.click('stale', 'Enviar')).rejects.toMatchObject({ code: 'invalid_ref' });
    await expect(t.service.snapshot('nobody')).rejects.toMatchObject({ code: 'no_page' });
  });
});

describe('actions', () => {
  it('types, selects (by label, value or loosely), checks and submits a form', async () => {
    let obs = await t.service.open('form', `${a.origin}/form`);
    obs = await t.service.type('form', refOf(obs.snapshot, 'textbox "Nombre"'), 'María');
    const prov = () => refOf(obs.snapshot, 'combobox "Provincia"');
    obs = await t.service.select('form', prov(), ['Barcelona']);
    expect(obs.snapshot).toMatch(/option "Barcelona" \[selected\]/);
    obs = await t.service.select('form', prov(), ['alava']);
    expect(obs.snapshot).toMatch(/option "Álava" \[selected\]/);
    obs = await t.service.select('form', prov(), ['08']);
    await expect(t.service.select('form', prov(), ['Narnia'])).rejects.toMatchObject({
      code: 'bad_input',
      message: expect.stringContaining('"Madrid"'),
    });
    obs = await t.service.check(
      'form',
      refOf(obs.snapshot, 'checkbox "Acepto las condiciones"'),
      true,
    );
    expect(obs.snapshot).toMatch(/checkbox "Acepto las condiciones" \[checked\]/);
    obs = await t.service.click('form', refOf(obs.snapshot, 'button "Enviar"'));
    expect(new URL(obs.url).pathname).toBe('/result');
    expect(obs.snapshot).toContain('Hola, María');
    expect(obs.snapshot).toContain('Provincia: 08');
    expect(obs.snapshot).toContain('Acepta: on');
  });

  it('types key by key into picky inputs, submits with Enter, goes back and presses keys', async () => {
    let obs = await t.service.open('keys', `${a.origin}/form`);
    obs = await t.service.type('keys', refOf(obs.snapshot, 'textbox "Código"'), 'ABC');
    expect(obs.snapshot).toContain('Teclas: 3');
    // keyup validation attached with addEventListener (invisible to the heuristics)
    expect(obs.snapshot).toMatch(/button "Continuar" \[disabled\]/);
    obs = await t.service.type('keys', refOf(obs.snapshot, 'textbox "DNI"'), '12345678Z');
    expect(obs.snapshot).toMatch(/button "Continuar" \[ref=/);
    obs = await t.service.type('keys', refOf(obs.snapshot, 'textbox "Nombre"'), 'Pepe', {
      submit: true,
    });
    expect(obs.snapshot).toContain('Hola, Pepe');
    obs = await t.service.back('keys');
    expect(new URL(obs.url).pathname).toBe('/form');
    obs = await t.service.click('keys', refOf(obs.snapshot, 'textbox "Nombre"'));
    obs = await t.service.press('keys', 'Enter');
    expect(new URL(obs.url).pathname).toBe('/result');
    await expect(t.service.press('keys', 'NoSuchKey')).rejects.toMatchObject({ code: 'action' });
  });

  it('waits for text to appear or disappear', async () => {
    let obs = await t.service.open('wait', `${a.origin}/delayed`);
    expect(obs.snapshot).toContain('Cargando datos');
    obs = await t.service.wait('wait', { text: 'Listo' });
    expect(obs.snapshot).toContain('Listo');
    expect(obs.notes).toEqual([]);
    obs = await t.service.wait('wait', { textGone: 'Cargando datos' });
    expect(obs.notes).toEqual([]);
    obs = await t.service.wait('wait', { text: 'Nunca aparece', seconds: 1 });
    expect(obs.notes.join('\n')).toContain('"Nunca aparece" did not appear within 1 s');
  });

  it('uploads in-memory files to file inputs and through file choosers', async () => {
    let obs = await t.service.open('up', `${a.origin}/upload`);
    obs = await t.service.upload('up', refOf(obs.snapshot, /"Documento"/), [
      { name: 'dni.pdf', mimeType: 'application/pdf', buffer: Buffer.from('hello world') },
    ]);
    expect(obs.snapshot).toContain('dni.pdf (11 bytes)');
    obs = await t.service.upload('up', refOf(obs.snapshot, 'button "Adjuntar"'), [
      { name: 'foto.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(5) },
    ]);
    expect(obs.snapshot).toContain('foto.jpg (5 bytes)');
  });
});

describe('tabs, dialogs, downloads', () => {
  it('activates popups and lists, selects and closes tabs', async () => {
    let obs = await t.service.open('tabs', `${a.origin}/`);
    obs = await t.service.click('tabs', refOf(obs.snapshot, 'link "Abrir ventana"'));
    expect(obs.url).toBe(`${a.origin}/popup`);
    expect(obs.tabs.map((x) => x.active)).toEqual([false, true]);
    expect(t.service.currentUrl('tabs')).toBe(`${a.origin}/popup`);

    let tabs = await t.service.tabs('tabs', 'select', 0);
    expect(tabs.map((x) => x.active)).toEqual([true, false]);
    obs = await t.service.snapshot('tabs');
    expect(obs.url).toBe(`${a.origin}/`);
    obs = await t.service.click('tabs', refOf(obs.snapshot, 'button "Abrir popup"'));
    expect(obs.url).toBe(`${a.origin}/popup`);
    expect(obs.tabs).toHaveLength(3);

    tabs = await t.service.tabs('tabs', 'close', 2);
    expect(tabs).toHaveLength(2);
    expect(tabs.filter((x) => x.active)).toHaveLength(1);
    await expect(t.service.tabs('tabs', 'select', 7)).rejects.toMatchObject({ code: 'bad_input' });
    obs = await t.service.open('tabs', `${a.origin}/form`, { newTab: true });
    expect(obs.tabs).toHaveLength(3);
    expect(obs.tabs[2]).toMatchObject({ active: true, title: 'Formulario' });
  });

  it('observes a popup reported while the opener is being read (snapshot, refs and tabs agree)', async () => {
    let obs = await t.service.open('late-pop', `${a.origin}/`);
    // On a busy machine Playwright can report a popup after the settle, while the opener's
    // snapshot is being captured. Simulate exactly that: open it from inside the capture.
    const svc = t.service as unknown as { captureSnapshot(page: Page): Promise<unknown> };
    const capture = svc.captureSnapshot;
    let opened = false;
    svc.captureSnapshot = async function (this: unknown, page: Page) {
      if (!opened) {
        opened = true;
        const popup = page.context().waitForEvent('page');
        await page.evaluate(() => void window.open('/popup'));
        await popup;
      }
      return capture.call(this, page);
    };
    try {
      obs = await t.service.snapshot('late-pop');
    } finally {
      Reflect.deleteProperty(svc, 'captureSnapshot');
    }
    expect(opened).toBe(true);
    expect(obs.url).toBe(`${a.origin}/popup`);
    expect(obs.snapshot).toContain('Ventana emergente');
    expect(obs.tabs.map((x) => x.active)).toEqual([false, true]);
    // The refs belong to the active tab.
    obs = await t.service.click('late-pop', refOf(obs.snapshot, 'heading "Ventana emergente"'));
    expect(obs.url).toBe(`${a.origin}/popup`);
  });

  it('accepts alerts, confirms and beforeunload, dismisses prompts, and reports them', async () => {
    let obs = await t.service.open('dlg', `${a.origin}/dialogs`);
    obs = await t.service.click('dlg', refOf(obs.snapshot, 'button "Alerta"'));
    expect(obs.dialogs).toEqual(['alert "Guardado correctamente" → accepted']);
    obs = await t.service.click('dlg', refOf(obs.snapshot, 'button "Confirmar"'));
    expect(obs.dialogs).toEqual(['confirm "¿Seguro?" → accepted']);
    expect(obs.snapshot).toContain('confirmado');
    obs = await t.service.click('dlg', refOf(obs.snapshot, 'button "Preguntar"'));
    expect(obs.dialogs).toEqual(['prompt "Tu nombre" → dismissed']);
    expect(obs.snapshot).toContain('prompt: null');

    obs = await t.service.open('dlg', `${a.origin}/leave`);
    obs = await t.service.type('dlg', refOf(obs.snapshot, 'textbox "Notas"'), 'algo');
    obs = await t.service.click('dlg', refOf(obs.snapshot, 'link "Salir"'));
    expect(obs.url).toBe(`${a.origin}/popup`);
    expect(obs.dialogs).toContain('"Leave this page?" → accepted');
  });

  it('hands downloads to onDownload, deletes the staged file and reports them once', async () => {
    let obs = await t.service.open('dl', `${a.origin}/downloads`);
    const before = t.stored.length;
    obs = await t.service.click('dl', refOf(obs.snapshot, 'link "Descargar justificante"'));
    expect(obs.downloads).toEqual([
      { downloadId: expect.any(String), name: 'justificante.pdf', mimeType: 'application/pdf' },
    ]);
    const doc = t.stored[before];
    expect(doc?.data.toString('latin1')).toContain('adjunto');
    expect(fs.existsSync(doc!.stagedPath)).toBe(false);
    expect(fs.readdirSync(t.downloadsDir)).toEqual([]);
    obs = await t.service.snapshot('dl');
    expect(obs.downloads).toEqual([]);
  });

  it('captures PDFs shown inline by Chromium (GET and POST results) as downloads', async () => {
    let obs = await t.service.open('pdf', `${a.origin}/downloads`);
    obs = await t.service.click('pdf', refOf(obs.snapshot, 'link "Ver PDF"'));
    expect(obs.downloads).toEqual([
      { downloadId: expect.any(String), name: 'inline.pdf', mimeType: 'application/pdf' },
    ]);
    expect(obs.notes.join('\n')).toContain('was downloaded');
    const inline = t.stored.find((d) => d.procedureId === 'pdf' && d.name === 'inline.pdf');
    expect(inline?.data.toString('latin1')).toContain('en linea');

    obs = await t.service.back('pdf');
    obs = await t.service.click('pdf', refOf(obs.snapshot, 'button "Generar PDF"'));
    expect(obs.downloads.map((d) => d.name)).toEqual(['recibo-123.pdf']);
    const gen = t.stored.find((d) => d.name === 'recibo-123.pdf');
    expect(gen?.data.toString('latin1')).toContain('generado 1 POST');
    expect(generated).toBe(1); // captured from the response, not fetched again

    obs = await t.service.back('pdf');
    obs = await t.service.click('pdf', refOf(obs.snapshot, 'link "Ver informe"'));
    expect(obs.downloads.map((d) => d.name)).toEqual(['_CON.pdf']);
  });
});

describe('secrets and refs', () => {
  it('never reveals secrets typed by the app or values of password fields', async () => {
    const secret = 'S3cr3t pass!';
    const all: BrowserObservation[] = [];
    let obs = await t.service.open('sec', `${a.origin}/form`);
    const pw = refOf(obs.snapshot, 'textbox "Contraseña"');
    obs = await t.service.type('sec', pw, secret, { secret: true });
    all.push(obs);
    expect(obs.snapshot).toMatch(
      new RegExp(`textbox "Contraseña" (\\[active\\] )?\\[ref=${pw}\\]: ••••`),
    );

    // GET form: the password ends up in the URL and the page echoes it.
    obs = await t.service.click('sec', refOf(obs.snapshot, 'button "Enviar"'));
    all.push(obs);
    expect(obs.snapshot).toContain('Clave recibida: ••••');
    expect(obs.url).toContain('clave=••••');

    // A dialog echoing it.
    obs = await t.service.open('sec', `${a.origin}/echo-alert?v=${encodeURIComponent(secret)}`);
    all.push(obs);
    expect(obs.dialogs).toEqual(['alert "Tu clave: ••••" → accepted']);

    // A password the user typed (or the page prefilled) is never shown either.
    obs = await t.service.open('sec', `${a.origin}/prefilled`);
    all.push(obs);
    expect(obs.snapshot).toMatch(/textbox "Clave guardada" \[ref=(f\d+)?e\d+\]: ••••/);

    const err = await t.service.type('sec', 'e99999', secret, { secret: true }).catch((e) => e);
    const dump = JSON.stringify(all) + String(err?.message);
    for (const leaked of [
      secret,
      encodeURIComponent(secret),
      'S3cr3t+pass%21',
      'S3cr3t+pass!',
      'user-typed-pw',
    ]) {
      expect(dump).not.toContain(leaked);
    }
    const shot = await t.service.screenshot('sec');
    expect(shot.data.length).toBeGreaterThan(1000);
  });

  it('describes refs (role, name, input type, frame URL) and re-checks them before typing', async () => {
    let obs = await t.service.open('desc', `${a.origin}/form`);
    const pw = refOf(obs.snapshot, 'textbox "Contraseña"');
    const nombre = refOf(obs.snapshot, 'textbox "Nombre"');
    expect(await t.service.describeRef('desc', pw)).toEqual({
      role: 'textbox',
      name: 'Contraseña',
      inputType: 'password',
      frameUrl: `${a.origin}/form`,
    });
    expect(await t.service.describeRef('desc', nombre)).toMatchObject({ inputType: 'text' });
    expect(await t.service.describeRef('desc', refOf(obs.snapshot, 'button "Enviar"'))).toEqual({
      role: 'button',
      name: 'Enviar',
      frameUrl: `${a.origin}/form`,
    });
    expect(await t.service.describeRef('desc', 'e99999')).toBeNull();
    expect(await t.service.describeRef('desc', 'nonsense')).toBeNull();
    expect(await t.service.describeRef('nobody', 'e1')).toBeNull();

    await expect(
      t.service.type('desc', nombre, 'x', { secret: true, expect: { inputType: 'password' } }),
    ).rejects.toMatchObject({ code: 'expectation_failed' });
    await expect(
      t.service.type('desc', pw, 'x', {
        expect: { inputType: 'password', frameOrigin: 'https://evil.example' },
      }),
    ).rejects.toMatchObject({ code: 'expectation_failed' });
    obs = await t.service.type('desc', pw, 'ok-pass', {
      secret: true,
      expect: { inputType: 'password', frameOrigin: a.origin },
    });
    expect(obs.snapshot).toMatch(new RegExp(`\\[ref=${pw}\\]: ••••`));

    obs = await t.service.open('desc', `${a.origin}/`);
    expect(
      await t.service.describeRef('desc', refOf(obs.snapshot, 'textbox "Nombre en iframe"')),
    ).toMatchObject({ role: 'textbox', inputType: 'text', frameUrl: `${b.origin}/frame` });
  });
});

describe('notes, state and lifecycle', () => {
  it('adds notes for certificate error pages and CAPTCHAs', async () => {
    let obs = await t.service.open('notes', `${a.origin}/clave-error`);
    expect(obs.notes.join('\n')).toMatch(
      /no client certificate was presented.*browser_use_certificate/,
    );
    obs = await t.service.open('notes', `${a.origin}/Sede/errores/erro4033.html`);
    expect(obs.notes.join('\n')).toMatch(/Agencia Tributaria.*browser_use_certificate/);
    obs = await t.service.open('notes', `${a.origin}/captcha`);
    expect(obs.notes.join('\n')).toContain('CAPTCHA');
    obs = await t.service.open('notes', `${a.origin}/form`);
    expect(obs.notes).toEqual([]);
  });

  it('exports and imports storage state (before and after the context exists)', async () => {
    await t.service.open('st1', `${a.origin}/state`);
    const state = await t.service.exportState('st1');
    expect(JSON.parse(state ?? '{}').cookies.map((c: { name: string }) => c.name)).toContain('sid');
    expect(await t.service.exportState('nobody')).toBeNull();

    await t.service.importState('st2', state!);
    let obs = await t.service.open('st2', `${a.origin}/show-state`);
    expect(obs.snapshot).toContain('Cookies: sid=abc123');
    expect(obs.snapshot).toContain('LS: hola');

    await t.service.open('st3', `${a.origin}/popup`);
    await t.service.importState('st3', state!);
    obs = await t.service.open('st3', `${a.origin}/show-state`);
    expect(obs.snapshot).toContain('Cookies: sid=abc123');
    await expect(t.service.importState('st3', 'not json')).rejects.toMatchObject({
      code: 'bad_input',
    });
  });

  it('streams screencast frames of the active tab', async () => {
    await t.service.open('cast', `${a.origin}/`);
    const frames: number[] = [];
    const stop = await t.service.startScreencast(
      'cast',
      (f) => {
        frames.push(f.data.length);
      },
      { width: 640, height: 400, quality: 50 },
    );
    await t.service.open('cast', `${a.origin}/form`);
    await new Promise((r) => setTimeout(r, 300));
    await stop();
    expect(frames.length).toBeGreaterThan(0);
  });

  it('opens, reports, screenshots and closes procedure browsers', async () => {
    expect(t.service.isOpen('life')).toBe(false);
    await t.service.open('life', `${a.origin}/`);
    expect(t.service.isOpen('life')).toBe(true);
    expect(t.service.currentUrl('life')).toBe(`${a.origin}/`);
    await t.service.show('life');
    const shot = await t.service.screenshot('life', { fullPage: true });
    expect(shot.mimeType).toBe('image/jpeg');
    expect(shot.data.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    await t.service.close('life');
    expect(t.service.isOpen('life')).toBe(false);
    expect(t.service.currentUrl('life')).toBeUndefined();
    await expect(t.service.snapshot('life')).rejects.toMatchObject({ code: 'no_page' });
  });

  it('screenshots a page Chromium has no frame of yet, as in the first moments of a headed browser', async () => {
    // Chromium's answer then, at once instead of waiting for a frame: seen headed under xvfb on
    // the first page of a browser launched a moment ago (README.md, "Observations and actions").
    const noFrame =
      'page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot';
    let failing = 0;
    let error = noFrame;
    const launch = chromium.launch.bind(chromium);
    const spy = vi.spyOn(chromium, 'launch').mockImplementation(async (options) => {
      const browser = await launch(options);
      const newContext = browser.newContext.bind(browser);
      vi.spyOn(browser, 'newContext').mockImplementation(async (contextOptions) => {
        const context = await newContext(contextOptions);
        // Registered before the service's own listener, so before its first screenshot.
        context.on('page', (page) => {
          const screenshot = page.screenshot.bind(page);
          vi.spyOn(page, 'screenshot').mockImplementation(async (screenshotOptions) => {
            if (failing-- > 0) throw new Error(error);
            return screenshot(screenshotOptions);
          });
        });
        return context;
      });
      return browser;
    });
    const fx = createTestService({ mediaIntervalMs: 0 });
    try {
      failing = 3;
      const obs = await fx.service.open('noframe', `${a.origin}/popup`);
      expect(obs.imageId, fx.log.join('\n')).toMatch(/^img-/);
      expect(failing).toBe(-1);
      failing = 3;
      const shot = await fx.service.screenshot('noframe');
      expect(shot.data.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(failing).toBe(-1);
      // Any other failure is not retried: the UI goes without that screenshot.
      failing = 100;
      error = 'page.screenshot: Target crashed';
      const next = await fx.service.open('noframe', `${a.origin}/form`);
      expect(next.imageId).toBeUndefined();
      expect(failing).toBe(99);
      expect(fx.log.filter((line) => line.includes('ui screenshot failed'))).toEqual([
        expect.stringContaining('Target crashed'),
      ]);
    } finally {
      spy.mockRestore();
      await fx.cleanup();
    }
  });

  it('explains navigation errors and refuses non-http URLs', async () => {
    const closed = await startServer({});
    await closed.close(); // nothing listens on this port any more
    await expect(t.service.open('neterr', `${closed.origin}/`)).rejects.toMatchObject({
      code: 'navigation',
      message: expect.stringContaining('ERR_CONNECTION_REFUSED'),
    });
    await expect(t.service.open('neterr', 'file:///etc/passwd')).rejects.toMatchObject({
      code: 'bad_input',
    });
  });
});
