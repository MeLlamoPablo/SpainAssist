import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostEvalConfig, ResearchAnswer } from '../../src/contracts';
import { WORLD_ROUTES } from './fake-world';

const fixturePath = join(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'research',
  'vida-laboral.json',
);

interface ResearchRecording {
  run: { id: string };
  output: ResearchAnswer['output'];
}

/** The recorded research answer of the vida laboral fixtures, as the run loop hands it over. */
export function recordedAnswer(): ResearchAnswer {
  const recording = JSON.parse(readFileSync(fixturePath, 'utf8')) as ResearchRecording;
  return { id: recording.run.id, output: recording.output };
}

/** A valid config for a world listening at `mockOrigin`. */
export function hostConfig(
  mockOrigin: string,
  netlog: string,
  over: Partial<HostEvalConfig> = {},
): HostEvalConfig {
  return {
    worldId: 'run-host-test',
    mockOrigin,
    // Never connected to: any other loopback port will do.
    scoringOrigin: 'http://127.0.0.1:1',
    routes: WORLD_ROUTES,
    unmapped: { mode: 'enotfound' },
    netlog,
    llm: { extraAllowOrigins: [] },
    research: { shape: 'auto', answers: [recordedAnswer()] },
    now: '2026-03-14T09:30:00+01:00',
    ...over,
  };
}
