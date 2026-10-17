import { scrubPii } from '@sa/pii';
import { describe, expect, it } from 'vitest';
import { scrubReport } from './scrub';

describe('scrubReport', () => {
  const opts = { homeDir: '/Users/lucia', scrubPii };

  it('drops user, request, breadcrumbs and machine fields', () => {
    const out = scrubReport(
      {
        event_id: 'a'.repeat(32),
        user: { ip_address: '1.2.3.4' },
        request: { url: 'app://bundle/index.html#/tramites/1' },
        breadcrumbs: [{ message: 'click' }],
        server_name: 'Lucias-MacBook',
        modules: { react: '19' },
        level: 'error',
      },
      opts,
    );
    expect(out).toEqual({ event_id: 'a'.repeat(32), level: 'error' });
  });

  it('removes the home folder and Spanish PII from every string, keys included', () => {
    const out = scrubReport(
      {
        release: 'spain-assist@1.0.0',
        exception: {
          values: [
            {
              type: 'Error',
              value:
                'No se pudo leer C:\\Users\\lucia\\Documents\\12345678Z.pdf de lucia@example.com',
              stacktrace: { frames: [{ filename: 'C:/Users/lucia/app.js', lineno: 3 }] },
            },
          ],
        },
        extra: { '12345678Z': 'ES9121000418450200051332' },
      },
      { ...opts, homeDir: 'C:\\Users\\lucia' },
    );
    const json = JSON.stringify(out);
    expect(json).not.toContain('lucia');
    expect(json).not.toContain('12345678Z');
    expect(json).not.toContain('ES9121000418450200051332');
    expect(out.release).toBe('spain-assist@1.0.0');
    expect(out.exception.values[0]?.stacktrace.frames[0]).toEqual({
      filename: '~/app.js',
      lineno: 3,
    });
  });
});
