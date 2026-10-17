/**
 * A stand-in for the harness process, run by `launcher.test.ts` through tsx: it starts the fake
 * SpainBench of the folder it is given, says `READY <pid>` and then behaves as `mode` says, so the
 * test can check that the server never outlives it.
 *
 *   exit      exits at once, without stopping the server
 *   wait      waits to be signalled
 *   graceful  waits, and has a SIGTERM handler of its own (which must run, and decide)
 *   keep      asks for `keepOnSignal` and handles SIGINT itself: it says whether the server was
 *             still there after the signal (`SERVER_ALIVE yes|no`), stops it and exits 0
 *   keep-bare as `keep`, with no handler of its own (the signal must still kill both)
 */
import { join } from 'node:path';
import { startBench } from '../../src/bench';

const [dir, mode] = process.argv.slice(2) as [string, string];
const bench = await startBench({
  dir,
  logFile: join(dir, 'bench.log'),
  env: { FAKE_BENCH: 'ok' },
  ...(mode === 'keep' || mode === 'keep-bare' ? { keepOnSignal: true } : {}),
});
console.log(`READY ${bench.pid}`);

if (mode === 'exit') process.exit(0);
if (mode === 'keep') {
  process.once('SIGINT', () => {
    setTimeout(async () => {
      let alive = true;
      try {
        process.kill(bench.pid, 0);
      } catch {
        alive = false;
      }
      console.log(`SERVER_ALIVE ${alive ? 'yes' : 'no'}`);
      await bench.stop();
      process.exit(0);
    }, 300);
  });
}
if (mode === 'graceful') {
  process.on('SIGTERM', () => {
    console.log('GRACEFUL');
    setTimeout(() => process.exit(0), 50);
  });
}
setInterval(() => undefined, 1_000);
