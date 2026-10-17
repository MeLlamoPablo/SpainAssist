import './no-network';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type LockOptions, withFileLock } from '../../../src/llm/lock';

/**
 * A contender for the refresh lock, as its own process (the lock must hold across processes).
 * The parent drives it over IPC: `round` waits for a shared start time and then takes the lock,
 * checking that nobody else is inside; `hold` takes the lock and never lets go (the parent
 * SIGKILLs it, which leaves a lock behind whose owner is really dead).
 */

type Command =
  | { type: 'round'; lockDir: string; probeDir: string; startAt: number; options?: LockOptions }
  | { type: 'hold'; lockDir: string }
  | { type: 'exit' };

export interface RoundReport {
  type: 'done';
  entries: number;
  overlaps: number;
  errors: string[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function round(command: Extract<Command, { type: 'round' }>): Promise<RoundReport> {
  const report: RoundReport = { type: 'done', entries: 0, overlaps: 0, errors: [] };
  await sleep(Math.max(0, command.startAt - Date.now()));
  try {
    await withFileLock(
      command.lockDir,
      async () => {
        report.entries++;
        // One marker per holder: two holders at the same time see each other's.
        mkdirSync(command.probeDir, { recursive: true });
        const marker = join(command.probeDir, String(process.pid));
        writeFileSync(marker, '');
        if (readdirSync(command.probeDir).length > 1) report.overlaps++;
        await sleep(3);
        if (readdirSync(command.probeDir).length > 1) report.overlaps++;
        rmSync(marker, { force: true });
      },
      command.options,
    );
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    report.errors.push(`${code ?? 'error'}: ${message}`);
  }
  return report;
}

process.on('message', (command: Command) => {
  if (command.type === 'exit') process.exit(0);
  if (command.type === 'hold') {
    void withFileLock(command.lockDir, () => {
      process.send?.({ type: 'held' });
      return new Promise<never>(() => {});
    });
    return;
  }
  void round(command).then((report) => process.send?.(report));
});
process.send?.({ type: 'ready' });
