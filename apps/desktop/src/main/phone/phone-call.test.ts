import { TRANSCRIPTION_MODEL, wavFile } from '@sa/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../core/logger';
import type { UserKey } from '../providers/manager';
import {
  createFakeFetch,
  createTestApp,
  type FakeRequest,
  jsonResponse,
  type TestApp,
} from '../testing/harness';
import { CallTranscriber, PART_SECONDS } from './transcriber';

const GATEWAY: UserKey = { baseUrl: 'http://127.0.0.1:8789/v1', apiKey: 'sk-gateway-secret' };

const EMASESA_CALL = {
  title: 'Llama a EMASESA',
  organization: 'EMASESA · Atención al cliente',
  phoneNumber: '900 822 010',
  purpose: 'Saber cómo cambiar el número de personas que viven en la casa.',
  questions: ['¿Puede pedirlo el inquilino si el contrato está a nombre de la casera?'],
  haveAtHand: ['Número de contrato (en la factura)'],
};

/** `seconds` of silence as the renderer records it (16 kHz, 16-bit mono WAV). */
const recording = (seconds: number) => wavFile(new Uint8Array(seconds * 16_000 * 2));

/** A gateway answer with the model's transcript. */
const transcriptResponse = (text: string) =>
  jsonResponse(200, { choices: [{ message: { role: 'assistant', content: text } }] });

function transcriber(
  handler: (req: FakeRequest) => Response | Promise<Response>,
  /** null: the user has no gateway key (BYOK, custom endpoint). */
  key: UserKey | null = GATEWAY,
) {
  const fetch = createFakeFetch(handler);
  const logs: string[] = [];
  const logger = {
    ...silentLogger,
    warn: (msg: string, data?: unknown) => logs.push(`${msg} ${JSON.stringify(data)}`),
    info: (msg: string, data?: unknown) => logs.push(`${msg} ${JSON.stringify(data)}`),
  };
  const client = new CallTranscriber({
    access: async () => key ?? undefined,
    fetch,
    logger,
    lang: () => 'es',
  });
  return { client, fetch, logs };
}

describe('CallTranscriber', () => {
  it('sends the recording to the gateway with the user key, ZDR only, and returns the text', async () => {
    const { client, fetch, logs } = transcriber(() =>
      transcriptResponse('Tú: Hola.\nEllos: Buenos días.'),
    );
    expect(await client.transcribe(recording(3))).toBe('Tú: Hola.\nEllos: Buenos días.');
    const [req] = fetch.requests;
    expect(req?.url.href).toBe('http://127.0.0.1:8789/v1/chat/completions');
    expect(req?.headers.get('authorization')).toBe('Bearer sk-gateway-secret');
    expect(req?.body).toMatchObject({
      model: TRANSCRIPTION_MODEL,
      provider: { zdr: true, data_collection: 'deny' },
    });
    const audio = req?.body.messages[1].content[1];
    expect(audio).toMatchObject({ type: 'input_audio', input_audio: { format: 'wav' } });
    expect(Buffer.from(audio.input_audio.data, 'base64').byteLength).toBe(recording(3).byteLength);
    expect(logs.join('\n')).not.toContain('Buenos días');
  });

  it('transcribes long calls in parts and joins them in order', async () => {
    let n = 0;
    const { client, fetch } = transcriber(() => transcriptResponse(`Parte ${++n}`));
    const text = await client.transcribe(recording(PART_SECONDS + 10));
    expect(fetch.requests).toHaveLength(2);
    expect(text).toBe('Parte 1\n\nParte 2');
    expect(fetch.requests[1]?.body.messages[1].content[0].text).toContain('Part 2 of 2');
  });

  it('drops parts without speech', async () => {
    const { client } = transcriber(() => transcriptResponse('[no speech]'));
    expect(await client.transcribe(recording(1))).toBe('');
  });

  it('refuses recordings that are not the app format or too long, without calling', async () => {
    const { client, fetch } = transcriber(() => transcriptResponse('x'));
    const stereo = recording(1);
    stereo[22] = 2;
    await expect(client.transcribe(stereo)).rejects.toThrow('no es válida');
    await expect(client.transcribe(recording(20 * 60 + 1))).rejects.toThrow('no es válida');
    expect(fetch.requests).toHaveLength(0);
  });

  it('explains when there is no gateway key, or no credit left', async () => {
    const noKey = transcriber(() => transcriptResponse('x'), null);
    expect(await noKey.client.available()).toBe(false);
    await expect(noKey.client.transcribe(recording(1))).rejects.toThrow('no puedo transcribir');

    const broke = transcriber(() =>
      jsonResponse(400, {
        error: { message: 'Budget has been exceeded!', type: 'budget_exceeded' },
      }),
    );
    await expect(broke.client.transcribe(recording(1))).rejects.toThrow('No queda saldo');
  });

  it('never leaks the key or upstream bodies in errors and logs', async () => {
    const { client, logs } = transcriber(() =>
      jsonResponse(500, { error: { message: 'boom sk-gateway-secret' } }),
    );
    const error = await client.transcribe(recording(1)).catch((err: Error) => err);
    expect(String(error)).toContain('No he podido transcribir');
    expect(`${String(error)} ${logs.join('\n')}`).not.toContain('sk-gateway-secret');
  });
});

describe('phone calls through the bridge and the renderer API', () => {
  let app: TestApp;
  let procedureId: string;
  let token: string;

  beforeEach(async () => {
    app = await createTestApp({
      fetch: createFakeFetch(() => transcriptResponse('Ellos: Lo tiene que pedir la titular.')),
    });
    ({ procedureId, token } = await app.procedureWithToken());
  });
  afterEach(async () => {
    await app.close();
  });

  /** The agent asks the user to call; resolves once the card shows it. */
  async function askToCall() {
    const call = app.rpc('prompt.phoneCall', EMASESA_CALL, token);
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    return { call, item: app.pendingPrompt(procedureId)! };
  }

  it('shows the call on the card and returns what the user sends', async () => {
    const { call, item } = await askToCall();
    expect(item.prompt).toEqual({ kind: 'phone_call', ...EMASESA_CALL });
    await app.invoke('chat.respond', item.id, {
      kind: 'phone_call',
      outcome: 'done',
      transcript: '  Ellos: Lo tiene que pedir la titular. ',
      notes: 'Llamar otra vez el lunes.',
    });
    expect((await call).body).toEqual({
      ok: true,
      result: {
        kind: 'phone_call',
        outcome: 'done',
        transcript: 'Ellos: Lo tiene que pedir la titular.',
        notes: 'Llamar otra vez el lunes.',
      },
    });
  });

  it('rejects an invalid phone number before asking the user', async () => {
    const res = await app.rpc(
      'prompt.phoneCall',
      { ...EMASESA_CALL, phoneNumber: 'llámales' },
      token,
    );
    expect(res.body.error?.code).toBe('bad_request');
    expect(app.pendingPrompt(procedureId)).toBeUndefined();
  });

  it('transcribes only for a pending phone call, with the gateway key from main', async () => {
    vi.spyOn(app.services.providers, 'userKey').mockResolvedValue(GATEWAY);
    expect(await app.invoke('phoneCall.transcriptionAvailable')).toBe(true);
    await expect(
      app.invoke('phoneCall.transcribe', 'q-unknown', { wav: recording(1) }),
    ).rejects.toThrow();

    const { call, item } = await askToCall();
    expect(await app.invoke('phoneCall.transcribe', item.id, { wav: recording(1) })).toEqual({
      text: 'Ellos: Lo tiene que pedir la titular.',
    });
    await app.invoke('chat.respond', item.id, { kind: 'phone_call', outcome: 'skipped' });
    await call;
    await expect(
      app.invoke('phoneCall.transcribe', item.id, { wav: recording(1) }),
    ).rejects.toThrow();
  });

  it('cannot transcribe without a voucher or ChatGPT account', async () => {
    expect(await app.invoke('phoneCall.transcriptionAvailable')).toBe(false);
  });
});
