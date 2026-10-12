import { describe, expect, it } from 'vitest';
import { secretVariants } from '../src/errors';
import { type AriaJsonNode, renderSnapshot } from '../src/snapshot';

const BIG = 1_000_000;

// Shape produced by page.ariaSnapshotJSON({ mode: 'ai' }) (captured from Playwright 1.63).
const SAMPLE: AriaJsonNode[] = [
  {
    role: 'generic',
    active: true,
    ref: 'e1',
    children: [
      { role: 'heading', name: 'Hola', level: 1, ref: 'e2' },
      {
        role: 'generic',
        ref: 'e3',
        children: ['Usuario', { role: 'textbox', name: 'Usuario', ref: 'e4', text: 'pepe' }],
      },
      {
        role: 'combobox',
        ref: 'e7',
        children: [
          { role: 'option', name: 'Alfa' },
          { role: 'option', name: 'Beta', selected: true },
        ],
      },
      {
        role: 'navigation',
        ref: 'e8',
        children: [
          {
            role: 'list',
            ref: 'e9',
            children: [
              {
                role: 'listitem',
                ref: 'e10',
                children: [{ role: 'link', name: 'Uno', ref: 'e11', cursor: 'pointer', url: '/x' }],
              },
            ],
          },
        ],
      },
      {
        role: 'iframe',
        ref: 'e14',
        children: [
          {
            role: 'generic',
            ref: 'f1e1',
            children: [
              { role: 'textbox', name: 'Nombre', ref: 'f1e3' },
              { role: 'button', name: 'Enviar', ref: 'f1e4' },
            ],
          },
        ],
      },
    ],
  },
];

const SAMPLE_YAML = `- generic [active] [ref=e1]:
  - heading "Hola" [level=1] [ref=e2]
  - generic [ref=e3]:
    - text: Usuario
    - textbox "Usuario" [ref=e4]: pepe
  - combobox [ref=e7]:
    - option "Alfa"
    - option "Beta" [selected]
  - navigation [ref=e8]:
    - list [ref=e9]:
      - listitem [ref=e10]:
        - link "Uno" [ref=e11] [cursor=pointer]:
          - /url: /x
  - iframe [ref=e14]:
    - generic [ref=f1e1]:
      - textbox "Nombre" [ref=f1e3]
      - button "Enviar" [ref=f1e4]`;

describe('renderSnapshot', () => {
  it('renders the same YAML as Playwright when within budget', () => {
    const r = renderSnapshot(SAMPLE, { budget: BIG });
    expect(r.text).toBe(SAMPLE_YAML);
    expect(r.truncated).toBe(false);
    expect(r.refs.get('e4')).toEqual({ role: 'textbox', name: 'Usuario' });
    expect(r.refs.get('f1e4')).toEqual({ role: 'button', name: 'Enviar' });
    expect(r.fullText).toContain('Usuario');
  });

  it('quotes YAML values like Playwright', () => {
    const r = renderSnapshot(
      [
        { role: 'paragraph', ref: 'e1', text: 'Plazo: 10 días' },
        { role: 'text', text: '- guion inicial' },
        { role: 'textbox', name: 'Edad', ref: 'e2', text: '42' },
      ],
      { budget: BIG },
    );
    expect(r.text).toBe(
      [
        '- paragraph [ref=e1]: "Plazo: 10 días"',
        '- text: "- guion inicial"',
        '- textbox "Edad" [ref=e2]: "42"',
      ].join('\n'),
    );
  });

  it('masks secrets everywhere and password values in text fields', () => {
    const secret = 'S3cr3t pass';
    const json: AriaJsonNode[] = [
      { role: 'textbox', name: 'Contraseña', ref: 'e1', text: secret },
      { role: 'paragraph', ref: 'e2', text: `Tu clave es ${secret}.` },
      { role: 'link', name: 'Volver', ref: 'e3', url: `/r?p=${encodeURIComponent(secret)}` },
      // a value typed by the user in a password field (not by the app)
      { role: 'textbox', name: 'Clave', ref: 'e4', text: 'user-typed-123' },
      // the user is still typing: snapshot saw a prefix of the final value
      { role: 'textbox', name: 'PIN', ref: 'e5', text: '98' },
      { role: 'textbox', name: 'Nombre', ref: 'e6', text: 'Ana' },
    ];
    const r = renderSnapshot(json, {
      budget: BIG,
      secrets: secretVariants(secret),
      passwordValues: ['user-typed-123', '9876'],
    });
    expect(r.text).not.toContain(secret);
    expect(r.text).not.toContain(encodeURIComponent(secret));
    expect(r.text).not.toContain('user-typed-123');
    expect(r.text).toContain('- textbox "Contraseña" [ref=e1]: ••••');
    expect(r.text).toContain('Tu clave es ••••.');
    expect(r.text).toContain('- /url: /r?p=••••');
    expect(r.text).toContain('- textbox "PIN" [ref=e5]: ••••');
    expect(r.text).toContain('- textbox "Nombre" [ref=e6]: Ana');
    expect(r.fullText).not.toContain(secret);
  });

  it('fits the budget keeping controls, headings and cookie buttons; drops menus first', () => {
    const navLinks = Array.from({ length: 200 }, (_, i) => ({
      role: 'listitem',
      ref: `e${1000 + i}`,
      children: [
        { role: 'link', name: `Enlace de menú ${i}`, ref: `e${2000 + i}`, url: `/menu/${i}` },
      ],
    }));
    const footerLinks = Array.from({ length: 80 }, (_, i) => ({
      role: 'link',
      name: `Pie ${i}`,
      ref: `e${3000 + i}`,
      url: `/pie/${i}`,
    }));
    const options = Array.from({ length: 300 }, (_, i) => ({
      role: 'option',
      name: `País ${i}`,
      ...(i === 150 ? { selected: true } : {}),
    }));
    const paragraphs = Array.from({ length: 60 }, (_, i) => ({
      role: 'paragraph',
      ref: `e${4000 + i}`,
      text: `Texto informativo número ${i} con bastante contenido para ocupar espacio en la página.`,
    }));
    const json: AriaJsonNode[] = [
      {
        role: 'dialog',
        name: 'Uso de cookies',
        ref: 'e5',
        children: [
          {
            role: 'paragraph',
            ref: 'e6',
            text: 'Utilizamos cookies propias y de terceros para analizar el uso del sitio.',
          },
          { role: 'button', name: 'Aceptar', ref: 'e7' },
          { role: 'button', name: 'Rechazar', ref: 'e8' },
        ],
      },
      {
        role: 'navigation',
        name: 'Menú principal',
        ref: 'e9',
        children: [{ role: 'list', ref: 'e10', children: navLinks }],
      },
      {
        role: 'main',
        ref: 'e11',
        children: [
          { role: 'heading', name: 'Solicitud de cita previa', level: 1, ref: 'e12' },
          ...paragraphs,
          {
            role: 'generic',
            ref: 'e13',
            children: [
              { role: 'textbox', name: 'NIE', ref: 'e14' },
              { role: 'combobox', name: 'País', ref: 'e15', children: options },
              { role: 'checkbox', name: 'Acepto', ref: 'e16', checked: false },
              { role: 'button', name: 'Enviar solicitud', ref: 'e17' },
            ],
          },
        ],
      },
      { role: 'contentinfo', ref: 'e18', children: footerLinks },
    ];
    const full = renderSnapshot(json, { budget: BIG });
    expect(full.text.length).toBeGreaterThan(10_000);

    const r = renderSnapshot(json, { budget: 4_000 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(4_000);
    for (const kept of [
      'heading "Solicitud de cita previa"',
      'textbox "NIE" [ref=e14]',
      'combobox "País" [ref=e15]',
      'option "País 150" [selected]',
      'checkbox "Acepto" [ref=e16]',
      'button "Enviar solicitud" [ref=e17]',
      'button "Aceptar" [ref=e7]',
      'button "Rechazar" [ref=e8]',
    ]) {
      expect(r.text).toContain(kept);
    }
    expect(r.text).not.toContain('Enlace de menú 150');
    expect(r.text).not.toContain('Pie 70');
    expect(r.text).toMatch(/# .*hidden/);
    // refs of pruned nodes are still known (describeRef)
    expect(r.refs.get('e2150')).toEqual({ role: 'link', name: 'Enlace de menú 150' });
  });

  it('hard-cuts when even the essentials do not fit', () => {
    const buttons = Array.from({ length: 400 }, (_, i) => ({
      role: 'button',
      name: `Botón ${i}`,
      ref: `e${i + 1}`,
    }));
    const r = renderSnapshot(buttons, { budget: 1_000 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(1_000);
    expect(r.text).toContain('button "Botón 0" [ref=e1]');
    expect(r.text).toMatch(/# … \d+ more lines not shown/);
  });

  it('handles empty and malformed input', () => {
    expect(renderSnapshot([], { budget: 100 }).text).toBe('');
    expect(renderSnapshot(null, { budget: 100 }).text).toBe('');
    expect(renderSnapshot([42, 'texto suelto'], { budget: 1000 }).text).toBe(
      '- text: texto suelto',
    );
  });
});
