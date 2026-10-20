import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUNDLED_MODEL_LISTS, type ModelLists, parseModelLists } from '../src/providers/defaults';

const FILE = new URL(
  '../../../models_warningUpdatingThisWillChangeItInAllClientsOnPushToMaster.json',
  import.meta.url,
);

const fallback: ModelLists = {
  chatgpt: {
    procedures: [{ id: 'fallback-procedures', thinkingLevel: 'medium' }],
    assistant: [{ id: 'fallback-assistant', thinkingLevel: 'high' }],
    scanner: [{ id: 'fallback-scanner', thinkingLevel: 'low' }],
    decider: 'fallback/chatgpt-decider',
    research: {
      fast: [{ id: 'fallback-fast', thinkingLevel: 'high' }],
      balanced: [{ id: 'fallback-balanced', thinkingLevel: 'high' }],
      deep: [{ id: 'fallback-deep', thinkingLevel: 'high' }],
    },
  },
  voucher: {
    procedures: [{ id: 'fallback/voucher', thinkingLevel: 'medium' }],
    assistant: [{ id: 'fallback/voucher-assistant', thinkingLevel: 'high' }],
    scanner: [{ id: 'fallback/voucher-scanner', thinkingLevel: 'low' }],
    decider: 'fallback/voucher-decider',
  },
};

describe('the models file', () => {
  it('is bundled whole: every entry of the repository file is read', () => {
    const json = JSON.parse(readFileSync(FILE, 'utf8'));
    const entries = (lists: ModelLists) =>
      [
        lists.chatgpt.procedures,
        lists.chatgpt.assistant,
        lists.chatgpt.scanner,
        ...Object.values(lists.chatgpt.research),
        lists.voucher.procedures,
        lists.voucher.assistant,
        lists.voucher.scanner,
      ].flat().length;
    const raw = [
      json.chatgpt.procedures,
      json.chatgpt.assistant,
      json.chatgpt.scanner,
      ...Object.values(json.chatgpt.research),
      json.voucher.procedures,
      json.voucher.assistant,
      json.voucher.scanner,
    ].flat().length;
    expect(parseModelLists(json)).toEqual(BUNDLED_MODEL_LISTS);
    expect(entries(BUNDLED_MODEL_LISTS)).toBe(raw);
  });

  it('reads "<id>:<level>", splitting at the last colon', () => {
    const lists = parseModelLists(
      {
        version: 1,
        chatgpt: {
          procedures: ['gpt-6.1-sol:high', 'gpt-5.6-terra:max'],
          scanner: ['gpt-6.1-sol:low', 'gpt-5.6-terra:off'],
          decider: '~perplexity/pplx-decider-flash-latest',
        },
        voucher: { procedures: ['meta-llama/llama-4:free:low'], decider: ' ' },
      },
      fallback,
    );
    expect(lists.chatgpt.procedures).toEqual([
      { id: 'gpt-6.1-sol', thinkingLevel: 'high' },
      { id: 'gpt-5.6-terra', thinkingLevel: 'max' },
    ]);
    expect(lists.chatgpt.scanner).toEqual([
      { id: 'gpt-6.1-sol', thinkingLevel: 'low' },
      { id: 'gpt-5.6-terra', thinkingLevel: 'off' },
    ]);
    expect(lists.voucher.procedures).toEqual([
      { id: 'meta-llama/llama-4:free', thinkingLevel: 'low' },
    ]);
    // A decider is a plain id, without a reasoning level; a blank one is the fallback's.
    expect(lists.chatgpt.decider).toBe('~perplexity/pplx-decider-flash-latest');
    expect(lists.voucher.decider).toBe(fallback.voucher.decider);
  });

  it('skips what an older app cannot read, and keeps the fallback for lists left empty', () => {
    const lists = parseModelLists(
      {
        version: 1,
        comment: 'unknown fields are ignored',
        chatgpt: {
          // A level this version does not know, no level, not a string, no id.
          procedures: ['gpt-7:ultra', 'gpt-6-luna', 42, ':high', 'gpt-6-luna:low'],
          assistant: ['gpt-7:ultra'],
          research: { fast: 'gpt-6-luna:high', deep: ['gpt-6-astra:high'] },
          newRole: ['gpt-6-luna:high'],
        },
      },
      fallback,
    );
    expect(lists).toEqual({
      chatgpt: {
        procedures: [{ id: 'gpt-6-luna', thinkingLevel: 'low' }],
        assistant: fallback.chatgpt.assistant,
        scanner: fallback.chatgpt.scanner,
        decider: fallback.chatgpt.decider,
        research: {
          fast: fallback.chatgpt.research.fast,
          balanced: fallback.chatgpt.research.balanced,
          deep: [{ id: 'gpt-6-astra', thinkingLevel: 'high' }],
        },
      },
      voucher: fallback.voucher,
    });
  });

  it('rejects another format version, and an incomplete file without a fallback', () => {
    expect(() => parseModelLists({ ...BUNDLED_MODEL_LISTS, version: 2 }, fallback)).toThrow(
      'version',
    );
    expect(() => parseModelLists('not json', fallback)).toThrow('version');
    expect(() => parseModelLists({ version: 1 })).toThrow('no valid model');
  });
});
