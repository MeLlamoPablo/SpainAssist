import { DEFAULT_SETTINGS, type DocumentMeta } from '@sa/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../components/ui/tooltip';
import { fileTypeLabel, standaloneDocumentIds } from './document-links';
import { Markdown } from './Markdown';

// Server rendering reads a zustand store's initial state: give components plain ones instead.
const { stores, fakeStore } = vi.hoisted(() => {
  const stores = {
    app: {} as Record<string, unknown>,
    vault: {} as Record<string, unknown>,
    procedures: { byId: {} } as Record<string, unknown>,
  };
  const fakeStore = (key: keyof typeof stores) =>
    Object.assign(
      (selector: (state: Record<string, unknown>) => unknown) => selector(stores[key]),
      { getState: () => stores[key] },
    );
  return { stores, fakeStore };
});
vi.mock('../../store/app', () => ({ useAppStore: fakeStore('app') }));
vi.mock('../../store/vault', () => ({ useVaultStore: fakeStore('vault') }));
vi.mock('../../store/procedures', () => ({ useProcedureStore: fakeStore('procedures') }));

const DOC: DocumentMeta = {
  id: 'doc-padron',
  name: 'Certificado de empadronamiento.pdf',
  mimeType: 'application/pdf',
  size: 312 * 1024,
  source: 'download',
  procedureId: 'p-padron',
  createdAt: '2026-10-12T10:00:00.000Z',
};

function render(text: string, documents: DocumentMeta[] | null = [DOC]): string {
  stores.app = { settings: DEFAULT_SETTINGS };
  stores.vault = { overview: documents ? { documents } : null };
  stores.procedures = {
    byId: { 'p-padron': { id: 'p-padron', title: 'Empadronarme en Sevilla' } },
  };
  return renderToStaticMarkup(
    <TooltipProvider>
      <Markdown text={text} />
    </TooltipProvider>,
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('document links in assistant messages', () => {
  it('shows a document link alone in its paragraph as a card', () => {
    const html = render(
      '¡Hecho! Aquí tienes tu certificado:\n\n[Certificado](sa:document/doc-padron)',
    );
    expect(count(html, 'data-testid="document-card"')).toBe(1);
    expect(html).toContain('Certificado de empadronamiento.pdf');
    expect(html).toContain('PDF · 312 KB · Empadronarme en Sevilla');
    expect(html).not.toContain('href="sa:document');
  });

  it('shows several standalone links as several cards', () => {
    const html = render('[A](sa:document/doc-padron)\n[B](sa:document/doc-padron)');
    expect(count(html, 'data-testid="document-card"')).toBe(2);
  });

  it('keeps a link inside a sentence inline', () => {
    const html = render('Lo tienes en [tu certificado](sa:document/doc-padron), ya guardado.');
    expect(html).not.toContain('document-card');
    expect(html).toContain('href="sa:document/doc-padron"');
    expect(html).toContain('>tu certificado</a>');
  });

  it('shows a quiet state for an unknown or deleted document, never a link', () => {
    const html = render('[Certificado](sa:document/doc-gone)');
    expect(html).toContain('data-testid="document-missing"');
    expect(html).toContain('Documento no disponible');
    expect(html).not.toContain('<a ');
    const inline = render('Mira [el certificado](sa:document/doc-gone) cuando puedas.');
    expect(inline).toContain('<span>el certificado</span>');
    expect(inline).not.toContain('<a ');
  });

  it('shows neither a card nor the missing state before the vault loads', () => {
    const html = render('[Certificado](sa:document/doc-padron)', null);
    expect(html).not.toContain('document-card');
    expect(html).not.toContain('document-missing');
  });
});

describe('standaloneDocumentIds', () => {
  const link = (href: string) => ({
    type: 'element',
    tagName: 'a',
    properties: { href },
    children: [{ type: 'text', value: 'x' }],
  });
  const p = (...children: object[]) => ({ type: 'element', tagName: 'p', children }) as never;

  it('finds paragraphs made only of document links', () => {
    expect(standaloneDocumentIds(p(link('sa:document/a')))).toEqual(['a']);
    expect(
      standaloneDocumentIds(
        p(link('sa:document/a'), { type: 'text', value: '\n' }, link('sa:document/b')),
      ),
    ).toEqual(['a', 'b']);
    expect(
      standaloneDocumentIds(p(link('sa:document/a'), { type: 'element', tagName: 'br' })),
    ).toEqual(['a']);
  });

  it('ignores anything else', () => {
    expect(standaloneDocumentIds(undefined)).toBeNull();
    expect(standaloneDocumentIds(p())).toBeNull();
    expect(standaloneDocumentIds(p({ type: 'text', value: 'Hola' }))).toBeNull();
    expect(
      standaloneDocumentIds(p({ type: 'text', value: 'Mira ' }, link('sa:document/a'))),
    ).toBeNull();
    expect(standaloneDocumentIds(p(link('sa:document/a'), link('sa:vault/documents')))).toBeNull();
    expect(standaloneDocumentIds(p(link('sa:document/../x')))).toBeNull();
  });
});

describe('fileTypeLabel', () => {
  it('names common types, else uses the extension', () => {
    expect(fileTypeLabel('application/pdf', 'x')).toBe('PDF');
    expect(fileTypeLabel('image/jpeg', 'foto.jpeg')).toBe('JPG');
    expect(fileTypeLabel('application/octet-stream', 'datos.xml')).toBe('XML');
    expect(fileTypeLabel('application/octet-stream', 'sin-extension')).toBeNull();
  });
});
