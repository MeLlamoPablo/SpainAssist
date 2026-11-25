import { describe, expect, it } from 'vitest';
import { findSpan, spanMatches } from '../src/lib/model';
import { span, trace } from './spans';

/** An agent whose codemode call `call_b411815f` started run `run_ee1e15a9605d8e8b`. */
function agentWithRun(name = 'Agent') {
  const tool = span('tool', 'codemode', 800, 900, [], {
    id: `${name}-tool`,
    toolCallId: 'call_b411815f',
    attrs: [
      ['Run', 'run_ee1e15a9605d8e8b'],
      ['Status', 'detached'],
    ],
  });
  return trace(span('agent', name, 0, 5_000, [span('turn', `${name}-turn`, 0, 5_000, [tool])]));
}

describe('search', () => {
  it('finds the codemode call of a run id, a tool call id or a part of either', () => {
    const agent = agentWithRun();
    for (const query of [
      'run_ee1e15a9605d8e8b',
      ' RUN_EE1E15A9605D8E8B ',
      'call_b411815f',
      'e15a96',
    ]) {
      expect(findSpan([agent], query)?.span.name, query).toBe('codemode');
    }
    expect(findSpan([agent], 'run_ee1e15a9605d8e8b')?.exact).toBe(true);
    expect(findSpan([agent], 'e15a96')?.exact).toBe(false);
  });

  it('prefers an exact id in a later trace to a partial match in an earlier one', () => {
    const earlier = trace(
      span('agent', 'Earlier', 0, 1_000, [], { detail: 'run_ee1e15a9605d8e8b-old' }),
    );
    const later = agentWithRun('Later');
    expect(findSpan([earlier, later], 'run_ee1e15a9605d8e8b')?.trace.id).toBe('Later');
  });

  it('finds nothing for an empty query or an id no span has', () => {
    const agent = agentWithRun();
    expect(findSpan([agent], '  ')).toBeUndefined();
    expect(findSpan([agent], 'run_0000')).toBeUndefined();
    expect(spanMatches(agent.root, '')).toBe(false);
  });
});
