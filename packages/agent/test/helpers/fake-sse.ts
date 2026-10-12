import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout } from 'node:timers/promises';

/** Offline server-sent events fixture (the key server's research stream). */
export async function createFakeSse(options: {
  frames: (string | Uint8Array)[];
  delayMs?: number;
  keepOpen?: boolean;
  status?: number;
  contentType?: string;
}) {
  const requests: { headers: IncomingHttpHeaders; body: unknown; url: string }[] = [];
  let closedStreams = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', async () => {
      requests.push({ headers: req.headers, body: JSON.parse(raw), url: req.url ?? '' });
      res.on('close', () => {
        closedStreams++;
      });
      res.writeHead(options.status ?? 200, {
        'content-type': options.contentType ?? 'text/event-stream',
      });
      res.flushHeaders();
      for (const frame of options.frames) {
        await setTimeout(options.delayMs ?? 0);
        if (res.destroyed) return;
        res.write(frame);
      }
      if (!options.keepOpen) res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/research`,
    requests,
    get closedStreams() {
      return closedStreams;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
