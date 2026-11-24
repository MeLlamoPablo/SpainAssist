import { DEFAULT_SETTINGS, type DocumentMeta, type UiNode } from '@sa/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { UiRenderer } from './UiRenderer';

// Server rendering reads a zustand store's initial state: give components plain ones instead.
const { stores, plainStore } = vi.hoisted(() => ({
  stores: { app: {} as Record<string, unknown>, vault: {} as Record<string, unknown> },
  plainStore: (state: () => Record<string, unknown>) =>
    Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(state()), {
      getState: state,
    }),
}));
vi.mock('../../store/app', () => ({ useAppStore: plainStore(() => stores.app) }));
// Leaflet (the map of interfaces) needs a window at import time.
vi.mock('../chat/prompts/LocationMap', () => ({ LocationMap: () => null }));
vi.mock('../../store/vault', () => ({
  useVaultStore: plainStore(() => stores.vault),
  useDocuments: () => (stores.vault.overview as { documents: DocumentMeta[] }).documents,
}));

const contract: DocumentMeta = {
  id: 'd_1',
  name: 'Contrato de compraventa.jpeg',
  mimeType: 'image/jpeg',
  size: 1,
  source: 'user',
  createdAt: '2026-10-21T08:00:00.000Z',
};

/** An interface with one DocumentPicker whose value is `value`, as the app draws it. */
function pickerShowing(value: string): string {
  stores.app = { settings: { ...DEFAULT_SETTINGS, language: 'es' } };
  stores.vault = { overview: { documents: [contract] } };
  const tree: UiNode = {
    type: 'Root',
    props: {},
    children: [
      {
        type: 'DocumentPicker',
        props: { label: 'Contrato', value, onChange: { $handler: 'h#1' } },
        children: [],
      },
    ],
  };
  return renderToStaticMarkup(<UiRenderer runId="run_1" uiKey="papeles" tree={tree} rev={1} />);
}

describe('a DocumentPicker of an interface', () => {
  it('shows the document its value names, with or without the extension', () => {
    expect(pickerShowing('Contrato de compraventa.jpeg')).toContain(contract.name);
    expect(pickerShowing('Contrato de compraventa')).toContain(contract.name);
  });

  it('shows nothing chosen for an id: agents give names', () => {
    expect(pickerShowing('d_1')).not.toContain(contract.name);
  });
});
