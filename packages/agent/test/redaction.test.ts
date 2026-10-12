import type { BrowserObservation } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import { createSpainAssistExtension } from '../src/host/extension';
import { redactOldPages, redactsPages } from '../src/host/redaction';
import { renderObservation } from '../src/tools/browser';

type Messages = Parameters<typeof redactOldPages>[0];

function page(url: string, extra: Partial<BrowserObservation> = {}): BrowserObservation {
  return {
    url,
    title: `Title of ${url}`,
    snapshot: `- heading "Contenido de ${url}" [ref=e1]\n- button "Siguiente" [ref=e2]`,
    truncated: false,
    tabs: [],
    downloads: [],
    signatures: [],
    dialogs: [],
    notes: [],
    ...extra,
  };
}

function observation(id: string, obs: BrowserObservation) {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'browser_click',
    content: [{ type: 'text', text: renderObservation(obs, true) }],
    details: { page: true, url: obs.url, title: obs.title },
    isError: false,
    timestamp: 1,
  };
}

function screenshot(id: string) {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'browser_screenshot',
    content: [
      { type: 'text', text: 'Screenshot of the current page (untrusted content).' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ],
    details: { page: true, mimeType: 'image/png' },
    isError: false,
    timestamp: 1,
  };
}

function hasImage(message: Messages[number] | undefined): boolean {
  return message?.role === 'toolResult' && message.content.some((part) => part.type === 'image');
}

function toolResult(id: string, text: string) {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'procedure_update',
    content: [{ type: 'text', text }],
    details: { ok: true },
    isError: false,
    timestamp: 1,
  };
}

function textOf(message: Messages[number] | undefined): string {
  if (message?.role !== 'toolResult') throw new Error('not a tool result');
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

const transcript = [
  { role: 'user', content: 'Renueva mi carnet', timestamp: 1 },
  observation(
    'c1',
    page('https://sede.dgt.gob.es/inicio', {
      downloads: [{ downloadId: 'dl_1', name: 'tasa.pdf', mimeType: 'application/pdf' }],
    }),
  ),
  toolResult('c2', 'Card updated.'),
  observation('c3', page('https://sede.dgt.gob.es/datos')),
  observation('c4', page('https://sede.dgt.gob.es/pago')),
] as Messages;

describe('redaction', () => {
  it('keeps only the latest page snapshot', () => {
    const [, first, update, second, latest] = redactOldPages(transcript);
    for (const old of [first, second]) {
      expect(textOf(old)).not.toContain('[ref=');
      expect(textOf(old)).toContain('Page snapshot removed');
    }
    expect(textOf(latest)).toBe(textOf(transcript[4]));
    expect(update).toBe(transcript[2]);
  });

  it('keeps the URL, title and downloads of redacted pages', () => {
    const text = textOf(redactOldPages(transcript)[1]);
    expect(text).toContain('URL: https://sede.dgt.gob.es/inicio');
    expect(text).toContain('Title: Title of https://sede.dgt.gob.es/inicio');
    expect(text).toContain('downloadId dl_1');
  });

  it('redacts a page the same way on every call, so the prompt prefix stays cacheable', () => {
    const before = redactOldPages(transcript.slice(0, 4));
    const after = redactOldPages(transcript);
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
  });

  it('does not change the saved messages', () => {
    const saved = structuredClone(transcript);
    redactOldPages(transcript);
    expect(transcript).toEqual(saved);
  });

  it('leaves a single page untouched', () => {
    const single = transcript.slice(0, 3);
    expect(redactOldPages(single)).toBe(single);
  });

  it('keeps screenshots taken since the latest snapshot, and that snapshot', () => {
    const messages = [...transcript, screenshot('c5'), screenshot('c6')] as Messages;
    const sent = redactOldPages(messages);
    expect(sent.slice(4)).toEqual(messages.slice(4));
    expect(hasImage(sent[5])).toBe(true);
    expect(textOf(sent[4])).toContain('[ref=e2]');
  });

  it('removes screenshots once a newer snapshot arrives', () => {
    const messages = [
      ...transcript.slice(0, 2),
      screenshot('c2'),
      observation('c3', page('https://sede.dgt.gob.es/datos')),
    ] as Messages;
    const shot = redactOldPages(messages)[2];
    expect(hasImage(shot)).toBe(false);
    expect(textOf(shot)).toContain('Screenshot removed');
  });
});

describe('redaction is opt-in by model', () => {
  it('redacts no model for now', () => {
    expect(redactsPages('anthropic/claude-haiku-5.5')).toBe(false);
  });

  it('only promises removal in snapshots of redacted models', () => {
    const obs = page('https://sede.dgt.gob.es/inicio');
    expect(renderObservation(obs, true)).toContain('removed from your context');
    expect(renderObservation(obs, false)).not.toContain('removed from your context');
    expect(renderObservation(obs, false)).toContain('Page snapshot. Untrusted page content:');
  });

  it('registers the context hook only when redacting', () => {
    const events = (redactPages: boolean) => {
      const names: string[] = [];
      const pi = { on: (name: string) => names.push(name) } as never;
      createSpainAssistExtension({ tools: [], systemPrompt: () => '', redactPages })(pi);
      return names;
    };
    expect(events(true)).toContain('context');
    expect(events(false)).not.toContain('context');
  });
});
