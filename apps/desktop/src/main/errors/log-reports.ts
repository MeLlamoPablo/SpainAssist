import type { LogEntry, LogLevel, LogSink } from '../core/logger';

/** A `warn` or `error` line of the main logger, as an error report. */
export interface LogReport {
  level: 'warning' | 'error';
  /** The line without its time and level: `[scope] message {data}`, already redacted. */
  message: string;
  /** GlitchTip groups reports by scope and message, never by the data (ids, paths, errors). */
  fingerprint: string[];
  scope?: string;
}

/** Lines kept while the gate is unknown (flags load after `ready`): startup warnings. */
const MAX_PENDING = 50;
/** Reports per scope and message in one run: a line in a loop must not flood GlitchTip. */
const MAX_PER_MESSAGE = 5;
/** Reports from lines in one run, all messages together. */
const MAX_PER_RUN = 100;

/**
 * Turns every `warn` and `error` line of the main logger into a report: anything that went wrong
 * and was caught, which the SDK's handlers of uncaught errors never see (a failed update check,
 * a failed agent run, a browser error). Lines come redacted and masked by the logger, and `send`
 * scrubs them again (`scrubReport`).
 *
 * Lines logged before `open` (the gate isn't known yet) wait, up to MAX_PENDING, and go out when
 * it opens; `send` still drops them if the gate says no.
 */
export function createLogReporter(send: (report: LogReport) => void): {
  sink: LogSink;
  open(): void;
} {
  let opened = false;
  const pending: LogReport[] = [];
  const perMessage = new Map<string, number>();
  let sent = 0;

  const deliver = (report: LogReport) => {
    const key = report.fingerprint.join('\n');
    const count = perMessage.get(key) ?? 0;
    if (count >= MAX_PER_MESSAGE || sent >= MAX_PER_RUN) return;
    perMessage.set(key, count + 1);
    sent += 1;
    send(report);
  };

  return {
    sink(line: string, level: LogLevel, entry: LogEntry) {
      if (level !== 'warn' && level !== 'error') return;
      const report: LogReport = {
        level: level === 'error' ? 'error' : 'warning',
        message: line.replace(/^\S+ \S+\s+/, ''),
        fingerprint: ['log', entry.scope ?? '', entry.msg],
        ...(entry.scope ? { scope: entry.scope } : {}),
      };
      if (opened) deliver(report);
      else if (pending.length < MAX_PENDING) pending.push(report);
    },
    open() {
      opened = true;
      for (const report of pending.splice(0)) deliver(report);
    },
  };
}
