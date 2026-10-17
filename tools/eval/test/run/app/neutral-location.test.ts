/**
 * What the agents can see of where they run, and what the run keeps of it. pi puts an agent's
 * working directory in its session (and may in its prompt), and the app keeps the agents'
 * documents there: it must be a place that says nothing about evaluation, the run or the fixture,
 * while the run folder still gets the profile it documents. And what the meter sees of the
 * requests: a registered secret anywhere in one is a leak the run reports.
 */
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { neutralLocations } from '../../../src/run/app/eval-app';
import { chatBody, post, userMessage } from '../../llm/helpers/meter-env';
import { expectNoEgress, prepareHostBundle, removeRunDir, startStack } from './support';

let host: Awaited<ReturnType<typeof prepareHostBundle>>;
beforeAll(async () => {
  host = await prepareHostBundle();
}, 180_000);
afterAll(() => host?.cleanup());
afterAll(expectNoEgress);

/** What nothing an agent can see may say. */
const TELLS = /eval|spainbench|run-app-test|runs[\\/]|mock|fixture/i;

describe('neutralLocations', () => {
  it('names the app’s folder like an app’s own, in the OS temporary directory', () => {
    const { root, userData, tmpRoot, exports } = neutralLocations('/var/tmp');
    expect(root).toMatch(/^\/var\/tmp\/sa-[0-9a-f]{12}$/);
    for (const dir of [userData, tmpRoot, exports]) expect(dir.startsWith(`${root}/`)).toBe(true);
    for (const dir of [root, userData, tmpRoot, exports])
      expect(dir.slice('/var/tmp'.length)).not.toMatch(TELLS);
    expect(neutralLocations().root.startsWith(join(tmpdir(), 'sa-'))).toBe(true);
    expect(neutralLocations().root).not.toBe(neutralLocations().root);
  });
});

describe('where the app runs', () => {
  it('is not the run folder: the agent’s working directory, its prompt and its tool list say nothing of the run', async () => {
    const stack = await startStack({
      hostBundle: host.bundle,
      scenario: { rules: [], fallback: { text: 'Hola.' } },
    });
    try {
      await stack.app.send('hola');
      expect(await stack.app.untilIdle({ timeoutMs: 60_000 })).toBe(true);

      // Everything the model was sent, system prompt, tools and messages: none of it names the run.
      const bodies = stack.llm.requests().map((request) => JSON.stringify(request.body));
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(body).not.toContain(stack.runDir);
        expect(body.match(TELLS)?.[0]).toBeUndefined();
      }
    } finally {
      await stack.close();
    }
    // pi's session of the agent says where it worked: in the neutral folder, not in the run's.
    const copied = readFileSync(
      join(stack.runDir, 'transcripts', 'assistant', 'session.jsonl'),
      'utf8',
    );
    const cwd = (JSON.parse(copied.split('\n')[0] ?? '{}') as { cwd?: string }).cwd ?? '';
    expect(cwd).toMatch(/\/sa-[0-9a-f]{12}\/data\/assistant\/work$/);
    expect(cwd).not.toContain(stack.runDir);
    expect(cwd.match(TELLS)).toBeNull();
    removeRunDir(stack.runDir);
  }, 120_000);

  it('leaves the run folder its documented profile, and nothing of the neutral folder behind', async () => {
    let userData = '';
    const stack = await startStack({
      hostBundle: host.bundle,
      scenario: { rules: [], fallback: { text: 'Hola.' } },
      internals: {
        onApp: (app) => {
          userData = app.paths.userData;
        },
      },
    });
    try {
      await stack.app.send('hola');
      expect(await stack.app.untilIdle({ timeoutMs: 60_000 })).toBe(true);
      // While the app runs it lives in the neutral folder, and the run's own profile is not written yet.
      expect(userData).toMatch(/\/sa-[0-9a-f]{12}\/data$/);
      expect(existsSync(join(userData, 'vault'))).toBe(true);
      expect(existsSync(join(stack.runDir, 'profile'))).toBe(false);
    } finally {
      await stack.close();
    }
    const profile = join(stack.runDir, 'profile');
    expect(existsSync(join(profile, 'vault'))).toBe(true);
    expect(existsSync(join(profile, 'assistant', 'session.jsonl'))).toBe(true);
    expect(existsSync(join(profile, 'logs'))).toBe(false);
    // The neutral folder is gone.
    expect(existsSync(dirname(userData))).toBe(false);
    removeRunDir(stack.runDir);
  }, 120_000);

  it('copies the profile into the run folder at a checkpoint too', async () => {
    const stack = await startStack({
      hostBundle: host.bundle,
      scenario: { rules: [], fallback: { text: 'Hola.' } },
    });
    try {
      await stack.app.send('hola');
      expect(await stack.app.untilIdle({ timeoutMs: 60_000 })).toBe(true);
      const dir = join(stack.runDir, 'checkpoints', '1', 'app');
      const taken = await stack.app.checkpoint(dir);
      expect(taken.profileDir).toBe(join(dir, 'profile'));
      expect(existsSync(join(taken.profileDir, 'vault'))).toBe(true);
      expect(existsSync(join(stack.runDir, 'profile', 'vault'))).toBe(true);
      expect(existsSync(join(stack.runDir, 'profile', 'assistant', 'session.jsonl'))).toBe(true);
    } finally {
      await stack.close();
    }
    removeRunDir(stack.runDir);
  }, 120_000);
});

describe('what the meter sees', () => {
  it('reports a registered secret in a model request as a leak, without the secret', async () => {
    const stack = await startStack({
      hostBundle: host.bundle,
      scenario: { rules: [], fallback: { text: 'Hola.' } },
    });
    try {
      const password = 'Clave-Secreta-2026';
      await stack.app.addClave({ username: '53918274H', password, label: 'Cl@ve' });
      expect(stack.app.secretLeaks()).toEqual([]);
      // As a product regression would: the saved password in a message the model is sent.
      await post(
        stack.run,
        'procedure-p_regression',
        chatBody([userMessage(`mi clave: ${password}`)]),
      );
      const leaks = stack.app.secretLeaks();
      expect(leaks).toHaveLength(1);
      expect(leaks[0]).toContain('model request of procedure-p_regression');
      expect(leaks[0]).toContain('(plain)');
      expect(leaks[0]).not.toContain(password);
      expect(
        stack
          .of('note')
          .map((note) => note.text)
          .filter((text) => text.includes('registered secret')),
      ).toEqual([
        'model request of procedure-p_regression (/v1/chat/completions): a registered secret is in the request body (plain)',
      ]);
      expect(JSON.stringify(stack.observations())).not.toContain(password);
    } finally {
      await stack.close();
    }
    removeRunDir(stack.runDir);
  }, 120_000);
});
