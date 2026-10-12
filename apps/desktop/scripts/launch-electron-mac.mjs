#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// electron-vite starts/kills this proxy as if it were the Electron executable.
// `open -W` remains alive until the application quits. Capture logs in private files
// because Launch Services does not inherit the terminal's standard streams.
const directory = mkdtempSync(join(tmpdir(), 'sa-dev-launch-'));
const pidFile = join(directory, 'pid');
const files = ['stdout', 'stderr'].map((name) => join(directory, name));
for (const file of files) writeFileSync(file, '', { mode: 0o600 });
const descriptors = files.map((file) => openSync(file, 'r'));
const positions = [0, 0];
const sinks = [process.stdout, process.stderr];
const env = { ...process.env, SA_DEV_LAUNCH_PID_FILE: pidFile };
delete env.ELECTRON_RUN_AS_NODE;
const bundle = resolve(dirname(env.SA_DEV_ELECTRON_BINARY), '../..');
// Transfer the environment through a private Unix socket, never command arguments or disk.
for (const name of Object.keys(env)) {
  if (name.startsWith('__CF') || name.startsWith('XPC_') || name === 'LaunchInstanceID')
    delete env[name];
}
// The connection then stays open as a lifeline: when this proxy dies for any reason (even
// SIGKILL), the kernel closes it and the app quits instead of lingering under launchd.
const socketPath = join(directory, 'environment.sock');
let lifeline;
const server = createServer((socket) => {
  lifeline = socket;
  socket.write(`${JSON.stringify(env)}\n`);
  server.close();
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(socketPath, resolve);
});
const child = spawn(
  '/usr/bin/open',
  [
    '-n',
    '-W',
    '-a',
    bundle,
    '--stdout',
    files[0],
    '--stderr',
    files[1],
    '--args',
    resolve(process.argv[2] ?? '.'),
    ...process.argv.slice(3),
    `--sa-dev-launch-socket=${socketPath}`,
  ],
  { env, stdio: 'inherit' },
);
const buffer = Buffer.alloc(64 * 1024);
function forwardLogs() {
  for (let i = 0; i < descriptors.length; i++) {
    while (true) {
      const count = readSync(descriptors[i], buffer, 0, buffer.length, positions[i]);
      if (count === 0) break;
      sinks[i].write(Buffer.from(buffer.subarray(0, count)));
      positions[i] += count;
    }
  }
}
let stopping = false;
function stop() {
  stopping = true;
  try {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM');
  } catch {
    // The app may still be starting. The polling loop retries once it reports its PID.
  }
}
const timer = setInterval(() => {
  forwardLogs();
  if (stopping) stop();
}, 100);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
function finish(code) {
  clearInterval(timer);
  server.close();
  lifeline?.destroy();
  forwardLogs();
  for (const descriptor of descriptors) closeSync(descriptor);
  rmSync(directory, { recursive: true, force: true });
  process.exitCode = code ?? 1;
}
child.on('error', (error) => {
  console.error(error);
  finish(1);
});
child.on('exit', finish);
