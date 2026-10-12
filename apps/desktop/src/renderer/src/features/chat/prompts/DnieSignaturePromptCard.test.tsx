import {
  DEFAULT_SETTINGS,
  type DnieSignaturePrompt,
  type Language,
  type PromptItem,
} from '@sa/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DnieSignaturePromptCard } from './DnieSignaturePromptCard';

// Server rendering reads a zustand store's initial state: give components a plain one instead.
const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('../../../store/app', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(store.state),
    { getState: () => store.state, setState: (patch: object) => Object.assign(store.state, patch) },
  ),
}));

function render(language: Language, prompt: Partial<DnieSignaturePrompt>): string {
  store.state = {
    settings: { ...DEFAULT_SETTINGS, language },
    companion: { state: 'connected', device: 'Pixel 8', expiresAt: '2026-10-12T22:00:00.000Z' },
  };
  const full: DnieSignaturePrompt = {
    kind: 'dnie_signature',
    purpose: 'document',
    title: 'Firma con tu DNIe',
    message: 'sede.example.gob.es te pide firmar.',
    stage: 'reviewing',
    ...prompt,
  };
  const item: PromptItem = {
    id: 'prompt-1',
    type: 'prompt',
    createdAt: '2026-10-12T10:00:00.000Z',
    prompt: full,
    status: 'pending',
  };
  return renderToStaticMarkup(<DnieSignaturePromptCard item={item} prompt={full} />);
}

describe('DNIe progress card: the reviewing step', () => {
  it('asks for the PIN only when the phone will ask for it', () => {
    const typed = { es: 'escribe el PIN de tu DNIe', en: 'type your DNIe PIN' };
    const savedPin = {
      es: 'Comprueba qué firmas y para quién.',
      en: 'Check what you sign and for whom.',
    };
    const certificate = {
      es: 'Comprueba quién lo pide y comparte tu certificado.',
      en: 'Check who asks and share your certificate.',
    };
    for (const lang of ['es', 'en'] as const) {
      const noPin = render(lang, {});
      expect(noPin).toContain(typed[lang]);

      // The request carries the PIN saved in Mis datos: the phone skips its PIN step.
      const saved = render(lang, { savedPin: true });
      expect(saved).toContain(savedPin[lang]);
      expect(saved).not.toContain(typed[lang]);

      // Reading the certificate needs no PIN.
      const read = render(lang, { purpose: 'certificate' });
      expect(read).toContain(certificate[lang]);
      expect(read).not.toContain(typed[lang]);

      // Later steps don't depend on the PIN.
      expect(render(lang, { savedPin: true, stage: 'card' })).toBe(render(lang, { stage: 'card' }));
    }
  });
});
