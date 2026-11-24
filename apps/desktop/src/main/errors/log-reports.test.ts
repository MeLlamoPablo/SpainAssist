import { describe, expect, it } from 'vitest';
import { createLogger } from '../core/logger';
import { createLogReporter, type LogReport } from './log-reports';

/** A logger whose lines go to a log reporter, and the reports it sent. */
function reportingLogger() {
  const sent: LogReport[] = [];
  const reporter = createLogReporter((report) => sent.push(report));
  const logger = createLogger({ level: 'debug', sinks: [reporter.sink] });
  return { logger, sent, open: () => reporter.open() };
}

describe('log reports', () => {
  it('reports warnings and errors, grouped by scope and message, never debug or info', () => {
    const { logger, sent, open } = reportingLogger();
    open();
    const updates = logger.child('updates');
    updates.debug('checking');
    updates.info('up to date');
    updates.warn('update failed', { error: 'ENOENT: app-update.yml' });
    logger.error('startup failed', { error: 'boom' });

    expect(sent).toEqual([
      {
        level: 'warning',
        message: '[updates] update failed {"error":"ENOENT: app-update.yml"}',
        fingerprint: ['log', 'updates', 'update failed'],
        scope: 'updates',
      },
      {
        level: 'error',
        message: 'startup failed {"error":"boom"}',
        fingerprint: ['log', '', 'startup failed'],
      },
    ]);
  });

  it('keeps the lines logged before the gate is known and sends them when it opens', () => {
    const { logger, sent, open } = reportingLogger();
    logger.warn('SA_MAPS_SERVER_URL is not a URL');
    expect(sent).toEqual([]);

    open();
    expect(sent.map((r) => r.message)).toEqual(['SA_MAPS_SERVER_URL is not a URL']);
  });

  it('sends the redacted line, never user content or secrets', () => {
    const { logger, sent, open } = reportingLogger();
    open();
    logger.addSecret('super-secret-password');
    logger.error('typed super-secret-password', { password: 'hunter2', procedureId: 'p_1' });

    const [report] = sent;
    expect(report?.message).not.toContain('super-secret-password');
    expect(report?.message).not.toContain('hunter2');
    expect(report?.message).toContain('p_1');
  });

  it('sends a few reports per message, so a line in a loop doesn’t flood GlitchTip', () => {
    const { logger, sent, open } = reportingLogger();
    open();
    for (let i = 0; i < 20; i++) logger.warn('page script error', { attempt: i });
    logger.warn('another warning');

    expect(sent.filter((r) => r.fingerprint.includes('page script error'))).toHaveLength(5);
    expect(sent.at(-1)?.message).toBe('another warning');
  });
});
