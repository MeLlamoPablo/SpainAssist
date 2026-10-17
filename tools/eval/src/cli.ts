/**
 * The `eval` command: `corepack pnpm eval <command>` (from the repo root or from tools/eval).
 * Everything is in `src/cli/`; this entry only hands the real process to `main` and sets the exit
 * code. Run with `node --import tsx` (the `tsx` command is a process in between, and it breaks
 * with long temp-folder paths on some machines).
 */
import { main } from './cli/main';
import { ensureLoopbackNoProxy } from './net/proxy-env';

// First of all: the keys this process sends to loopback services never go to an environment proxy.
ensureLoopbackNoProxy();

// `eval list | head` closes the pipe early: that is not an error of ours.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

const code = await main(process.argv.slice(2));
process.exitCode = code;
// Whatever a command left running (a keep-alive socket, a timer) must not hold the process open.
setTimeout(() => process.exit(code), 3_000).unref();
