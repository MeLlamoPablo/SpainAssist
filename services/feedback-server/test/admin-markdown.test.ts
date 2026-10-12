import { describe, expect, it } from 'vitest';
import { MARKDOWN_JS } from '../src/admin-markdown';

type Node = string | { tag: string; attrs: Record<string, string> | null; children: Node[] };

const markdown = new Function(`${MARKDOWN_JS}; return markdown;`)() as (
  src: string,
  h: (tag: string, attrs: Record<string, string> | null, ...children: Node[]) => Node,
) => Node[];

const h = (tag: string, attrs: Record<string, string> | null, ...children: Node[]): Node => ({
  tag,
  attrs,
  children,
});

/** Compact HTML-ish view of the tree, for readable assertions (text is not escaped). */
const show = (nodes: Node[]): string =>
  nodes
    .map((n) => {
      if (typeof n === 'string') return n;
      const attrs = Object.entries(n.attrs ?? {})
        .map(([k, v]) => ` ${k}="${v}"`)
        .join('');
      return n.tag === 'br' || n.tag === 'hr'
        ? `<${n.tag}>`
        : `<${n.tag}${attrs}>${show(n.children)}</${n.tag}>`;
    })
    .join('');

const md = (src: string) => show(markdown(src, h));

describe('admin page markdown', () => {
  it('keeps plain text as paragraphs, with single newlines as line breaks', () => {
    expect(md('Primera línea\nsegunda línea\n\nOtro párrafo')).toBe(
      '<p>Primera línea<br>segunda línea</p><p>Otro párrafo</p>',
    );
  });

  it('renders inline emphasis, code and strikethrough', () => {
    expect(md('Pide **cita previa** y *no* uses `F5`, ~~nunca~~ _jamás_.')).toBe(
      '<p>Pide <strong>cita previa</strong> y <em>no</em> uses <code>F5</code>, <del>nunca</del> <em>jamás</em>.</p>',
    );
    expect(md('**negrita con *cursiva* dentro**')).toBe(
      '<p><strong>negrita con <em>cursiva</em> dentro</strong></p>',
    );
    expect(md('nombre_de_archivo.pdf y 2 * 3 * 4')).toBe(
      '<p>nombre_de_archivo.pdf y 2 * 3 * 4</p>',
    );
  });

  it('renders headings, lists, quotes, rules and fenced code', () => {
    expect(md('## Pasos\n1. Entra\n2. Firma\n   con AutoFirma\n\n- uno\n- dos')).toBe(
      '<h4 class="md-h2">Pasos</h4><ol><li>Entra</li><li>Firma<br>con AutoFirma</li></ol>' +
        '<ul><li>uno</li><li>dos</li></ul>',
    );
    expect(md('3. tercero\n4. cuarto')).toBe('<ol start="3"><li>tercero</li><li>cuarto</li></ol>');
    expect(md('> Ojo: **caduca**\n> en 10 min\n\n---\n\n```\n<b>literal</b> **no**\n```')).toBe(
      '<blockquote><p>Ojo: <strong>caduca</strong><br>en 10 min</p></blockquote><hr>' +
        '<pre><code><b>literal</b> **no**</code></pre>',
    );
  });

  it('links only http(s) URLs, opening in a new tab without referrer', () => {
    const link = (url: string) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    expect(md('[la sede](https://sede.gob.es/x) o https://www.citapreviadnie.es/.')).toBe(
      '<p><a href="https://sede.gob.es/x" target="_blank" rel="noopener noreferrer">la sede</a>' +
        ` o ${link('https://www.citapreviadnie.es/')}.</p>`,
    );
    expect(md('[clic](javascript:alert(1)) [x](data:text/html,hi)')).toBe(
      '<p>[clic](javascript:alert(1)) [x](data:text/html,hi)</p>',
    );
  });

  it('never turns input into markup: HTML stays text', () => {
    const tree = markdown('<img src=x onerror=alert(1)> **<script>alert(1)</script>**', h);
    const tags: string[] = [];
    const walk = (nodes: Node[]) => {
      for (const n of nodes) {
        if (typeof n !== 'string') {
          tags.push(n.tag);
          walk(n.children);
        }
      }
    };
    walk(tree);
    expect(tags).toEqual(['p', 'strong']);
    expect(show(tree)).toContain('<img src=x onerror=alert(1)>');
  });

  it('handles empty and unterminated input', () => {
    expect(md('')).toBe('');
    expect(md('```\nsin cerrar')).toBe('<pre><code>sin cerrar</code></pre>');
    expect(md('**sin cerrar y `tampoco')).toBe('<p>**sin cerrar y `tampoco</p>');
  });
});
