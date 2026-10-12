import { describe, expect, it } from 'vitest';
import { AgentAuthor, agentAuthor, HUMAN_AUTHOR } from '../src/services';

describe('feedback authors', () => {
  it('formats agents as "<model id> · <reasoning level>"', () => {
    expect(agentAuthor('gpt-6-luna', 'high')).toBe('gpt-6-luna · high');
    expect(agentAuthor('anthropic/claude-haiku-5.5', 'medium')).toBe(
      'anthropic/claude-haiku-5.5 · medium',
    );
    expect(agentAuthor('llama3.1:8b', 'off')).toBe('llama3.1:8b · off');
  });

  it('makes any model id valid', () => {
    for (const id of ['My Model <v2>', ' -weird ', '', 'x'.repeat(300), 'modelo ñ']) {
      const author = agentAuthor(id, 'low');
      expect(AgentAuthor.safeParse(author).success, author).toBe(true);
    }
    expect(agentAuthor('My Model <v2>', 'low')).toBe('My-Model-v2- · low');
  });

  it('accepts only agent authors', () => {
    expect(AgentAuthor.safeParse(HUMAN_AUTHOR).success).toBe(false);
    expect(AgentAuthor.safeParse('gpt-6-luna').success).toBe(false);
    expect(AgentAuthor.safeParse('gpt-6-luna · max').success).toBe(false);
    expect(AgentAuthor.safeParse('gpt 6 · high').success).toBe(false);
  });
});
