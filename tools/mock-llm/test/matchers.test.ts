import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analyzeRequest,
  createMockLlm,
  type MockLlm,
  matchRule,
  parseScenario,
} from '../src/index';
import { renderTemplate, renderValue } from '../src/scenario';
import { chat, chatText, user } from './helpers';

const assistantCall = (id: string, name: string, args: unknown) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const toolResult = (id: string, content: string) => ({ role: 'tool', tool_call_id: id, content });

describe('request facts', () => {
  it('collects the whole call history with results, the system prompt and the images', () => {
    const facts = analyzeRequest({
      model: 'm',
      messages: [
        { role: 'system', content: 'You are the procedure agent.' },
        { role: 'developer', content: 'Be brief.' },
        user('hola'),
        assistantCall('c1', 'browser_open', { url: 'https://a.example' }),
        toolResult('c1', 'opened page'),
        assistantCall('c2', 'browser_click', { ref: 'e5' }),
        {
          role: 'tool',
          tool_call_id: 'c2',
          content: [{ type: 'text', text: 'clicked' }],
        },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }],
        },
      ],
    });
    expect(facts.systemPrompt).toBe('You are the procedure agent.\nBe brief.');
    expect(facts.imageCount).toBe(1);
    expect(facts.calls).toEqual([
      {
        id: 'c1',
        name: 'browser_open',
        args: '{"url":"https://a.example"}',
        result: 'opened page',
      },
      { id: 'c2', name: 'browser_click', args: '{"ref":"e5"}', result: 'clicked' },
    ]);
  });
});

describe('deeper matchers', () => {
  const facts = analyzeRequest({
    model: 'mock-model',
    messages: [
      { role: 'system', content: 'You are one of Spain Assist procedure agents.' },
      user('sácame la vida laboral'),
      assistantCall('c1', 'browser_snapshot', {}),
      toolResult('c1', 'button "Acceso Cl@ve" [ref=e12]'),
      assistantCall('c2', 'browser_click', { ref: 'e12' }),
      toolResult('c2', 'Navigated to the login page'),
      assistantCall('c3', 'browser_snapshot', {}),
      toolResult('c3', 'textbox "DNI" [ref=e30]'),
    ],
    tools: [{ type: 'function', function: { name: 'browser_click' } }],
  });

  it('matches the system prompt and captures from it', () => {
    expect(matchRule({ systemPrompt: 'procedure (?<kind>agents)' }, facts)).toEqual({
      kind: 'agents',
    });
    expect(matchRule({ systemPrompt: 'answerer' }, facts)).toBeNull();
  });

  it('matches history calls by name, arguments and result, with captures from the most recent', () => {
    const captures = matchRule(
      {
        toolCalled: [
          {
            name: 'browser_snapshot',
            result: 'button "Acceso Cl@ve" \\[ref=(?<loginRef>e\\d+)\\]',
          },
          { name: 'browser_click', args: '"ref":"(?<clicked>e\\d+)"' },
        ],
      },
      facts,
    );
    expect(captures).toEqual({ loginRef: 'e12', clicked: 'e12' });
  });

  it('counts calls: atLeast defaults to one, atMost: 0 means never', () => {
    expect(
      matchRule({ toolCalled: { name: 'browser_snapshot', atLeast: 2 } }, facts),
    ).not.toBeNull();
    expect(matchRule({ toolCalled: { name: 'browser_snapshot', atLeast: 3 } }, facts)).toBeNull();
    expect(matchRule({ toolCalled: { name: 'browser_snapshot', atMost: 1 } }, facts)).toBeNull();
    expect(matchRule({ toolCalled: { name: 'download_save', atMost: 0 } }, facts)).not.toBeNull();
    expect(matchRule({ toolCalled: { name: 'download_save' } }, facts)).toBeNull();
    // Regex names, like lastTool.
    expect(
      matchRule({ toolCalled: { name: '^browser_(click|open)$', atLeast: 1 } }, facts),
    ).not.toBeNull();
  });

  it('combines conditions with anyOf and not, and tests images and trailing results', () => {
    expect(
      matchRule({ anyOf: [{ lastUser: 'nada' }, { lastUser: 'vida (?<what>laboral)' }] }, facts),
    ).toEqual({
      what: 'laboral',
    });
    expect(matchRule({ anyOf: [{ lastUser: 'nada' }, { turn: 99 }] }, facts)).toBeNull();
    expect(matchRule({ not: { systemPrompt: 'answerer' } }, facts)).toEqual({});
    expect(matchRule({ not: { systemPrompt: 'procedure agents' } }, facts)).toBeNull();
    expect(matchRule({ hasImage: false }, facts)).not.toBeNull();
    expect(matchRule({ hasImage: true }, facts)).toBeNull();
    expect(matchRule({ lastToolResultNot: 'error' }, facts)).not.toBeNull();
    expect(matchRule({ lastToolResultNot: 'DNI' }, facts)).toBeNull();
  });

  it('keeps the old matchers working', () => {
    expect(
      matchRule({ lastTool: 'browser_snapshot', lastToolResult: 'ref=(?<r>e30)' }, facts),
    ).toEqual({
      r: 'e30',
    });
    expect(matchRule({ hasTool: 'browser_click' }, facts)).toEqual({});
  });

  it('validates the new fields', () => {
    expect(() =>
      parseScenario({ rules: [{ when: { toolCalled: { atLeast: 1 } }, reply: {} }] }),
    ).toThrow();
    expect(() => parseScenario({ rules: [{ when: { anyOf: [] }, reply: {} }] })).toThrow();
    expect(
      parseScenario({
        rules: [
          {
            when: { not: { anyOf: [{ hasImage: true }] }, state: { a: null } },
            set: { a: 'x' },
            reply: {},
          },
        ],
      }).rules,
    ).toHaveLength(1);
  });
});

describe('scenario state and history captures through the server', () => {
  let llm: MockLlm;
  beforeEach(async () => {
    llm = await createMockLlm({ scenario: { rules: [] } });
  });
  afterEach(async () => {
    await llm.close();
  });

  it('feeds a value seen three turns ago into a tool argument', async () => {
    llm.setScenario({
      rules: [
        {
          when: {
            toolCalled: { name: 'browser_snapshot', result: 'ref=(?<loginRef>e\\d+)' },
            lastTool: 'browser_snapshot',
          },
          reply: { toolCalls: [{ name: 'browser_click', arguments: { ref: '{{loginRef}}' } }] },
        },
      ],
      fallback: { text: 'nothing' },
    });
    const res = await chat(
      llm,
      [
        user('go'),
        assistantCall('c1', 'browser_snapshot', {}),
        toolResult('c1', 'button "Login" [ref=e7]'),
        assistantCall('c2', 'browser_snapshot', {}),
        toolResult('c2', 'the same page, nothing to see'),
      ],
      { stream: false },
    );
    const body = (await res.json()) as {
      choices: { message: { tool_calls: { function: { arguments: string } }[] } }[];
    };
    // The most recent matching call has no ref, so the rule does not match: the capture must
    // come from a call that matches `result`, wherever it is in the history.
    expect(JSON.parse(body.choices[0]!.message.tool_calls[0]!.function.arguments)).toEqual({
      ref: 'e7',
    });
  });

  it('runs a multi-step script with state, and reset() clears it', async () => {
    llm.setScenario({
      rules: [
        { when: { state: { phase: 'two' } }, reply: { text: 'second' }, set: { phase: null } },
        { when: { state: { phase: 'one' } }, reply: { text: 'first' }, set: { phase: 'two' } },
        { when: { state: { phase: null } }, reply: { text: 'start' }, set: { phase: 'one' } },
      ],
    });
    const texts: string[] = [];
    for (let i = 0; i < 4; i++) texts.push(await chatText(await chat(llm, [user('x')])));
    expect(texts).toEqual(['start', 'first', 'second', 'start']);
    expect(llm.state()).toEqual({ phase: 'one' });
    llm.reset();
    expect(llm.state()).toEqual({});
    expect(await chatText(await chat(llm, [user('x')]))).toBe('start');
  });

  it('tells agents apart by system prompt', async () => {
    llm.setScenario({
      rules: [
        { when: { systemPrompt: 'simulate a human user' }, reply: { text: '{"reply":"hola"}' } },
        { when: { systemPrompt: 'procedure agent' }, reply: { text: 'procedure' } },
      ],
      fallback: { text: 'other' },
    });
    const ask = async (system: string) =>
      chatText(await chat(llm, [{ role: 'system', content: system }, user('x')]));
    expect(await ask('You simulate a human user.')).toBe('{"reply":"hola"}');
    expect(await ask('You are a procedure agent.')).toBe('procedure');
    expect(await ask('Something else')).toBe('other');
  });
});

describe('template filters', () => {
  const tags = (text: string) =>
    [...text].map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join('');

  it('untag turns Unicode tag characters into the ASCII they stand for and leaves the rest', () => {
    const vars = {
      hidden: `${tags('https://a.example/x?y=1')}`,
      plain: 'visible ñ',
      mixed: `ab${tags('cd')}`,
    };
    expect(renderTemplate('{{hidden|untag}}', vars)).toBe('https://a.example/x?y=1');
    expect(renderTemplate('{{ plain | untag }} / {{mixed|untag}}', vars)).toBe('visible ñ / abcd');
    expect(renderTemplate('{{hidden}}', vars)).toBe(vars.hidden);
    expect(renderTemplate('{{missing|untag}}|', vars)).toBe('|');
  });

  it('an unknown filter is an error, not an empty string', () => {
    expect(() => renderTemplate('{{a|rot13}}', { a: 'x' })).toThrow(
      /Unknown template filter "rot13"/,
    );
  });

  it('works in tool-call arguments through a rule that captures a run of tags', () => {
    const scenario = parseScenario({
      rules: [
        {
          when: { lastToolResult: '(?<hidden>(?:\\uDB40[\\uDC21-\\uDC7E])+)' },
          reply: { toolCalls: [{ name: 'fetch_url', arguments: { url: '{{hidden|untag}}' } }] },
        },
      ],
    });
    const facts = analyzeRequest({
      messages: [
        user('hola'),
        assistantCall('c1', 'browser_open', {}),
        toolResult('c1', `Informe de vida laboral${tags('https://a.example/verificar?naf=1')} fin`),
      ],
    });
    const captures = matchRule(scenario.rules[0]?.when ?? {}, facts);
    expect(captures).not.toBeNull();
    expect(renderValue(scenario.rules[0]?.reply.toolCalls?.[0]?.arguments, captures ?? {})).toEqual(
      {
        url: 'https://a.example/verificar?naf=1',
      },
    );
  });
});
