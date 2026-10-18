import {
  type CompanionStatus,
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

function render(
  language: Language,
  prompt: Partial<DnieSignaturePrompt>,
  companion: CompanionStatus['state'] = 'connected',
): string {
  store.state = {
    settings: { ...DEFAULT_SETTINGS, language },
    companion: { state: companion, device: 'Pixel 8', expiresAt: '2026-10-12T22:00:00.000Z' },
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

describe('DNIe progress card', () => {
  it('never asks for the PIN on the phone', () => {
    const typed = { es: 'escribe el PIN', en: 'type your DNIe PIN' };
    const certificate = {
      es: 'Comprueba quién lo pide y comparte tu certificado.',
      en: 'Check who asks and share your certificate.',
    };
    for (const lang of ['es', 'en'] as const) {
      expect(render(lang, {})).not.toContain(typed[lang]);
      expect(render(lang, { purpose: 'certificate' })).toContain(certificate[lang]);
    }
  });

  it('asks for what the card needs, with help, before anything goes to the phone', () => {
    const both = render('es', { stage: 'unlock', unlock: { can: true, pin: true } });
    expect(both).toContain('data-testid="dnie-unlock"');
    expect(both).toContain('Número CAN');
    expect(both).toContain('PIN del DNIe');
    expect(both).toContain('¿Qué es el PIN y dónde lo encuentro?');
    expect(both).not.toContain('data-stage');
    const pinOnly = render('en', { stage: 'unlock', unlock: { can: false, pin: true } });
    expect(pinOnly).not.toContain('CAN number');
    expect(pinOnly).toContain('DNIe PIN');
    expect(
      render('es', {
        stage: 'unlock',
        unlock: { can: false, pin: true, refused: 'pin', triesLeft: 1 },
      }),
    ).toContain('te queda un intento');
    expect(
      render('en', { stage: 'unlock', unlock: { can: true, pin: false, refused: 'can' } }),
    ).toContain('match your DNIe');
  });

  it('asks to open the app while the paired phone is away, then follows the phone', () => {
    const away = render('es', { stage: 'phone', purpose: 'login' }, 'away');
    expect(away).toContain('Abre Spain Assist en el móvil para continuar');
    expect(away).toContain('solo recibe las peticiones con la app abierta');
    expect(away).toContain('Pixel 8 no está conectado');
    expect(away).not.toContain('data-stage');
    expect(render('en', { stage: 'phone' }, 'away')).toContain(
      'Open Spain Assist on your phone to continue',
    );
    const connected = render('es', { stage: 'phone' });
    expect(connected).not.toContain('Abre Spain Assist en el móvil');
    expect(connected).toContain('data-stage="phone"');
    expect(connected).toContain('Mira tu móvil');
  });
});
