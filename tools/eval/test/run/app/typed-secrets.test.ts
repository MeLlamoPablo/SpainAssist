/**
 * Secrets in a run: a password the user types goes to the page and nowhere else; one that reaches
 * the model, a script or a stranger is found by `secretLeaks()`, and no file of the run keeps it
 * (the browser's recording, which the run asks for, is the one place that does, and says so).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLAVE_PASSWORD } from '../../../src/fixtures';
import { noSecretLeak } from '../../../src/fixtures/rules';
import { readNetLog } from '../../../src/net';
import { RuleEngine } from '../../../src/rules';
import { leakScenario, loginScenario } from './scripts';
import {
  browserSuite,
  expectNoEgress,
  PORTAL,
  prepareHostBundle,
  removeRunDir,
  type Stack,
  startStack,
  testFixture,
  waitFor,
} from './support';

browserSuite('typed secrets', () => {
  let host: Awaited<ReturnType<typeof prepareHostBundle>>;
  beforeAll(async () => {
    host = await prepareHostBundle();
  }, 180_000);
  afterAll(() => host?.cleanup());

  function filesContaining(dir: string, needle: string): string[] {
    const found: string[] = [];
    const visit = (current: string) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && statSync(path).size < 200 * 1024 * 1024) {
          if (readFileSync(path).includes(needle)) found.push(path);
        }
      }
    };
    visit(dir);
    return found;
  }

  describe('the user types a password into a page', () => {
    async function login(captureBrowser: boolean): Promise<Stack> {
      const stack = await startStack({
        hostBundle: host.bundle,
        scenario: loginScenario(),
        captureBrowser,
      });
      await stack.app.send('sácame la vida laboral');
      const prompt = await waitFor(
        () => stack.app.pendingPrompts()[0],
        'the request for the password',
      );
      // The app asks for a secret: the field says so and holds nothing.
      expect(prompt).toMatchObject({
        kind: 'form',
        agent: 'procedure',
        fields: [{ key: 'value', type: 'secret', secret: true }],
      });
      // The run registers a secret when it answers with it.
      stack.app.addSecret(CLAVE_PASSWORD);
      await stack.app.respond(prompt.itemId, {
        kind: 'form',
        values: { value: CLAVE_PASSWORD },
        dismissed: false,
        savedToVault: [],
      });
      expect(await stack.app.untilIdle({ timeoutMs: 90_000 })).toBe(true);
      return stack;
    }

    it('is typed into the page, which posts it, and is a leak nowhere', async () => {
      const stack = await login(false);
      try {
        const post = stack
          .of('net')
          .map((o) => o.record)
          .find((r) => r.channel === 'browser' && r.method === 'POST' && r.host === PORTAL);
        // The form went to the portal (the use the password is for), with the password masked in the log.
        expect(post).toMatchObject({ url: `https://${PORTAL}/post`, route: 'mapped', status: 200 });
        expect(post?.reqBody).toContain('[secret]');
        expect(post?.reqBody).not.toContain(CLAVE_PASSWORD);
        expect(stack.app.secretLeaks()).toEqual([]);
        // What the agent saw of the page after typing and posting has the value masked.
        const click = stack.of('tool_end').find((o) => o.tool === 'browser_click');
        expect(click?.text).toContain('••••');
        expect(JSON.stringify(stack.observations())).not.toContain(CLAVE_PASSWORD);
        const engine = new RuleEngine({ rules: [noSecretLeak()] });
        for (const observation of stack.observations()) engine.observe(observation);
        await engine.evaluate(
          {
            observations: () => stack.observations(),
            benchState: async () => {
              throw new Error('not needed');
            },
            vaultDocuments: () => stack.app.vaultDocuments(),
            secretLeaks: () => stack.app.secretLeaks(),
          },
          { full: true },
        );
        expect(engine.shouldFailNow()).toBe(false);
      } finally {
        await stack.close();
      }
      // Nothing of the run keeps it, the profile included.
      expect(filesContaining(stack.runDir, CLAVE_PASSWORD)).toEqual([]);
      expect(existsSync(join(stack.runDir, 'browser'))).toBe(false);
      const browserLog = await readNetLog(join(stack.runDir, 'net', 'browser.jsonl'));
      expect(JSON.stringify(browserLog)).not.toContain(CLAVE_PASSWORD);
      removeRunDir(stack.runDir);
    }, 180_000);

    it('stays in the browser recording when the run asks for one, and only there', async () => {
      const stack = await login(true);
      await stack.close();
      const holders = filesContaining(stack.runDir, encodeURIComponent(CLAVE_PASSWORD));
      expect(holders.length).toBeGreaterThan(0);
      expect(holders.every((file) => file.startsWith(join(stack.runDir, 'browser')))).toBe(true);
      expect(
        filesContaining(stack.runDir, CLAVE_PASSWORD).filter(
          (f) => !f.startsWith(join(stack.runDir, 'browser')),
        ),
      ).toEqual([]);
      // The recording: one folder per procedure, with a HAR and the HTML after each step.
      const [procedure] = readdirSync(join(stack.runDir, 'browser'));
      const [started] = readdirSync(join(stack.runDir, 'browser', procedure as string));
      const folder = join(stack.runDir, 'browser', procedure as string, started as string);
      expect(readdirSync(folder)).toEqual(
        expect.arrayContaining(['network.har', 'capture.json', 'pages']),
      );
      removeRunDir(stack.runDir);
    }, 180_000);
  });

  describe('the password reaches the model, a script and a stranger', () => {
    it('is found in the arguments, the result, the request and the message, and never shown', async () => {
      const stack = await startStack({
        hostBundle: host.bundle,
        scenario: leakScenario(),
        fixture: testFixture('vida-laboral-con-datos'),
      });
      try {
        // The seeded Cl@ve password is a secret from the start: nobody had to answer with it.
        await stack.app.send('sácame la vida laboral');
        expect(await stack.app.untilIdle({ timeoutMs: 90_000 })).toBe(true);
        const leaks = stack.app.secretLeaks();
        const sources = leaks.map((leak) => leak.split(':')[0]);
        expect(sources).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^tool arguments of run_script \(procedure-p_/),
            expect.stringMatching(/^result of run_script \(procedure-p_/),
            `request POST ${PORTAL} (run_script)`,
            expect.stringMatching(/^message of procedure-p_/),
          ]),
        );
        // The leaks name where, with the secret masked.
        expect(leaks.join('\n')).not.toContain(CLAVE_PASSWORD);
        expect(leaks.join('\n')).toContain('[secret]');
        // The same text, in the files of the run, is masked too.
        await stack.app.close();
        expect(filesContaining(join(stack.runDir, 'net'), CLAVE_PASSWORD)).toEqual([]);
        expect(filesContaining(join(stack.runDir, 'transcripts'), CLAVE_PASSWORD)).toEqual([]);
      } finally {
        await stack.close();
        removeRunDir(stack.runDir);
      }
    }, 180_000);
  });
});

afterAll(expectNoEgress);
