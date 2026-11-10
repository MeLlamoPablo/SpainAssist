// The phone screens of the Play listing (docs/play-listing.md, "Graphics"), rendered from the DNI
// video with nothing government-branded on them: a rental contract instead of the tax return, a
// generic "Sede electrónica" chip instead of a sede's domain, and neither Cl@ve nor the FNMT in
// the window behind the QR. The video itself is unchanged.
//
//   node marketing/play-screens.mjs                       # → marketing/dni-video/out/play/
//   node marketing/play-screens.mjs --entrar es.png,en.png
//
// --entrar takes the emulator captures of `entrar-revisar` (Spanish, English) and repaints their
// site chip the same way. Needs the Chromium that apps/desktop's playwright-core expects.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const { chromium } = createRequire(join(repo, 'apps/desktop/package.json'))('playwright-core');

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: join(here, 'dni-video/out/play') },
    entrar: { type: 'string' },
  },
});

/** The video's frames: the scanner before it finds the code, and the document to sign. */
const STILLS = [
  ['inicio', 6.85],
  ['revisar', 10.5],
];

const LISTING = {
  es: {
    chip: 'Sede electrónica',
    file: 'Contrato_Alquiler.pdf',
    contract: {
      title: 'Contrato de alquiler de vivienda',
      place: 'En Madrid, a 3 de noviembre de 2026',
      parties: 'Reunidos',
      landlord: ['Arrendador', 'JAVIER SOTO LÓPEZ'],
      tenant: ['Arrendataria', 'LUCÍA MARTÍN ORTEGA'],
      terms: 'Condiciones',
      rows: [
        ['Vivienda', 'Calle de los Olivos 8, 2.º A'],
        ['Duración', '12 meses'],
        ['Renta mensual', '950,00 €'],
        ['Fianza', '950,00 €'],
        ['Fecha de inicio', '1 de diciembre de 2026'],
      ],
    },
    text: {},
  },
  en: {
    chip: 'E-government site',
    file: 'Rental_Agreement.pdf',
    contract: {
      title: 'Residential rental agreement',
      place: 'Madrid, 3 November 2026',
      parties: 'Parties',
      landlord: ['Landlord', 'JAVIER SOTO LÓPEZ'],
      tenant: ['Tenant', 'LUCÍA MARTÍN ORTEGA'],
      terms: 'Terms',
      rows: [
        ['Property', 'Calle de los Olivos 8, 2.º A'],
        ['Term', '12 months'],
        ['Monthly rent', '€950.00'],
        ['Deposit', '€950.00'],
        ['Start date', '1 December 2026'],
      ],
    },
    // The phone app's strings (composeResources/values-en) and the desktop's (features/*/i18n.ts).
    text: {
      'Apunta al código del ordenador': 'Point at the code on your computer',
      Cancelar: 'Cancel',
      'Firmar documento': 'Sign document',
      'Firmar con mi DNI': 'Sign with my DNI',
      'No firmar': 'Don’t sign',
      'Mis trámites': 'My procedures',
      'Mis datos': 'My data',
      Ajustes: 'Settings',
      'Tus datos solo se almacenan cifrados en este dispositivo.':
        'Your data is only stored, encrypted, on this device.',
      'El asistente nunca ve tus contraseñas.': 'The assistant never sees your passwords.',
      'La IA solo recibe los datos relevantes para tus trámites.':
        'The AI only gets the data relevant to your procedures.',
      'Datos personales': 'Personal data',
      Documentos: 'Documents',
      Credenciales: 'Credentials',
      'Delega en el asistente el acceso a las webs oficiales.':
        'Let the assistant sign in to official websites for you.',
      'DNI con el móvil': 'DNI with your phone',
      'Acceso anticipado': 'Early access',
      'Firma con tu DNI con la app Spain Assist del móvil.':
        'Sign with your DNI with the Spain Assist app on your phone.',
      Probar: 'Try it',
      'Aún no se ha usado': 'Not used yet',
      'PIN del DNI': 'DNI PIN',
      'Guardar PIN': 'Save PIN',
      'Ningún móvil vinculado': 'No phone paired',
      'Móvil vinculado: Pixel 11': 'Paired phone: Pixel 11',
      'Vincular el móvil': 'Pair your phone',
      Desvincular: 'Unpair',
      'Certificado digital': 'Digital certificate',
      Titular: 'Holder',
      'Válido hasta': 'Valid until',
      '20 de octubre de 2030': '20 October 2030',
      'Cuándo usarla': 'When to use it',
      'Te pido permiso cada vez, con Touch ID.':
        'I ask for your permission every time, with Touch ID.',
      'Usar automáticamente': 'Use automatically',
      'Preguntar antes': 'Ask first',
      'Vincular aplicación de Android': 'Pair Android app',
      'Escanea este código con el móvil': 'Scan this code with your phone',
    },
  },
};

/** Runs in the page before scene.ready(), which copies the window into the viewfinder. */
function prepare({ chip, file, contract: c, text }) {
  // The credentials behind the QR: neither Cl@ve card, nor the certificate's FNMT kind and issuer.
  for (const card of document.querySelectorAll('.creds > .cred')) {
    if (card.querySelector('.cred-title')?.textContent.includes('Cl@ve')) card.remove();
  }
  document.querySelector('.cred-kind')?.remove();
  for (const row of document.querySelectorAll('.meta > div')) {
    if (row.querySelector('dt')?.textContent === 'Emitido por') row.remove();
  }

  const site = document.querySelector('#s-review .site');
  site.lastChild.textContent = chip;
  const page = document.querySelector('#s-review .page');
  const row = ([label, value]) => `<p class="c-row"><span>${label}</span><b>${value}</b></p>`;
  page.innerHTML = `
    <style>
      .c-title { padding-bottom: 5px; border-bottom: 1.2px solid #1f1f1f; text-align: center;
        font-size: 7.6px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
      .c-place { margin: 4px 0 2px; text-align: right; font-size: 6px; color: #555; }
      .page .pdf-ids span:last-child { flex: 1; }
      .c-row { display: flex; gap: 6px; padding: 2.4px 0; border-bottom: 0.6px solid #d6d6d6; }
      .c-row span { flex: 1; color: #555; }
      .c-row b { font-weight: 600; }
    </style>
    <p class="c-title">${c.title}</p>
    <p class="c-place">${c.place}</p>
    <p class="pdf-sec">${c.parties}</p>
    <div class="pdf-ids">
      <span><small>${c.landlord[0]}</small>${c.landlord[1]}</span>
      <span><small>${c.tenant[0]}</small>${c.tenant[1]}</span>
    </div>
    <p class="pdf-sec">${c.terms}</p>
    ${c.rows.map(row).join('')}`;
  document.querySelector('#s-review .fade b').textContent = file;
  document.querySelector('#s-review .fade span').textContent = '186.2 KB';

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let translated = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const en = text[node.textContent.trim()];
    if (en) node.textContent = en;
    translated ||= Boolean(en);
  }
  // The English scanner title takes two lines, as in the app, whose viewfinder makes room for it.
  if (translated) {
    document.querySelector('#s-scan .m-title').classList.remove('one');
    document.getElementById('vf').style.bottom = '264px';
  }
}

/**
 * The phone's screen alone, upright, without the punch-hole or rounded corners. The scanner pulls
 * back so the whole dialog fits in the viewfinder, centred, with the corners around the code.
 */
function flatten(name) {
  document.getElementById('phone').style.transform = 'none';
  document.getElementById('phone').style.filter = 'none';
  document.querySelector('.punch').style.display = 'none';
  document.getElementById('screen').style.borderRadius = '0';
  if (name !== 'inicio') return;

  const vf = document.getElementById('vf');
  const feed = document.getElementById('feed');
  const box = vf.getBoundingClientRect();
  const unit = box.width / vf.offsetWidth; // viewport px per dp
  const local = (r) => ({
    x: (r.left + r.width / 2 - box.left) / unit,
    y: (r.top + r.height / 2 - box.top) / unit,
    w: r.width / unit,
  });
  const dialog = local(feed.querySelector('#dialog').getBoundingClientRect());
  const [, ox, oy, f] = feed.style.transform
    .match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/)
    .map(Number);
  // The window (1280×820) still fills the viewfinder.
  const s = Math.max((0.9 * vf.offsetWidth) / dialog.w, (vf.offsetHeight + 4) / (820 * f));
  const clamp = (v, size, room) => Math.min(Math.max(v, room - size * f * s), 0);
  const x = clamp(vf.offsetWidth / 2 + s * (ox - dialog.x), 1280, vf.offsetWidth);
  const y = clamp(vf.offsetHeight / 2 + s * (oy - dialog.y), 820, vf.offsetHeight);
  feed.style.transform = `translate(${x}px, ${y}px) scale(${f * s})`;
  // Out of focus behind the dialog, as the camera sees it.
  for (const pane of feed.querySelectorAll('#side, #main')) pane.style.filter = 'blur(5px)';

  const qr = local(feed.querySelector('.qr').getBoundingClientRect());
  const size = qr.w + 26;
  Object.assign(document.getElementById('brackets').style, {
    left: `${qr.x - size / 2}px`,
    top: `${qr.y - size / 2}px`,
    width: `${size}px`,
    height: `${size}px`,
  });
}

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
};
const server = createServer((req, res) => {
  const path = normalize(join(repo, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!path.startsWith(repo) || !statSync(path, { throwIfNoEntry: false })?.isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${server.address().port}/marketing/dni-video/index.html`;

mkdirSync(args.out, { recursive: true });
const browser = await chromium.launch();

for (const [lang, listing] of Object.entries(LISTING)) {
  // 3×: the screen (396×880 CSS px) comes out at 1188×2640.
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 3,
  });
  page.on('pageerror', (e) => console.error(e));
  await page.goto(url);
  await page.waitForFunction(() => window.scene);
  await page.evaluate(prepare, listing);
  await page.evaluate(() => window.scene.ready());
  for (const [name, t] of STILLS) {
    await page.evaluate((s) => window.scene.seek(s), t);
    await page.evaluate(flatten, name);
    const file = join(args.out, `${lang}-${name}.png`);
    await page.locator('#screen').screenshot({ path: file });
    console.log(file);
  }

  await page.close();

  const capture = args.entrar?.split(',')[lang === 'es' ? 0 : 1];
  if (capture) {
    const file = join(args.out, `${lang}-entrar-revisar.png`);
    writeFileSync(file, await repaintChip(capture, listing.chip));
    console.log(file);
  }
}

/**
 * The login screen: an emulator capture (1080×2400, 420 dpi, so 1 dp = 2.625 px) whose site chip
 * (FirmaApp.kt, `Site`) gets new text. The chip keeps its own pixels: its left end with the lock,
 * a slice of its middle stretched under the text, and its right end.
 */
async function repaintChip(capture, text) {
  const page = await browser.newPage();
  await page.goto(url);
  const png = await page.evaluate(
    async ({ src, text }) => {
      const face = new FontFace(
        'Inter SemiBold',
        'url(/apps/mobile/shared/src/commonMain/composeResources/font/inter_semibold.ttf)',
      );
      document.fonts.add(await face.load());
      const img = new Image();
      img.src = src;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const white = (x, y) =>
        g
          .getImageData(x, y, 1, 1)
          .data.slice(0, 3)
          .every((v) => v > 250);

      // The chip starts 24 dp from the left and around y = 1669 (below "Entrar en"); find its
      // edges from the gap between the lock and the text.
      const x0 = 63;
      const mid = 1669;
      let y0 = mid;
      while (!white(x0 + 90, y0 - 1)) y0--;
      let y1 = mid;
      while (!white(x0 + 90, y1 + 1)) y1++;
      let x1 = img.width - 1;
      while (white(x1, mid)) x1--;
      const h = y1 - y0 + 1;

      // Its padding is 12 dp, then an 18 dp lock and 8 dp, the text (17 sp, which Compose sets a
      // hair tighter than Chromium), then 14 dp.
      const textX = x0 + (12 + 18 + 8) * 2.625;
      g.font = '44.625px "Inter SemiBold"';
      g.letterSpacing = '-0.35px';
      const x2 = Math.round(textX + g.measureText(text).width + 14 * 2.625);
      const left = 96;
      const end = 35;
      g.fillStyle = '#fff';
      g.fillRect(x0 - 2, y0 - 2, x1 - x0 + 5, h + 4);
      g.drawImage(img, x0, y0, left, h, x0, y0, left, h);
      g.drawImage(img, x0 + left - 1, y0, 1, h, x0 + left, y0, x2 - end - x0 - left + 1, h);
      g.drawImage(img, x1 - end + 1, y0, end, h, x2 - end + 1, y0, end, h);
      g.fillStyle = '#28211d';
      g.fillText(text, textX, y0 + 72.5);
      return canvas.toDataURL('image/png').split(',')[1];
    },
    { src: `data:image/png;base64,${readFileSync(capture).toString('base64')}`, text },
  );
  await page.close();
  return Buffer.from(png, 'base64');
}

await browser.close();
server.close();
