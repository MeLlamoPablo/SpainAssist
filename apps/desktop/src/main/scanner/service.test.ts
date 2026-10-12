import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScannerEvent } from '../../scanner';
import type { ProviderManager } from '../providers/manager';
import type { FrameDecision } from './decider';
import { DocumentScanner, parseDocumentFields, scanImageSchema, scanReasoning } from './service';

const fields = {
  givenName: 'Carmen',
  surname1: 'García',
  documentNumber: '99999999R',
  documentType: 'DNI',
  birthDate: '1990-01-15',
};
const image = 'data:image/jpeg;base64,/9j/2Q==';
const accepted: FrameDecision = {
  accepted: true,
  documentPresent: 0.99,
  documentLegible: 0.99,
  model: 'perplexity/pplx-decider-v1.1-27b',
  usage: { input_tokens: 100, output_tokens: 0, cost: 0.000004 },
  startedAt: 1,
  completedAt: 2,
};
const gate = () => ({
  check: vi.fn(async (_image: string, _signal: AbortSignal) => accepted),
});
function provider(baseUrl = 'http://127.0.0.1:1', configured = true) {
  return {
    status: () => ({ configured, label: 'Mock vision' }),
    agentModel: vi.fn(async () => {
      if (!configured) throw new Error('no_provider');
      return { provider: 'custom', id: 'mock-vision', baseUrl, api: 'openai-completions' };
    }),
    refreshCredential: vi.fn(async () => ({ type: 'api_key', key: 'test-only' })),
    creditSpent: vi.fn(),
  };
}
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

describe('document vision scanner', () => {
  it('requires a provider in main even when called directly', async () => {
    const p = provider(undefined, false);
    const scanner = new DocumentScanner(p as unknown as ProviderManager, () => 'es');
    expect(await scanner.status()).toEqual({ available: false, reason: 'no_provider' });
    await expect(scanner.read(image)).rejects.toThrow('Comprueba tu conexión');
    expect(p.refreshCredential).not.toHaveBeenCalled();
  });
  it('blocks models that do not support images before inference', async () => {
    const p = provider();
    p.agentModel = vi.fn(async () => ({
      provider: 'groq',
      id: 'llama-3.3-70b-versatile',
      baseUrl: 'http://127.0.0.1:1',
      api: 'openai-completions',
    }));
    const scanner = new DocumentScanner(p as unknown as ProviderManager, () => 'en');
    expect(await scanner.status()).toMatchObject({ available: false, reason: 'no_vision' });
    await expect(scanner.read(image)).rejects.toThrow('Check your AI connection');
  });
  it('uses a dedicated vision model for OpenAI without changing the chat model', async () => {
    const p = provider();
    p.agentModel = vi.fn(async () => ({
      provider: 'openai',
      id: 'gpt-6-astra',
      baseUrl: 'http://127.0.0.1:1',
      api: 'openai-completions',
    }));
    const scanner = new DocumentScanner(p as unknown as ProviderManager, () => 'en');
    // Sol cannot turn reasoning off, yet scans: with its lowest effort.
    expect(await scanner.status()).toMatchObject({ available: true, model: 'gpt-6.1-sol' });
    expect((await p.agentModel()).id).toBe('gpt-6-astra');
  });
  it.each([
    ['gpt-6.1-sol', { reasoning: 'low' }],
    ['google/gemini-3.5-flash-lite', { reasoning: 'minimal' }],
    ['anthropic/claude-haiku-5.5', { reasoning: 'low' }],
    ['gpt-6-luna', {}],
  ])('scans %s with %o', (id, options) => {
    const model = { id, provider: 'openai', api: 'openai-responses' } as Model<Api>;
    expect(scanReasoning(model)).toEqual(options);
  });
  // Vouchers scan with Haiku 5.5 on our gateway; OpenRouter BYOK scans with the selected model.
  it.each([
    ['litellm', 'anthropic/claude-haiku-5.5'],
    ['openrouter', 'moonshotai/kimi-k2.6'],
  ])('scans %s with %s without changing the chat model', async (providerId, scanModel) => {
    const p = provider();
    p.agentModel = vi.fn(async () => ({
      provider: providerId,
      id: 'moonshotai/kimi-k2.6',
      baseUrl: 'http://127.0.0.1:1/v1',
      api: 'openai-completions',
      maxTokens: 8192,
    }));
    const scanner = new DocumentScanner(p as unknown as ProviderManager, () => 'en');
    expect(await scanner.status()).toMatchObject({ available: true, model: scanModel });
    expect(await p.agentModel()).toMatchObject({ id: 'moonshotai/kimi-k2.6', maxTokens: 8192 });
    expect(p.refreshCredential).toHaveBeenCalledWith(providerId);
  });
  it('validates image payloads and model output', () => {
    expect(scanImageSchema.safeParse('https://example.com/document.jpg').success).toBe(false);
    expect(scanImageSchema.safeParse('data:image/svg+xml;base64,AAAA').success).toBe(false);
    expect(parseDocumentFields(JSON.stringify(fields))).toEqual(fields);
    expect(parseDocumentFields(`\`\`\`json\n${JSON.stringify(fields)}\n\`\`\``)).toEqual(fields);
    expect(() => parseDocumentFields('{}')).toThrow();
    expect(() =>
      parseDocumentFields(JSON.stringify({ ...fields, birthDate: '1990-02-31' })),
    ).toThrow();
    expect(() => parseDocumentFields(JSON.stringify({ ...fields, password: 'secret' }))).toThrow();
  });
  it.each(['resolved', 'unavailable', 'failure', 'existing', 'invalid'])(
    'returns scanned photo fields when postal lookup is %s',
    async (mode) => {
      const scannedFields = {
        ...fields,
        documentType: mode === 'existing' ? 'TIE' : 'DNI',
        addressStreet: 'Calle Ejemplo 12',
        addressMunicipality: 'Madrid',
        ...(mode === 'existing' ? { addressPostalCode: '28002' } : {}),
      };
      const postalLookup = vi.fn(async () => {
        if (mode === 'failure') throw new Error('private address in service error');
        return mode === 'unavailable' ? undefined : mode === 'invalid' ? '99999' : '28001';
      });
      const requests: unknown[] = [];
      const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        requests.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          `data: ${JSON.stringify({ id: 'mock', choices: [{ index: 0, delta: { content: JSON.stringify(scannedFields) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        );
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const p = provider(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
      const scanner = new DocumentScanner(
        p as unknown as ProviderManager,
        () => 'en',
        undefined,
        undefined,
        postalLookup,
      );
      expect((await scanner.status()).available).toBe(true);
      expect(requests).toHaveLength(0);
      expect(await scanner.read(image)).toEqual(
        mode === 'resolved' ? { ...scannedFields, addressPostalCode: '28001' } : scannedFields,
      );
      expect(postalLookup).toHaveBeenCalledTimes(mode === 'existing' ? 0 : 1);
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0])).toContain(image);
      expect(JSON.stringify(requests[0])).not.toContain('test-only');
    },
  );
  it('does not expose provider errors or document content on failure', async () => {
    const p = provider();
    const scanner = new DocumentScanner(p as unknown as ProviderManager, () => 'en');
    await expect(scanner.read(image)).rejects.toThrow('Check your AI connection');
    // The request may have reached the gateway: refresh the voucher balance anyway.
    expect(p.creditSpent).toHaveBeenCalledOnce();
  });
});

describe('live scanner IPC lifecycle', () => {
  it.each([
    { providerId: 'custom', development: true },
    { providerId: 'openrouter', development: true },
    { providerId: 'custom', development: false },
    { providerId: 'openrouter', development: false },
    { providerId: 'litellm', development: false },
  ] as const)(
    'gates $providerId frames before inference and retains artifacts only in development ($development)',
    async ({ providerId, development }) => {
      const directory = await mkdtemp(join(tmpdir(), 'sa-scan-test-'));
      const requests: Record<string, unknown>[] = [];
      const completeFields = {
        ...fields,
        surname2: 'López',
        documentSupportNumber: 'CAA000000',
        sex: 'F',
        nationality: 'ESP',
        documentExpiry: '2036-06-02',
        documentIssueDate: '2026-06-02',
        birthPlace: 'Madrid',
        fatherName: 'Juan',
        motherName: 'Ana',
        addressStreet: 'Calle de Ejemplo, 12',
        addressMunicipality: 'Madrid',
        addressProvince: 'Madrid',
        dniIssuingTeam: '12345A6B7',
        dniAccessNumber: '123456',
      };
      const turns = [
        [
          { name: 'record_fields', arguments: { fields, sides: ['front'] } },
          {
            name: 'capture_images',
            arguments: { reason: 'Dale la vuelta al DNI.', success: true },
          },
        ],
        [
          { name: 'record_fields', arguments: { fields: {}, sides: [] } },
          {
            name: 'capture_images',
            arguments: { reason: 'Enseña el reverso del documento.', success: false },
          },
        ],
        [
          {
            name: 'finish_scan',
            arguments: {
              fields: completeFields,
              sides: ['front', 'back'],
              unavailable: [],
              permanent: false,
            },
          },
        ],
      ];
      const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        requests.push(JSON.parse(body));
        const calls = turns.shift()!;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = {
          id: 'mock',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: calls.map((call, i) => ({
                  index: i,
                  id: `call-${requests.length}-${i}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              },
              finish_reason: null,
            },
          ],
        };
        res.end(
          `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ id: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
        );
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const p = provider(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
      if (providerId !== 'custom') {
        p.agentModel = vi.fn(async () => ({
          provider: providerId,
          id: 'moonshotai/kimi-k2.6',
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          api: 'openai-completions',
          maxTokens: 8192,
        }));
      }
      const decisions = [
        { ...accepted, accepted: false, documentPresent: 0.01 },
        { ...accepted, accepted: false, documentLegible: 0.01 },
        accepted,
        { ...accepted, accepted: false, documentPresent: 0.01 },
        { ...accepted, accepted: false, documentPresent: 0.01 },
        { ...accepted, accepted: false, documentLegible: 0.01 },
        accepted,
        accepted,
      ];
      const frameGate = gate();
      frameGate.check.mockImplementation(async () => {
        return decisions.shift()!;
      });
      const scanner = new DocumentScanner(
        p as unknown as ProviderManager,
        () => 'es',
        development ? directory : undefined,
        frameGate,
        async () => '28001',
      );
      const id = randomUUID();
      const events: ScannerEvent[] = [];
      try {
        const completed = new Promise<ScannerEvent>((resolve) => {
          void scanner.start(id, (event) => {
            events.push(event);
            if (event.type === 'capture')
              scanner.frames({
                sessionId: id,
                requestId: event.requestId,
                images: [
                  events.filter((e) => e.type === 'capture').length <= 2
                    ? 'data:image/jpeg;base64,QUFB'
                    : image,
                ],
              });
            if (event.type === 'complete' || event.type === 'error') resolve(event);
          });
        });
        expect(await completed).toMatchObject({
          type: 'complete',
          fields: { ...completeFields, addressPostalCode: '28001' },
        });
        expect(events.filter((e) => e.type === 'capture')).toHaveLength(8);
        expect(frameGate.check).toHaveBeenCalledTimes(8);
        expect(JSON.stringify(requests)).not.toContain('data:image/jpeg;base64,QUFB');
        expect(events.filter((event) => event.type === 'guidance')).toEqual([
          { sessionId: id, type: 'guidance', guidance: { state: 'positioning' } },
          { sessionId: id, type: 'guidance', guidance: { state: 'reading' } },
          {
            sessionId: id,
            type: 'guidance',
            guidance: { state: 'feedback', reason: 'Dale la vuelta al DNI.', success: true },
          },
          { sessionId: id, type: 'guidance', guidance: { state: 'reading' } },
          {
            sessionId: id,
            type: 'guidance',
            guidance: {
              state: 'feedback',
              reason: 'Enseña el reverso del documento.',
              success: false,
            },
          },
          { sessionId: id, type: 'guidance', guidance: { state: 'reading' } },
        ]);
        expect(requests).toHaveLength(3);
        if (providerId === 'openrouter') {
          // OpenRouter BYOK: the selected model, reasoning off in OpenRouter's format.
          expect(requests.every((r) => r.model === 'moonshotai/kimi-k2.6')).toBe(true);
          expect(
            requests.every((r) => (r.reasoning as { effort?: string })?.effort === 'none'),
          ).toBe(true);
        } else if (providerId === 'litellm') {
          // Vouchers: Haiku 5.5 on our gateway, its lowest effort as the standard OpenAI parameter.
          expect(requests.every((r) => r.model === 'anthropic/claude-haiku-5.5')).toBe(true);
          expect(requests.every((r) => r.reasoning_effort === 'low' && !r.reasoning)).toBe(true);
        } else expect(requests.every((r) => r.reasoning_effort === 'none')).toBe(true);
        expect(JSON.stringify(requests[0])).toContain('capture_images');
        expect(JSON.stringify(requests[0])).toContain(image);
        if (development) {
          const transcript = await readFile(join(directory, id, 'session.jsonl'), 'utf8');
          expect(transcript).toContain('Dale la vuelta al DNI.');
          expect(transcript).toContain('addressStreet');
          expect(transcript).toContain('frame_decision');
          expect(transcript).toContain('input_tokens');
          expect(transcript).toContain('completedAt');
          expect(transcript).not.toContain('test-only');
          expect(transcript).not.toContain('/9j/2Q==');
          expect(
            (await readdir(join(directory, id))).filter((f) => f.endsWith('.jpg')),
          ).toHaveLength(11);
          if (process.platform !== 'win32') {
            expect((await stat(join(directory, id))).mode & 0o777).toBe(0o700);
            expect((await stat(join(directory, id, 'session.jsonl'))).mode & 0o777).toBe(0o600);
          }
        } else expect(await readdir(directory)).toEqual([]);
        expect(() =>
          scanner.frames({ sessionId: id, requestId: randomUUID(), images: [image] }),
        ).toThrow('Inactive');
        // Cancel a second session while its capture tool is waiting on the renderer.

        const cancelledId = randomUUID();
        const cancelledEvents: ScannerEvent[] = [];
        const requested = new Promise<void>((resolve) => {
          void scanner.start(cancelledId, (event) => {
            cancelledEvents.push(event);
            if (event.type === 'capture') resolve();
          });
        });
        await requested;
        await expect(scanner.start(randomUUID(), () => {})).rejects.toThrow();
        await scanner.cancel(cancelledId);
        expect(cancelledEvents.map((event) => event.type)).toEqual(['guidance', 'capture']);
        // Each ended session (complete and cancelled) refreshes the voucher balance.
        expect(p.creditSpent).toHaveBeenCalledTimes(2);
        expect(requests).toHaveLength(3);
        if (development) {
          expect(await readFile(join(directory, cancelledId, 'session.jsonl'), 'utf8')).toContain(
            '"status":"cancelled"',
          );
        } else expect(await readdir(directory)).toEqual([]);
      } finally {
        await scanner.cancel(id);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('shows lighting help after five seconds of a present but illegible document and resets it', async () => {
    const atSecond = (second: number) => ({
      startedAt: second * 1000,
      completedAt: second * 1000 + 500,
    });
    const illegible = (second: number) => ({
      ...accepted,
      accepted: false,
      documentLegible: 0.1,
      ...atSecond(second),
    });
    const missing = (second: number) => ({
      ...accepted,
      accepted: false,
      documentPresent: 0.1,
      documentLegible: 0.1,
      ...atSecond(second),
    });
    const decisions = [
      ...[0, 1, 2, 3].map(illegible),
      missing(4), // No document breaks the streak before it reaches five seconds.
      ...[5, 6, 7, 8, 9].map(illegible), // 4.5 s since the streak started: no help yet.
      illegible(10), // 5.5 s: help.
      illegible(11),
      missing(12), // Back to the capture guidance.
    ];
    const frameGate = gate();
    frameGate.check.mockImplementation(async () => decisions.shift()!);
    const scanner = new DocumentScanner(
      provider() as unknown as ProviderManager,
      () => 'es',
      undefined,
      frameGate,
    );
    const id = randomUUID();
    const events: ScannerEvent[] = [];
    const ended = new Promise<void>((resolve) => {
      void scanner.start(id, (event) => {
        events.push(event);
        if (event.type !== 'capture') return;
        const count = events.filter((e) => e.type === 'capture').length;
        const hints = events.filter((e) => e.type === 'guidance');
        expect(hints).toHaveLength(count >= 14 ? 3 : count >= 12 ? 2 : 1);
        if (count === 14) {
          resolve();
          return;
        }
        scanner.frames({ sessionId: id, requestId: event.requestId, images: [image] });
      });
    });
    try {
      await ended;
      expect(events.filter((e) => e.type === 'guidance')).toEqual([
        { sessionId: id, type: 'guidance', guidance: { state: 'positioning' } },
        { sessionId: id, type: 'guidance', guidance: { state: 'legibility' } },
        { sessionId: id, type: 'guidance', guidance: { state: 'positioning' } },
      ]);
      expect(frameGate.check).toHaveBeenCalledTimes(13);
    } finally {
      await scanner.cancel(id);
    }
  });

  it('rejects invalid IPC arguments and cancels pending capture without publishing failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sa-scan-cancel-'));
    const scanner = new DocumentScanner(
      provider() as unknown as ProviderManager,
      () => 'en',
      directory,
      gate(),
    );
    try {
      await expect(scanner.start('bad-id', () => {})).rejects.toThrow();
      expect(() =>
        scanner.frames({
          sessionId: randomUUID(),
          requestId: randomUUID(),
          images: [image, image, image, image],
        }),
      ).toThrow();
      const id = randomUUID();
      const events: ScannerEvent[] = [];
      await scanner.start(id, (event) => events.push(event));
      await scanner.cancel(id);
      expect(events).toEqual([]);
      // A cancelled scanner can be used again.
      await scanner.start(randomUUID(), () => {});
      await scanner.cancel();
    } finally {
      await scanner.cancel();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
