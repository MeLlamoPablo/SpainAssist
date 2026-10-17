/**
 * Live progress of `eval run`: the run's own `events.jsonl` is followed while it is written and a
 * line per notable observation goes to stderr. Only names and counts are shown (the tool, the
 * prompt's title): never arguments, message texts or anything a user typed.
 */
import { join } from 'node:path';
import type { Observation } from '../contracts';
import { followJsonl } from '../run/app/jsonl-follow';
import { elapsed } from './format';

const NOTE_LIMIT = 160;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The line for an observation, or undefined for the ones that are noise (network, messages...). */
function describeObservation(observation: Observation): string | undefined {
  switch (observation.type) {
    case 'tool_start': {
      const who =
        observation.agent === 'procedure'
          ? `procedure${observation.procedureId ? ` ${observation.procedureId}` : ''}`
          : 'assistant';
      return `${who}: ${observation.tool}`;
    }
    case 'prompt_shown':
      return `prompt (${observation.prompt.kind}): ${observation.prompt.title}`;
    case 'prompt_answered':
      return `prompt answered (${observation.by})`;
    case 'bench': {
      const data = (observation.data ?? {}) as Record<string, unknown>;
      const where = [text(data.host), text(data.path) || text(data.url)].join('').trim();
      const what = observation.what.replace('_', ' ');
      return `SpainBench: ${what}${where ? ` ${where}` : ''}`;
    }
    case 'quiescent':
      return 'the agents are quiet';
    case 'note': {
      const note = observation.text.replace(/\s+/g, ' ').trim();
      return `note: ${note.length > NOTE_LIMIT ? `${note.slice(0, NOTE_LIMIT - 1)}…` : note}`;
    }
    default:
      return undefined;
  }
}

interface RunProgress {
  /** Delivers what is left and stops following. */
  stop(): Promise<void>;
}

/**
 * Follows `<runDir>/events.jsonl` (it does not exist yet when the run starts) and writes a
 * `[+12 s] line` per observation made since `startedAt` (a resumed run's copied prefix is older).
 */
export function followRunProgress(options: {
  runDir: string;
  startedAt: Date;
  now: () => Date;
  write: (line: string) => void;
}): RunProgress {
  const follower = followJsonl(
    join(options.runDir, 'events.jsonl'),
    (value) => {
      const observation = value as Observation;
      if (typeof observation?.type !== 'string') return;
      const parsed = Date.parse(observation.t);
      if (!Number.isNaN(parsed) && parsed < options.startedAt.getTime()) return;
      const line = describeObservation(observation);
      if (line === undefined) return;
      const at = Number.isNaN(parsed) ? options.now().getTime() : parsed;
      options.write(`[+${elapsed(at - options.startedAt.getTime())}] ${line}\n`);
    },
    { intervalMs: 250 },
  );
  return { stop: () => follower.stop() };
}
