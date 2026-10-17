/**
 * Placeholder imagery for the mock API: low-res "screenshots" of generic web pages and document
 * previews, drawn as SVG. Deliberately generic (no real logos or branding).
 */

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function toDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

type FakePageKind = 'login' | 'form' | 'list' | 'message' | 'download' | 'qr' | 'home';

export interface FakePageOptions {
  host: string;
  title: string;
  kind: FakePageKind;
  /** Header colour of the fake site. */
  color?: string;
  lines?: string[];
  button?: string;
  highlight?: string;
}

function qrPattern(x: number, y: number, size: number, seed = 7): string {
  const n = 25;
  const cell = size / n;
  let rnd = seed;
  const next = () => {
    rnd = (rnd * 9301 + 49297) % 233280;
    return rnd / 233280;
  };
  const parts: string[] = [];
  const finder = (fx: number, fy: number) => {
    parts.push(
      `<rect x="${x + fx * cell}" y="${y + fy * cell}" width="${cell * 7}" height="${cell * 7}" fill="#111"/>`,
      `<rect x="${x + (fx + 1) * cell}" y="${y + (fy + 1) * cell}" width="${cell * 5}" height="${cell * 5}" fill="#fff"/>`,
      `<rect x="${x + (fx + 2) * cell}" y="${y + (fy + 2) * cell}" width="${cell * 3}" height="${cell * 3}" fill="#111"/>`,
    );
  };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const inFinder = (i < 8 && j < 8) || (i < 8 && j > n - 9) || (i > n - 9 && j < 8);
      if (!inFinder && next() > 0.52) {
        parts.push(
          `<rect x="${(x + i * cell).toFixed(1)}" y="${(y + j * cell).toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" fill="#111"/>`,
        );
      }
    }
  }
  finder(0, 0);
  finder(n - 7, 0);
  finder(0, n - 7);
  return parts.join('');
}

export function fakePage(o: FakePageOptions): string {
  const W = 640;
  const H = 400;
  const color = o.color ?? '#3b5b7a';
  const body: string[] = [];
  const lines = o.lines ?? [];
  let y = 128;

  const text = (tx: number, ty: number, s: string, size = 12, fill = '#3d3d3d', weight = 400) =>
    `<text x="${tx}" y="${ty}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(s)}</text>`;

  switch (o.kind) {
    case 'login': {
      body.push(
        `<rect x="170" y="${y - 10}" width="300" height="230" rx="6" fill="#fff" stroke="#d9dde3"/>`,
      );
      body.push(text(190, y + 18, lines[0] ?? 'Identifícate', 15, '#222', 600));
      y += 40;
      for (const label of lines.slice(1, 3).length
        ? lines.slice(1, 3)
        : ['Usuario', 'Contraseña']) {
        body.push(text(190, y + 12, label, 11, '#555'));
        body.push(
          `<rect x="190" y="${y + 18}" width="260" height="28" rx="3" fill="#f7f8fa" stroke="#c9ced6"/>`,
        );
        y += 56;
      }
      body.push(`<rect x="190" y="${y + 6}" width="260" height="32" rx="4" fill="${color}"/>`);
      body.push(
        text(
          320 - (o.button ?? 'Acceder').length * 3.4,
          y + 27,
          o.button ?? 'Acceder',
          12,
          '#fff',
          600,
        ),
      );
      break;
    }
    case 'form': {
      for (const label of lines.length
        ? lines
        : ['Nombre', 'Apellidos', 'Dirección', 'Código postal']) {
        body.push(text(48, y, label, 11, '#555'));
        body.push(
          `<rect x="48" y="${y + 6}" width="300" height="26" rx="3" fill="#f7f8fa" stroke="#c9ced6"/>`,
        );
        y += 50;
      }
      body.push(`<rect x="48" y="${y}" width="150" height="32" rx="4" fill="${color}"/>`);
      body.push(text(62, y + 21, o.button ?? 'Continuar', 12, '#fff', 600));
      body.push(
        `<rect x="400" y="128" width="196" height="150" rx="6" fill="#f3f5f8" stroke="#dde2e8"/>`,
      );
      body.push(text(414, 152, 'Ayuda', 12, '#333', 600));
      for (let i = 0; i < 5; i++)
        body.push(
          `<rect x="414" y="${166 + i * 18}" width="${150 - (i % 2) * 40}" height="7" rx="3" fill="#d5dbe3"/>`,
        );
      break;
    }
    case 'list': {
      for (const [i, label] of (lines.length
        ? lines
        : ['Opción 1', 'Opción 2', 'Opción 3', 'Opción 4']
      ).entries()) {
        const hl = o.highlight && label === o.highlight;
        body.push(
          `<rect x="48" y="${y - 6}" width="544" height="40" rx="5" fill="${hl ? '#fff6e0' : '#fff'}" stroke="${hl ? '#e8b64c' : '#dde2e8'}"/>`,
        );
        body.push(
          `<circle cx="70" cy="${y + 14}" r="7" fill="none" stroke="${color}" stroke-width="2"/>`,
        );
        body.push(text(88, y + 18, label, 12, '#333', hl ? 600 : 400));
        body.push(text(540, y + 18, '›', 16, '#9aa3ad'));
        y += 50;
        if (i > 3) break;
      }
      break;
    }
    case 'message': {
      body.push(
        `<rect x="48" y="${y - 8}" width="544" height="96" rx="6" fill="#fff4f2" stroke="#efc2b9"/>`,
      );
      body.push(`<circle cx="78" cy="${y + 22}" r="12" fill="#d9614c"/>`);
      body.push(text(74, y + 27, '!', 14, '#fff', 700));
      body.push(text(104, y + 20, lines[0] ?? 'Aviso', 14, '#7a2b1e', 600));
      body.push(text(104, y + 42, lines[1] ?? '', 11, '#7a3b30'));
      body.push(text(104, y + 60, lines[2] ?? '', 11, '#7a3b30'));
      body.push(`<rect x="48" y="${y + 110}" width="120" height="32" rx="4" fill="${color}"/>`);
      body.push(text(66, y + 131, o.button ?? 'Volver', 12, '#fff', 600));
      break;
    }
    case 'download': {
      body.push(
        `<rect x="48" y="${y - 8}" width="544" height="150" rx="6" fill="#fff" stroke="#dde2e8"/>`,
      );
      body.push(
        `<rect x="70" y="${y + 12}" width="70" height="92" rx="4" fill="#f3f5f8" stroke="#c9ced6"/>`,
      );
      body.push(text(88, y + 64, 'PDF', 14, '#b44', 700));
      body.push(text(160, y + 30, lines[0] ?? 'Documento', 14, '#222', 600));
      body.push(text(160, y + 52, lines[1] ?? '', 11, '#555'));
      body.push(`<rect x="160" y="${y + 74}" width="150" height="32" rx="4" fill="${color}"/>`);
      body.push(text(178, y + 95, o.button ?? 'Descargar PDF', 12, '#fff', 600));
      break;
    }
    case 'qr': {
      body.push(
        `<rect x="200" y="${y - 12}" width="240" height="240" rx="8" fill="#fff" stroke="#dde2e8"/>`,
      );
      body.push(qrPattern(230, y + 18, 180));
      body.push(text(186, y + 252, lines[0] ?? 'Escanea el código con la app', 12, '#444'));
      break;
    }
    case 'home': {
      for (let i = 0; i < 3; i++) {
        body.push(
          `<rect x="${48 + i * 184}" y="${y - 6}" width="168" height="110" rx="6" fill="#fff" stroke="#dde2e8"/>`,
        );
        body.push(
          `<rect x="${64 + i * 184}" y="${y + 12}" width="28" height="28" rx="6" fill="${color}" opacity="0.18"/>`,
        );
        body.push(text(64 + i * 184, y + 64, lines[i] ?? 'Servicio', 12, '#222', 600));
        body.push(
          `<rect x="${64 + i * 184}" y="${y + 76}" width="120" height="7" rx="3" fill="#d5dbe3"/>`,
        );
      }
      body.push(`<rect x="48" y="${y + 130}" width="544" height="90" rx="6" fill="#f3f5f8"/>`);
      break;
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#eef1f4"/>
  <rect width="${W}" height="30" fill="#dfe3e8"/>
  <circle cx="16" cy="15" r="5" fill="#f26b5e"/><circle cx="32" cy="15" r="5" fill="#f5bd4f"/><circle cx="48" cy="15" r="5" fill="#5ec454"/>
  <rect x="72" y="7" width="420" height="16" rx="8" fill="#fff"/>
  ${text(84, 19, `https://${o.host}`, 10, '#556')}
  <rect y="30" width="${W}" height="44" fill="${color}"/>
  <rect x="24" y="42" width="20" height="20" rx="4" fill="#fff" opacity="0.85"/>
  ${text(54, 57, o.host.replace(/^www\./, ''), 13, '#fff', 600)}
  ${text(48, 104, o.title, 17, '#1f2933', 600)}
  ${body.join('\n  ')}
</svg>`;
  return toDataUrl(svg);
}

/** A stylized photo of the back of an ID card (no real data). */
export function fakeIdCardBack(): string {
  const mrz = [
    'IDESPCAA123456<12345678Z<<<<<<',
    '9103087F2611146ESP<<<<<<<<<<<6',
    'MARTIN<ORTEGA<<LUCIA<<<<<<<<<<',
  ];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d9d4cb"/><stop offset="1" stop-color="#bfb8ad"/></linearGradient>
  <linearGradient id="c" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9eef0"/><stop offset="0.5" stop-color="#dfe8e6"/><stop offset="1" stop-color="#e8e2ea"/></linearGradient></defs>
  <rect width="640" height="420" fill="url(#g)"/>
  <g transform="translate(70 50) rotate(-1.5)">
    <rect width="500" height="315" rx="22" fill="url(#c)" stroke="#b9c3c4"/>
    <rect x="28" y="28" width="150" height="10" rx="5" fill="#b8c4cc"/>
    <rect x="28" y="48" width="220" height="8" rx="4" fill="#c9d2d8"/>
    <rect x="28" y="64" width="180" height="8" rx="4" fill="#c9d2d8"/>
    <rect x="360" y="24" width="110" height="80" rx="10" fill="#d7c48a" opacity="0.7"/>
    <rect x="22" y="196" width="456" height="98" rx="6" fill="#f5f7f6" opacity="0.8"/>
    ${mrz.map((l, i) => `<text x="34" y="${226 + i * 28}" font-family="OCR-B, 'Courier New', monospace" font-size="21" letter-spacing="1.2" fill="#2b2b2b">${esc(l)}</text>`).join('')}
  </g>
</svg>`;
  return toDataUrl(svg);
}

/** A stylized first page of a PDF document. */
export function fakeDocumentPage(title: string, subtitle = ''): string {
  const rows = Array.from({ length: 14 }, (_, i) => i);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="620" viewBox="0 0 480 620">
  <rect width="480" height="620" fill="#fff"/>
  <rect x="40" y="40" width="64" height="64" rx="8" fill="#e9ecef"/>
  <text x="124" y="66" font-family="Helvetica, Arial, sans-serif" font-size="18" font-weight="700" fill="#222">${esc(title)}</text>
  <text x="124" y="90" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="#666">${esc(subtitle)}</text>
  <rect x="40" y="130" width="400" height="1" fill="#ddd"/>
  ${rows.map((i) => `<rect x="40" y="${156 + i * 26}" width="${i % 4 === 3 ? 240 : 400 - (i % 3) * 30}" height="9" rx="4" fill="#e3e6ea"/>`).join('')}
  <rect x="300" y="540" width="140" height="40" rx="4" fill="none" stroke="#c7ccd2" stroke-dasharray="4 3"/>
</svg>`;
  return toDataUrl(svg);
}

/** A stylized passport-style photo. */
export function fakePortrait(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="320" viewBox="0 0 260 320">
  <rect width="260" height="320" fill="#f4f4f2"/>
  <circle cx="130" cy="128" r="58" fill="#c9a58b"/>
  <path d="M60 320c6-70 40-104 70-104s64 34 70 104z" fill="#5a6b7c"/>
  <path d="M72 120c0-46 26-72 58-72s58 26 58 72c-10-24-30-36-58-36s-48 12-58 36z" fill="#3a2d26"/>
</svg>`;
  return toDataUrl(svg);
}
