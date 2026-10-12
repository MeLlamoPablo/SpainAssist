import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const options = { skip: process.platform !== 'darwin', timeout: 20000 };

// Mirrors the handshake in src/main/index.ts: the first line is the environment, and a closed
// socket means the launcher is gone.
const probeSource = `
  const {app} = require('electron');
  const socketPath = process.argv.find(arg => arg.startsWith('--sa-dev-launch-socket=')).split('=')[1];
  const socket = require('node:net').createConnection(socketPath);
  let received = '';
  socket.setEncoding('utf8');
  socket.on('close', () => app.quit());
  socket.on('data', chunk => {
    received += chunk;
    const end = received.indexOf('\\n');
    if (end === -1) return;
    Object.assign(process.env, JSON.parse(received.slice(0, end)));
    require('node:fs').writeFileSync(process.env.SA_DEV_LAUNCH_PID_FILE, String(process.pid));
    app.whenReady().then(() => {
      console.log('launch-probe-pid=' + process.pid);
      console.log('launch-probe-ready=' + process.env.SA_LAUNCH_TEST_MARKER);
      console.error('launch-probe-stderr');
    });
  });
`;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition, ms) {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return condition();
}

async function withLaunchedProbe(run) {
  const directory = await mkdtemp(join(tmpdir(), 'sa-launch-test-'));
  const probe = join(directory, 'main.cjs');
  await writeFile(probe, probeSource);
  const env = {
    ...process.env,
    SA_DEV_ELECTRON_BINARY: require('electron'),
    SA_LAUNCH_TEST_MARKER: 'forwarded',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./launch-electron-mac.mjs', import.meta.url)), probe],
    { env },
  );
  const launched = { child, exit: once(child, 'exit'), output: '', errors: '', appPid: 0 };
  child.stdout.on('data', (chunk) => {
    launched.output += chunk;
    launched.appPid ||= Number(launched.output.match(/launch-probe-pid=(\d+)/)?.[1] ?? 0);
  });
  child.stderr.on('data', (chunk) => {
    launched.errors += chunk;
  });
  try {
    await waitFor(
      () => launched.output.includes('launch-probe-ready=forwarded') || child.exitCode !== null,
      10000,
    );
    assert.match(launched.output, /launch-probe-ready=forwarded/);
    await run(launched);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    // Never leave a probe app behind, whatever happened above.
    if (launched.appPid && !(await waitFor(() => !isAlive(launched.appPid), 5000)))
      process.kill(launched.appPid, 'SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
}

test('Launch Services forwards environment/logs and stops its native app', options, async () => {
  await withLaunchedProbe(async ({ child, exit, errors, appPid }) => {
    assert.match(errors, /launch-probe-stderr/);
    child.kill('SIGTERM');
    await exit;
    assert.ok(await waitFor(() => !isAlive(appPid), 5000), 'the app outlived its launcher');
  });
});

test('the native app quits when its launcher is killed outright', options, async () => {
  await withLaunchedProbe(async ({ child, exit, appPid }) => {
    child.kill('SIGKILL');
    await exit;
    assert.ok(await waitFor(() => !isAlive(appPid), 5000), 'the app outlived its launcher');
  });
});
