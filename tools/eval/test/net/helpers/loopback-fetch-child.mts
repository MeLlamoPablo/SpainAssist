/**
 * A process with an environment proxy that sends a request with a secret to a loopback server:
 * what the harness does with the answerer's key and the scoring token. Run by proxy-env.test.ts
 * with `node --import tsx`. Prints what the request reached.
 */
import http from 'node:http';
import { ensureLoopbackNoProxy } from '../../../src/net/proxy-env';

if (process.argv[2] === 'guarded') ensureLoopbackNoProxy();

const server = http.createServer((req, res) => {
  res.end(`target ${req.headers.authorization}`);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as { port: number };
try {
  const response = await fetch(`http://127.0.0.1:${port}/key`, {
    headers: { authorization: 'Bearer voucher-key' },
  });
  console.log(`status ${response.status}: ${await response.text()}`);
} catch (error) {
  console.log(`failed: ${(error as { cause?: { message?: string } }).cause?.message ?? error}`);
}
server.close();
process.exit(0);
