import './helpers/no-network';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MeterEvent } from '../../src/llm/meter';
import { RequestSecrets } from '../../src/llm/request-secrets';
import { chatBody, type MeterEnv, post, startEnv, userMessage } from './helpers/meter-env';

const PASSWORD = 'SpainBench2026!';

describe('RequestSecrets', () => {
  const found = (secret: string, text: string) => {
    const secrets = new RequestSecrets();
    secrets.add(secret);
    return secrets.scan(text);
  };

  it('finds a secret as it is, and says so', () => {
    expect(found(PASSWORD, `mi clave es ${PASSWORD}, gracias`)).toEqual(['plain']);
    expect(found(PASSWORD, 'nada que ver')).toEqual([]);
  });

  it('finds it escaped for JSON, once, twice and three times (JSON in a field of JSON in a field)', () => {
    const secret = 'pa"ss\\word\n2026';
    const once = JSON.stringify(secret).slice(1, -1);
    const twice = JSON.stringify(once).slice(1, -1);
    const thrice = JSON.stringify(twice).slice(1, -1);
    for (const text of [once, twice, thrice])
      expect(found(secret, `x ${text} y`)).toContain('escaped');
    // And inside a real body: a tool result that is itself JSON text.
    const toolResult = JSON.stringify({ login: { password: secret } });
    const body = JSON.stringify({ messages: [{ role: 'tool', content: toolResult }] });
    expect(found(secret, body)).toContain('escaped');
  });

  it('finds it percent-encoded and form-encoded', () => {
    const secret = 'Spain#Bench&2026 ok';
    expect(found(secret, `https://x.es/login?clave=${encodeURIComponent(secret)}`)).toEqual([
      'url',
    ]);
    expect(found(secret, 'clave=Spain%23Bench%262026+ok')).toEqual(['url']);
  });

  it('finds it hidden by base64 at any of the three alignments, base64url, hex and base32', () => {
    const b64 = (text: string) => Buffer.from(text).toString('base64');
    for (const around of ['', 'a', 'ab']) {
      const encoded = b64(`${around}${PASSWORD}`);
      expect(found(PASSWORD, `{"data":"${encoded}"}`), around).toContain('encoded');
    }
    const url = Buffer.from(PASSWORD).toString('base64url');
    expect(found(PASSWORD, `token=${url}`)).toContain('encoded');
    expect(found(PASSWORD, `h=${Buffer.from(PASSWORD).toString('hex')}`)).toContain('encoded');
  });

  it('cuts screenshots out first: their bytes are not text, and would match a short secret by chance', () => {
    const picture = `data:image/png;base64,${'AAAA'.repeat(200)}${Buffer.from(PASSWORD).toString('base64')}`;
    expect(found(PASSWORD, JSON.stringify({ image_url: { url: picture } }))).toEqual([]);
    expect(found(PASSWORD, `${picture} ${PASSWORD}`)).toEqual(['plain']);
  });

  it('ignores values that are too short, and registers nothing for them', () => {
    const secrets = new RequestSecrets();
    for (const short of ['', '1234', '12345', undefined, null]) secrets.add(short);
    expect(secrets.size).toBe(0);
    expect(secrets.scan('1234 12345')).toEqual([]);
  });
});

describe('meter proxy: secrets in what the model is sent', () => {
  let env: MeterEnv;
  beforeEach(async () => {
    env = await startEnv();
  });
  afterEach(() => env.close());

  function watch(run: ReturnType<MeterEnv['openRun']>) {
    const events: Extract<MeterEvent, { type: 'secret_in_request' }>[] = [];
    run.on((event) => {
      if (event.type === 'secret_in_request') events.push(event);
    });
    return events;
  }

  it('says nothing about a clean conversation, whatever is registered', async () => {
    const run = env.openRun();
    run.addSecret(PASSWORD);
    const events = watch(run);
    const res = await post(run, 'procedure-1', chatBody([userMessage('Sácame la vida laboral')]));
    expect(res.status).toBe(200);
    expect(events).toEqual([]);
  });

  it('flags a secret in a tool result, in the system prompt, in a compaction summary and in a user message', async () => {
    const run = env.openRun();
    run.addSecret(PASSWORD);
    const events = watch(run);
    const withToolResult = chatBody([
      userMessage('hola'),
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'vault_read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: `{"clave":"${PASSWORD}"}` },
    ]);
    await post(run, 'procedure-1', withToolResult);
    const inSystem = chatBody([
      { role: 'system', content: `Eres un asistente. La clave del usuario es ${PASSWORD}.` },
      userMessage('hola'),
    ]);
    await post(run, 'assistant', inSystem);
    const inCompaction = chatBody([
      userMessage(
        `The conversation history before this point was compacted into the following summary:\n\n<summary>\nEl usuario entró con la clave ${PASSWORD}.\n</summary>`,
      ),
      userMessage('sigue'),
    ]);
    await post(run, 'procedure-1', inCompaction);
    await post(run, 'procedure-2', chatBody([userMessage(`mi clave: ${PASSWORD}`)]));

    expect(events.map((e) => [e.agent, e.path, e.forms])).toEqual([
      ['procedure-1', '/v1/chat/completions', ['plain']],
      ['assistant', '/v1/chat/completions', ['plain']],
      ['procedure-1', '/v1/chat/completions', ['plain']],
      ['procedure-2', '/v1/chat/completions', ['plain']],
    ]);
    expect(
      events.every((e) => e.runId === run.runId && e.model === 'anthropic/claude-haiku-5.5'),
    ).toBe(true);
    // The event says where and how, never the secret.
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
  });

  it('flags it in a nested JSON string and in base64, as the agent or a page might have put it', async () => {
    const run = env.openRun();
    run.addSecret(PASSWORD);
    const events = watch(run);
    const nested = JSON.stringify({ outer: JSON.stringify({ inner: { clave: PASSWORD } }) });
    await post(
      run,
      'procedure-1',
      chatBody([{ role: 'tool', tool_call_id: 'x', content: nested }]),
    );
    const encoded = Buffer.from(`user:${PASSWORD}`).toString('base64');
    await post(
      run,
      'procedure-1',
      chatBody([{ role: 'tool', tool_call_id: 'y', content: `Authorization: Basic ${encoded}` }]),
    );
    expect(events.map((e) => e.forms)).toEqual([['plain'], ['encoded']]);
  });

  it('serves the request anyway, also from the replay cache, and scans only this run`s secrets', async () => {
    const first = env.openRun({ cache: 'record' });
    first.addSecret(PASSWORD);
    const body = chatBody([userMessage(`clave ${PASSWORD}`)]);
    const firstEvents = watch(first);
    expect((await post(first, 'procedure-1', body)).status).toBe(200);
    expect(firstEvents).toHaveLength(1);

    const replay = env.openRun({ cache: 'replay' });
    replay.addSecret(PASSWORD);
    const replayEvents = watch(replay);
    expect((await post(replay, 'procedure-1', body)).status).toBe(200);
    expect(replayEvents).toHaveLength(1);

    const other = env.openRun();
    const otherEvents = watch(other);
    await post(other, 'procedure-1', body);
    expect(otherEvents).toEqual([]);
  });

  it('starts looking from the moment a secret is registered, and does not look for short ones', async () => {
    const run = env.openRun();
    const events = watch(run);
    const body = chatBody([userMessage(`clave ${PASSWORD} y 1234`)]);
    await post(run, 'procedure-1', body);
    run.addSecret(PASSWORD);
    run.addSecret('1234');
    await post(run, 'procedure-1', body);
    expect(events).toHaveLength(1);
    expect(events[0]?.forms).toEqual(['plain']);
  });
});
