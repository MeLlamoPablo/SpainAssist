import type { BenchWrongTurn, Fixture, MeterUsage, RuleOutcome, RunResult } from '../contracts';
import { replayLine } from './result';
import { resolveScoring, ruleWeight } from './score';

export interface ReportContext {
  /** Adds the fixture's title and the description and weight of every rule. */
  fixture?: Pick<Fixture, 'title' | 'rules' | 'preconditions' | 'scoring'>;
  /** The wrong turns of SpainBench's final state, listed under the table. */
  wrongTurnItems?: readonly BenchWrongTurn[];
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function percent(score: number): string {
  return `${(Math.round(score * 1000) / 10).toFixed(1)}%`;
}

function duration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

function scoreLine(result: RunResult): string {
  if (result.score === null) return `not scored (${result.status})`;
  if (result.status === 'failed_required') return '**0.0%** (a required rule failed)';
  const lost = (result.scoreBeforePenalty ?? result.score) - result.score;
  const penalty =
    lost > 0
      ? `, ${percent(result.scoreBeforePenalty ?? result.score)} before ${
          result.wrongTurns
        } wrong turn(s) took ${percent(lost)}`
      : '';
  return `**${percent(result.score)}**${penalty}`;
}

function kindLabel(outcome: RuleOutcome): string {
  return `${outcome.kind}${outcome.negate ? ' (negated)' : ''}`;
}

function resultLabel(outcome: RuleOutcome, unsettled: ReadonlySet<string>): string {
  if (outcome.kind === 'scored') return outcome.passed ? 'earned' : 'lost';
  if (unsettled.has(outcome.ruleId)) return 'pass (not tested to the end)';
  return outcome.passed ? 'pass' : 'FAIL';
}

function ruleTable(
  outcomes: readonly RuleOutcome[],
  describe: Map<string, { description: string; weight?: number }>,
  unsettled: ReadonlySet<string> = new Set(),
): string[] {
  const lines = [
    '| Rule | Kind | Weight | Result | First seen | Detail |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const outcome of outcomes) {
    const info = describe.get(outcome.ruleId);
    const name = info
      ? `\`${outcome.ruleId}\`: ${cell(info.description)}`
      : `\`${outcome.ruleId}\``;
    const weight = outcome.kind === 'scored' ? String(info?.weight ?? 1) : '-';
    const seen = outcome.firstSeenAtSeq !== undefined ? `#${outcome.firstSeenAtSeq}` : '-';
    lines.push(
      `| ${name} | ${kindLabel(outcome)} | ${weight} | ${resultLabel(outcome, unsettled)} | ${seen} | ${cell(outcome.detail ?? '')} |`,
    );
  }
  return lines;
}

function usageLine(usage: MeterUsage): string {
  const n = (value: number) => value.toLocaleString('en-US');
  return [
    `${n(usage.requests)} request(s), ${n(usage.cacheHits)} from the cache`,
    `${n(usage.inputTokens)} input tokens (${n(usage.cachedInputTokens)} cached, ${n(usage.cacheWriteTokens)} cache writes)`,
    `${n(usage.outputTokens)} output tokens (${n(usage.reasoningTokens)} reasoning)`,
    `$${usage.costUsd.toFixed(4)}`,
  ].join('; ');
}

/**
 * A human-readable report of a run in Markdown: the score, a table of the rules with their
 * outcome, the preconditions, the wrong turns, usage and notes. Deterministic for a given input.
 */
export function renderReport(result: RunResult, context: ReportContext = {}): string {
  const { fixture } = context;
  const describe = new Map<string, { description: string; weight?: number }>();
  for (const rule of [...(fixture?.rules ?? []), ...(fixture?.preconditions ?? [])]) {
    describe.set(rule.id, {
      description: rule.description,
      weight: rule.kind === 'scored' ? ruleWeight(rule) : undefined,
    });
  }

  const unsettled = new Set(result.unsettledNegated ?? []);
  const lines: string[] = [
    `# SpainBench run: ${result.fixtureId}${fixture ? ` (${cell(fixture.title)})` : ''}`,
    '',
    `- Run: \`${result.runId}\``,
    `- Provider: ${result.provider}`,
    `- Status: **${result.status}**`,
    `- Score: ${scoreLine(result)}`,
    `- Ended by: ${result.endedBy}`,
    ...(unsettled.size > 0
      ? [
          `- **Cut short:** the run ended (${result.endedBy}) while the agents could still act, so ${[
            ...unsettled,
          ]
            .map((id) => `\`${id}\``)
            .join(', ')} only did not match yet: this is not proof that they hold`,
        ]
      : []),
    `- Duration: ${duration(result.durationMs)}`,
    '',
    '## Rules',
    '',
    ...ruleTable(result.rules, describe, unsettled),
  ];

  if (result.preconditions && result.preconditions.length > 0) {
    lines.push('', '## Preconditions', '', ...ruleTable(result.preconditions, describe));
  }

  const config = resolveScoring(fixture?.scoring);
  lines.push('', `## Wrong turns: ${result.wrongTurns}`, '');
  if (result.wrongTurns === 0) {
    lines.push('None.');
  } else {
    lines.push(
      `Each costs ${percent(config.wrongTurnPenalty)}, up to ${percent(config.wrongTurnPenaltyCap)} in total.`,
    );
    const items = context.wrongTurnItems ?? [];
    if (items.length > 0) {
      lines.push('', '| Seq | Host | Path | Kind | Reason |', '| --- | --- | --- | --- | --- |');
      for (const item of items) {
        lines.push(
          `| ${item.seq} | ${cell(item.host)} | ${cell(item.path)} | ${item.kind} | ${cell(item.reason ?? '')} |`,
        );
      }
    }
  }

  lines.push('', '## Usage', '', usageLine(result.usage));
  const replayed = replayLine(result.usage);
  if (replayed) {
    lines.push(
      '',
      `**${replayed}.** Those answers were recorded in earlier runs, so this verdict is not a fresh sample of the model; a loose one was recorded for a conversation whose pages or screenshots differed (see the ledger, \`llm/meter.jsonl\`).`,
    );
  }

  if (result.notes.length > 0) {
    lines.push('', '## Notes', '', ...result.notes.map((note) => `- ${cell(note)}`));
  }
  return `${lines.join('\n')}\n`;
}
