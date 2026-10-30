import './helpers/no-network';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AnswererError,
  type AnswererOptions,
  type AnswererPrompt,
  type AnswererRecord,
  createAnswerer,
  createDirectorySink,
  DEFAULT_ANSWERER_MAX_TOKENS,
  DEFAULT_ANSWERER_MODEL,
} from '../../src/llm/answerer';
import { replayCodexCredential } from '../../src/llm/codex-auth';
import { createCredentialSource } from '../../src/llm/credentials';
import type { MeterRun } from '../../src/llm/meter';
import { type EnvOptions, type MeterEnv, startEnv } from './helpers/meter-env';

let env: MeterEnv;
afterEach(() => env.close());

const PERSONA =
  'Eres María, 34 años, vives en Valencia. Tu DNI es 12345678Z. Quieres tu vida laboral para una hipoteca. No recuerdas tu número de la Seguridad Social.';

const form: AnswererPrompt = {
  kind: 'form',
  title: 'Datos para la vida laboral',
  message: 'Necesito algunos datos.',
  fields: [
    { key: 'fullName', type: 'text', label: 'Nombre completo' },
    {
      key: 'access',
      type: 'select',
      label: 'Cómo quieres identificarte',
      options: [
        { value: 'clave', label: 'Cl@ve Permanente' },
        { value: 'dnie', label: 'DNIe' },
      ],
    },
    {
      key: 'reasons',
      type: 'multiselect',
      label: 'Motivos',
      options: [
        { value: 'mortgage', label: 'Hipoteca' },
        { value: 'job', label: 'Trabajo' },
      ],
    },
    { key: 'urgent', type: 'boolean', label: '¿Es urgente?' },
    { key: 'years', type: 'number', label: 'Años de cotización' },
    { key: 'born', type: 'date', label: 'Fecha de nacimiento' },
    { key: 'ssn', type: 'text', label: 'Número de la Seguridad Social' },
    { key: 'password', type: 'secret', label: 'Contraseña de Cl@ve', secret: true },
    { key: 'upload', type: 'document', label: 'Documento' },
  ],
};

const reply = (json: unknown) => ({
  rules: [],
  fallback: { text: typeof json === 'string' ? json : JSON.stringify(json) },
});

function mockWith(scenario: ReturnType<typeof reply>): EnvOptions['mock'] {
  return { scenario, litellm: {} };
}

async function answererFor(options: Partial<AnswererOptions> = {}, run?: MeterRun) {
  const useRun = run ?? env.openRun();
  const answerer = await createAnswerer({
    provider: 'voucher',
    run: useRun,
    credentials: createCredentialSource({ provider: 'mock' }),
    ...options,
  });
  return { answerer, run: useRun };
}

const textOfContent = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part as { text?: string }).text ?? '').join('')
      : '';

const userPromptSent = (index = -1) => {
  const body = env.llm.requests().at(index)!.body as {
    messages: { role: string; content: unknown }[];
  };
  return textOfContent(body.messages.filter((m) => m.role === 'user').at(-1)!.content);
};

describe('answerer: forms', () => {
  it('answers a form with typed values, skipping what the persona does not know', async () => {
    env = await startEnv({
      mock: mockWith(
        reply({
          fullName: 'María García López',
          access: 'clave',
          reasons: ['mortgage'],
          urgent: true,
          years: 12,
          born: '1992-03-04',
          ssn: null,
        }),
      ),
    });
    const { answerer } = await answererFor();
    const result = await answerer.answer({
      persona: PERSONA,
      instructions: 'Contesta como lo haría María.',
      prompt: form,
    });
    expect(result).toEqual({
      type: 'values',
      values: {
        fullName: 'María García López',
        access: 'clave',
        reasons: ['mortgage'],
        urgent: true,
        years: 12,
        born: '1992-03-04',
      },
      skipped: ['ssn'],
    });
  });

  it('never shows secret or document fields to the model', async () => {
    env = await startEnv({ mock: mockWith(reply({ fullName: 'María' })) });
    const { answerer } = await answererFor();
    await answerer.answer({
      persona: PERSONA,
      prompt: {
        ...form,
        fields: form.fields!.filter(
          (f) => f.key === 'fullName' || f.key === 'password' || f.key === 'upload',
        ),
      },
    });
    const prompt = userPromptSent();
    expect(prompt).toContain('fullName');
    expect(prompt).not.toContain('password');
    expect(prompt).not.toContain('Contraseña');
    expect(prompt).not.toContain('upload');
    // A secret field cannot be answered either: the schema does not know the key.
    env.llm.setScenario(reply({ fullName: 'María', password: 'x' }));
    const strict = answerer.answer({
      persona: PERSONA,
      prompt: {
        ...form,
        fields: form.fields!.filter((f) => f.key === 'fullName' || f.key === 'password'),
      },
    });
    await expect(strict).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('does not call the model when only the harness can answer (secrets, documents)', async () => {
    env = await startEnv();
    const { answerer } = await answererFor();
    const result = await answerer.answer({
      persona: PERSONA,
      prompt: {
        ...form,
        fields: form.fields!.filter((f) => f.key === 'password' || f.key === 'upload'),
      },
    });
    expect(result).toEqual({ type: 'values', values: {}, skipped: [] });
    expect(env.llm.requests()).toHaveLength(0);
  });

  it('accepts an option label for a select and maps it to its value', async () => {
    env = await startEnv({
      mock: mockWith(reply({ access: 'dnie', reasons: ['hipoteca', 'job'] })),
    });
    const { answerer } = await answererFor();
    const result = await answerer.answer({
      persona: PERSONA,
      prompt: {
        ...form,
        fields: form.fields!.filter((f) => f.key === 'access' || f.key === 'reasons'),
      },
    });
    expect(result).toMatchObject({ values: { access: 'dnie', reasons: ['mortgage', 'job'] } });
    env.llm.setScenario(reply({ access: 'Cl@ve Permanente' }));
    const byLabel = await answerer.answer({
      persona: PERSONA,
      prompt: { ...form, fields: form.fields!.filter((f) => f.key === 'access') },
    });
    expect(byLabel).toMatchObject({ values: { access: 'clave' } });
  });

  it('tolerates a markdown fence and text around the JSON', async () => {
    env = await startEnv({ mock: mockWith(reply('Claro:\n```json\n{"fullName": "María"}\n```')) });
    const { answerer } = await answererFor();
    const result = await answerer.answer({
      persona: PERSONA,
      prompt: { ...form, fields: [form.fields![0]!] },
    });
    expect(result).toMatchObject({ values: { fullName: 'María' } });
  });

  it("describes the form and the conversation deterministically, in the persona's language", async () => {
    env = await startEnv({ mock: mockWith(reply({ fullName: 'Mary' })) });
    const { answerer } = await answererFor();
    const request = {
      persona: PERSONA,
      language: 'en' as const,
      prompt: { ...form, fields: [form.fields![0]!, form.fields![1]!] },
      conversation: [
        { from: 'user' as const, text: 'Sácame la vida laboral' },
        { from: 'agent' as const, text: 'Voy a necesitar tus datos.' },
      ],
    };
    await answerer.answer(request);
    await answerer.answer(request);
    const [a, b] = env.llm.requests().map((r) => JSON.stringify(r.body));
    expect(a).toBe(b);
    const body = env.llm.requests()[0]!.body as { messages: { role: string; content: unknown }[] };
    const system = textOfContent(body.messages[0]!.content);
    expect(system).toContain('Eres María');
    expect(system).toContain('Write in English');
    expect(system).toContain('Never make up passwords, PINs');
    const sent = userPromptSent();
    const user = JSON.parse(sent.slice(sent.indexOf('{'), sent.lastIndexOf('}') + 1)) as Record<
      string,
      unknown
    >;
    expect(user).toMatchObject({
      title: 'Datos para la vida laboral',
      fields: [
        { key: 'fullName', type: 'text', label: 'Nombre completo', answer: 'text' },
        {
          key: 'access',
          type: 'select',
          answer: 'one option value',
          options: [
            { value: 'clave', label: 'Cl@ve Permanente' },
            { value: 'dnie', label: 'DNIe' },
          ],
        },
      ],
      conversation: [
        { from: 'user', text: 'Sácame la vida laboral' },
        { from: 'agent', text: 'Voy a necesitar tus datos.' },
      ],
    });
  });
});

describe('answerer: strict output with one repair retry', () => {
  const rules = (first: string, second: string) => ({
    rules: [{ when: { lastUser: 'Your reply was not valid' }, reply: { text: second } }],
    fallback: { text: first },
  });

  it('retries once with the problem and the previous reply in the conversation', async () => {
    env = await startEnv({
      mock: { scenario: rules('lo siento, no puedo', '{"fullName": "María"}'), litellm: {} },
    });
    const sunk: AnswererRecord[] = [];
    const { answerer } = await answererFor({ sink: (r) => void sunk.push(r) });
    const result = await answerer.answer({
      persona: PERSONA,
      prompt: { ...form, fields: [form.fields![0]!] },
    });
    expect(result).toMatchObject({ values: { fullName: 'María' } });

    const retry = env.llm.requests()[1]!.body as { messages: { role: string; content: unknown }[] };
    expect(retry.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(JSON.stringify(retry.messages[2])).toContain('lo siento, no puedo');
    expect(userPromptSent()).toMatch(
      /^Your reply was not valid: the reply has no JSON object\. Reply again with only the JSON object\.$/,
    );

    expect(sunk.map((r) => [r.n, r.attempt, r.error ? 'error' : 'ok'])).toEqual([
      [1, 1, 'error'],
      [1, 2, 'ok'],
    ]);
    expect(sunk[0]!.error).toBe('invalid output: the reply has no JSON object');
    expect(sunk[1]!.parsed).toMatchObject({ type: 'values' });
  });

  it('names the failing fields, never their values, and gives up after one retry', async () => {
    env = await startEnv({
      mock: mockWith(reply({ fullName: 'María', access: 'something-else', years: 'twelve' })),
    });
    const { answerer } = await answererFor();
    const failure = await answerer
      .answer({
        persona: PERSONA,
        prompt: {
          ...form,
          fields: form.fields!.filter((f) => ['fullName', 'access', 'years'].includes(f.key)),
        },
      })
      .catch((error: unknown) => error as AnswererError);
    expect(failure).toBeInstanceOf(AnswererError);
    expect(failure).toMatchObject({ code: 'invalid_output' });
    expect((failure as Error).message).toContain('access: must be one of the option values');
    expect((failure as Error).message).toContain('years');
    expect((failure as Error).message).not.toContain('something-else');
    expect(env.llm.requests()).toHaveLength(2);
  });

  it('treats a cut-off reply as invalid', async () => {
    env = await startEnv({ mock: mockWith(reply('{"fullName": "Mar')) });
    const { answerer } = await answererFor();
    await expect(
      answerer.answer({ persona: PERSONA, prompt: { ...form, fields: [form.fields![0]!] } }),
    ).rejects.toMatchObject({
      code: 'invalid_output',
      message: expect.stringContaining('no JSON object'),
    });
  });

  it('validates dates and numbers', async () => {
    env = await startEnv({ mock: mockWith(reply({ born: '4 de marzo de 1992' })) });
    const { answerer } = await answererFor();
    await expect(
      answerer.answer({
        persona: PERSONA,
        prompt: { ...form, fields: form.fields!.filter((f) => f.key === 'born') },
      }),
    ).rejects.toThrow(/born: must be YYYY-MM-DD/);
  });
});

describe('answerer: the model call', () => {
  const bodySent = () => env.llm.requests().at(-1)!.body as Record<string, unknown>;

  it('uses Haiku 5.5 with low reasoning through the meter as agent "answerer"', async () => {
    env = await startEnv({ mock: mockWith(reply({ fullName: 'María' })) });
    const { answerer, run } = await answererFor();
    expect(answerer.model).toBe(DEFAULT_ANSWERER_MODEL);
    expect(answerer.thinking).toBe('low');
    await answerer.answer({ persona: PERSONA, prompt: { ...form, fields: [form.fields![0]!] } });
    expect(bodySent()).toMatchObject({
      model: 'anthropic/claude-haiku-5.5',
      max_tokens: DEFAULT_ANSWERER_MAX_TOKENS,
      reasoning_effort: 'low',
      stream: true,
    });
    expect(env.llm.requests().at(-1)!.path).toBe('/v1/chat/completions');
    expect(run.agentKeys()).toEqual(['answerer']);
    expect(run.agentUsage('answerer').requests).toBe(1);
    expect(env.ledgerLines().at(-1)).toMatchObject({ agent: 'answerer', kind: 'forward' });
  });

  it('is configurable: model, thinking level, output budget', async () => {
    env = await startEnv({ mock: mockWith(reply({ fullName: 'María' })) });
    const { answerer } = await answererFor({
      model: 'openai/gpt-6-luna',
      thinking: 'high',
      maxTokens: 4096,
    });
    await answerer.answer({ persona: PERSONA, prompt: { ...form, fields: [form.fields![0]!] } });
    expect(bodySent()).toMatchObject({
      model: 'openai/gpt-6-luna',
      max_tokens: 4096,
      reasoning_effort: 'high',
    });
  });

  it('switches reasoning off on Haiku 5.5 as effort "none", and turns minimal into low', async () => {
    env = await startEnv({ mock: mockWith(reply({ fullName: 'María' })) });
    for (const [thinking, sent] of [
      ['off', 'none'],
      ['minimal', 'low'],
      ['low', 'low'],
    ] as const) {
      const { answerer } = await answererFor({ thinking });
      expect(answerer.thinking).toBe(thinking === 'minimal' ? 'low' : thinking);
      await answerer.answer({ persona: PERSONA, prompt: { ...form, fields: [form.fields![0]!] } });
      expect(bodySent()).toMatchObject({ reasoning_effort: sent });
    }
    const { answerer } = await answererFor({ thinking: 'medium' });
    expect(answerer.thinking).toBe('medium');
  });

  it('caps the answerer separately: a tight default budget ends as a "budget" error', async () => {
    env = await startEnv({
      mock: {
        scenario: {
          rules: [],
          fallback: {
            text: '{"fullName": "María"}',
            usage: { costUsd: 0.03, promptTokens: 100, completionTokens: 10 },
          },
        },
        litellm: {},
      },
    });
    const { answerer, run } = await answererFor();
    const ask = () =>
      answerer.answer({ persona: PERSONA, prompt: { ...form, fields: [form.fields![0]!] } });
    await ask();
    await ask();
    await expect(ask()).rejects.toMatchObject({ name: 'AnswererError', code: 'budget' });
    // The refusal is the meter's: nothing reached the gateway for the third call.
    expect(env.llm.requests()).toHaveLength(2);
    expect(run.summary().rejects).toEqual({ agent_budget: 1 });
  });

  it('reports a replay miss as such', async () => {
    env = await startEnv();
    const run = env.openRun({ cache: 'replay' });
    const { answerer } = await answererFor({}, run);
    await expect(
      answerer.answer({ persona: PERSONA, prompt: { ...form, fields: [form.fields![0]!] } }),
    ).rejects.toMatchObject({ code: 'replay_miss' });
  });

  it('records answers and replays them for free, identically', async () => {
    env = await startEnv({ mock: mockWith(reply({ fullName: 'María García' })) });
    const recorded = env.openRun({ cache: 'record' });
    const { answerer: live } = await answererFor({}, recorded);
    const request = { persona: PERSONA, prompt: { ...form, fields: [form.fields![0]!] } };
    const first = await live.answer(request);
    const replayRun = env.openRun({ cache: 'replay' });
    const { answerer: replayed } = await answererFor(
      { credentials: createCredentialSource({ provider: 'voucher', cache: 'replay' }) },
      replayRun,
    );
    const second = await replayed.answer(request);
    expect(second).toEqual(first);
    expect(env.llm.requests()).toHaveLength(1);
    expect(replayRun.usage().cacheHits).toBe(1);
  });

  it('works on a ChatGPT plan through the Codex endpoint', async () => {
    env = await startEnv({
      provider: 'codex',
      upstreamPath: '/backend-api',
      meter: { codexConsent: true },
      mock: { scenario: reply({ fullName: 'María desde Codex' }), chunkSize: 8 },
    });
    const run = env.openRun({ cache: 'record' });
    const answerer = await createAnswerer({
      provider: 'codex',
      run,
      // A source serving the synthetic login (the test never needs the real tokens).
      credentials: {
        providerId: 'openai-codex',
        credential: async () => replayCodexCredential(),
        refreshCredential: async () => replayCodexCredential(),
      },
    });
    expect(answerer.model).toBe('gpt-6-luna');
    const result = await answerer.answer({
      persona: PERSONA,
      prompt: { ...form, fields: [form.fields![0]!] },
    });
    expect(result).toMatchObject({ values: { fullName: 'María desde Codex' } });
    expect(env.llm.requests().at(-1)).toMatchObject({ path: '/backend-api/codex/responses' });
    expect(run.agentUsage('answerer').requests).toBe(1);
  });

  it('refuses prompts it cannot answer', async () => {
    env = await startEnv();
    const { answerer } = await answererFor();
    for (const kind of ['confirm', 'user_action', 'credential', 'phone_call'] as const) {
      await expect(
        answerer.answer({ persona: PERSONA, prompt: { kind, title: 'x' } }),
      ).rejects.toMatchObject({
        code: 'unsupported_prompt',
      });
    }
    expect(env.llm.requests()).toHaveLength(0);
  });
});

describe('answerer: secrets and transcripts', () => {
  const PASSWORD = 'hunter2-clave-password';

  it('refuses to send a prompt that carries a registered secret', async () => {
    env = await startEnv();
    const sunk: AnswererRecord[] = [];
    const { answerer } = await answererFor({ secrets: [PASSWORD], sink: (r) => void sunk.push(r) });
    await expect(
      answerer.answer({
        persona: `${PERSONA} Tu contraseña es ${PASSWORD}.`,
        prompt: { ...form, fields: [form.fields![0]!] },
      }),
    ).rejects.toMatchObject({ code: 'secret_in_prompt' });
    await expect(
      answerer.answer({
        persona: PERSONA,
        prompt: { ...form, fields: [form.fields![0]!] },
        conversation: [{ from: 'user', text: `mi clave es ${PASSWORD}` }],
      }),
    ).rejects.toMatchObject({ code: 'secret_in_prompt' });
    expect(env.llm.requests()).toHaveLength(0);
    expect(sunk).toHaveLength(0);
  });

  it('writes every request and response to the sink with secrets and keys masked', async () => {
    env = await startEnv({ mock: mockWith(reply({ fullName: `María (${PASSWORD})` })) });
    const dir = join(env.t.home, 'run', 'answerer');
    const { answerer } = await answererFor({
      secrets: [PASSWORD],
      sink: createDirectorySink(dir, [PASSWORD]),
    });
    const result = await answerer.answer({
      persona: PERSONA,
      prompt: { ...form, fields: [form.fields![0]!] },
    });
    // The caller gets the model's value (it is the harness' business what to do with it)...
    expect(result).toMatchObject({ values: { fullName: `María (${PASSWORD})` } });
    // ... the transcript is clean.
    expect(readdirSync(dir)).toEqual(['001-1.json']);
    expect(statSync(join(dir, '001-1.json')).mode & 0o777).toBe(0o600);
    const written = readFileSync(join(dir, '001-1.json'), 'utf8');
    expect(written).not.toContain(PASSWORD);
    expect(written).toContain('[redacted]');
    const record = JSON.parse(written) as AnswererRecord;
    expect(record).toMatchObject({
      n: 1,
      attempt: 1,
      provider: 'voucher',
      model: 'anthropic/claude-haiku-5.5',
      thinking: 'low',
      response: {
        stopReason: 'stop',
        usage: { input: expect.any(Number), output: expect.any(Number) },
      },
    });
    expect(record.request.system).toContain('Eres María');
    expect(record.request.messages[0]!.role).toBe('user');
    expect(record.at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('numbers answers and attempts, and never writes the API key', async () => {
    env = await startEnv({ mock: mockWith(reply({ fullName: 'María' })) });
    const dir = join(env.t.home, 'run', 'answerer');
    const { answerer } = await answererFor({ sink: createDirectorySink(dir) });
    const request = { persona: PERSONA, prompt: { ...form, fields: [form.fields![0]!] } };
    await answerer.answer(request);
    await answerer.answer(request);
    expect(readdirSync(dir)).toEqual(['001-1.json', '002-1.json']);
    expect(existsSync(join(dir, '003-1.json'))).toBe(false);
    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file), 'utf8')).not.toMatch(/sk-|Bearer/);
    }
  });

  it('records failed calls too, with the redacted error', async () => {
    env = await startEnv();
    const run = env.openRun({ limits: { perRunUsd: 0.0001 } });
    const sunk: AnswererRecord[] = [];
    const { answerer } = await answererFor({ sink: (r) => void sunk.push(r) }, run);
    await expect(
      answerer.answer({ persona: PERSONA, prompt: { ...form, fields: [form.fields![0]!] } }),
    ).rejects.toMatchObject({ code: 'budget' });
    expect(sunk).toHaveLength(1);
    expect(sunk[0]!.error).toMatch(/out of budget/);
    expect(sunk[0]!.response?.stopReason).toBe('error');
  });
});
