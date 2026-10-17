/**
 * Checkpoints: the profile, the browser's cookies and the app's own state survive a close and a new
 * app on a copy, and the agents carry on from their sessions. The model credential does not: it
 * is never in a profile, a checkpoint or any file of a run, and a restored run gets it again
 * through the provider flow.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatRequest } from '@sa/mock-llm';
import { createTestKeyProvider, Vault } from '@sa/vault';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CredentialSource } from '../../../src/llm';
import { PROFILE_KEY_SEED } from '../../../src/run/app/eval-app';
import { copyProfile } from '../../../src/run/app/profile';
import { pausedScenario, questionScenario, resumeScenario } from './scripts';
import {
  browserSuite,
  expectNoEgress,
  prepareHostBundle,
  removeRunDir,
  type Stack,
  startStack,
  testFixture,
  waitFor,
} from './support';

browserSuite('checkpoints', () => {
  const MODEL_KEY = 'sk-checkpoint-DISTINCTIVE-4c1e9a7d2b6f';

  const credentials: CredentialSource = {
    providerId: 'litellm',
    credential: async (id) => (id === 'litellm' ? { type: 'api_key', key: MODEL_KEY } : null),
    refreshCredential: async (id) =>
      id === 'litellm' ? { type: 'api_key', key: MODEL_KEY } : null,
  };

  let host: Awaited<ReturnType<typeof prepareHostBundle>>;
  beforeAll(async () => {
    host = await prepareHostBundle();
  }, 180_000);
  afterAll(() => host?.cleanup());

  /** Every file under `dir` (recursively) that contains `needle`. */
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

  describe('checkpoint and restore', () => {
    let first: Stack;
    let second: Stack | undefined;
    let checkpointDir: string;
    let procedureId: string;
    let taken: { profileDir: string; browserStateFile?: string };
    const fixture = testFixture('vida-laboral-con-datos');

    beforeAll(async () => {
      first = await startStack({
        hostBundle: host.bundle,
        scenario: pausedScenario(),
        fixture,
        credentials,
      });
      await first.app.send('sácame la vida laboral');
      expect(await first.app.untilIdle({ timeoutMs: 90_000 })).toBe(true);
      procedureId = first
        .of('tool_end')
        .map((o) => /Started (p_[0-9a-f]+)/.exec(o.text)?.[1])
        .find(Boolean) as string;
      checkpointDir = mkdtempSync(join(tmpdir(), 'sa-eval-checkpoint-'));
    }, 180_000);

    afterAll(async () => {
      await first?.close();
      await second?.close();
      for (const stack of [first, second]) if (stack) removeRunDir(stack.runDir);
      removeRunDir(checkpointDir);
    });

    it('refuses to be taken while the app is busy', async () => {
      const busy = await startStack({
        hostBundle: host.bundle,
        scenario: pausedScenario(),
        fixture,
      });
      try {
        await busy.app.send('sácame la vida laboral');
        expect(busy.app.idle()).toBe(false);
        await expect(busy.app.checkpoint(join(busy.runDir, 'cp'))).rejects.toThrow(/idle/);
        expect(existsSync(join(busy.runDir, 'cp'))).toBe(false);
      } finally {
        await busy.close();
        removeRunDir(busy.runDir);
      }
    }, 120_000);

    it('copies the profile and the browser state of an idle app', async () => {
      taken = await first.app.checkpoint(checkpointDir);
      expect(taken.profileDir).toBe(join(checkpointDir, 'profile'));
      expect(taken.browserStateFile).toBe(join(checkpointDir, 'browser-state.json'));

      // The state of the app: the procedure with its card and session, the orchestrator's session.
      for (const file of [
        'settings.json',
        'assistant/session.jsonl',
        'assistant/transcript.json',
        `procedures/${procedureId}/procedure.json`,
        `procedures/${procedureId}/session.jsonl`,
        `procedures/${procedureId}/transcript.json`,
        'vault/vault.bin',
        'vault/key.bin',
      ]) {
        expect(existsSync(join(taken.profileDir, file)), file).toBe(true);
      }
      // What is not state is not copied.
      expect(existsSync(join(taken.profileDir, 'logs'))).toBe(false);
      expect(existsSync(join(taken.profileDir, 'downloads'))).toBe(false);

      // The cookies of the procedure's context, by procedure.
      const state = JSON.parse(readFileSync(taken.browserStateFile as string, 'utf8')) as {
        format: string;
        procedures: Record<string, { cookies: { name: string; domain: string }[] }>;
      };
      expect(state.format).toBe('sa-eval-browser-state/1');
      expect(Object.keys(state.procedures)).toEqual([procedureId]);
      expect(state.procedures[procedureId]?.cookies.map((c) => c.name).sort()).toEqual([
        'host_only',
        'shared',
        'third',
      ]);
    });

    it('keeps the vault and the model credential apart: the copy has data, no provider secret', async () => {
      // The copy is a closed vault of its own: safe to open next to the live one.
      const vault = await Vault.open(
        join(taken.profileDir, 'vault'),
        createTestKeyProvider(PROFILE_KEY_SEED),
      );
      expect(vault.listPersonal().map((p) => p.key)).toEqual(
        expect.arrayContaining(['givenName', 'surname1', 'dniNumber', 'nuss']),
      );
      expect(vault.listCredentials().map((c) => c.kind)).toEqual(['clave_permanente']);
      expect(vault.listSecrets().filter((s) => s.id.startsWith('provider.'))).toEqual([]);
      expect(
        JSON.parse(readFileSync(join(taken.profileDir, 'settings.json'), 'utf8')).provider,
      ).toMatchObject({
        kind: 'voucher',
      });
    });

    it('restores everything in a new run, which resumes the procedure from its own session', async () => {
      await first.app.close();
      second = await startStack({
        hostBundle: host.bundle,
        scenario: resumeScenario(procedureId),
        fixture,
        credentials,
        restoreFrom: taken,
      });
      const { app } = second;
      // Nothing runs by itself after a restore: the app is idle, as a restarted app is.
      expect(app.idle()).toBe(true);
      expect(app.pendingPrompts()).toEqual([]);
      expect(second.llm.requests()).toEqual([]);

      await app.send('sigue con el trámite');
      expect(await app.untilIdle({ timeoutMs: 90_000 })).toBe(true);
      const observed = second;

      // The card the first run left (read by the orchestrator through the app) and the vault.
      const ended = (tool: string) =>
        observed.of('tool_end').find((o) => o.tool === tool)?.text ?? '';
      expect(ended('procedure_read')).toContain('Esperando a que el usuario confirme');
      expect(ended('vault_read')).toContain('givenName');
      expect(ended('vault_read')).toContain('clave_permanente');

      // The browser's cookies came back: the portal sees them on a fresh page load.
      const whoami = observed
        .of('tool_end')
        .find((o) => o.agent === 'procedure' && o.tool === 'browser_open');
      expect(whoami?.text).toContain('host_only=1');
      expect(whoami?.text).toContain('shared=2');
      expect(whoami?.text).toContain('third=3');

      // The procedure agent started from its session: its first request has what it did before.
      const completions = observed.llm
        .requests()
        .filter((r) => r.path.endsWith('/chat/completions'))
        .map((r) => r.body as ChatRequest)
        .filter((b) => (b.tools ?? []).some((t) => t.function?.name === 'procedure_update'));
      const history = JSON.stringify(completions[0]?.messages);
      expect(history).toContain('cookies set');
      expect(history).toContain('Esperando a que el usuario confirme');
      expect(history).toContain('Continúa donde lo dejaste.');
      expect(observed.of('assistant_message').map((m) => m.text)).toContain('Sigo con ello.');
    }, 180_000);

    it('never writes the model credential to the run, the checkpoint or the restored run', async () => {
      const stacks = [first, second as Stack];
      // It was used: both runs' requests carried it to the gateway.
      for (const stack of stacks) {
        const requests = stack.llm.requests();
        expect(requests.length).toBeGreaterThan(0);
        for (const request of requests) {
          expect(request.headers.authorization).toBe(`Bearer ${MODEL_KEY}`);
        }
      }
      await second?.app.close();
      const directories = [first.runDir, (second as Stack).runDir, checkpointDir];
      for (const dir of directories) {
        expect(filesContaining(dir, MODEL_KEY)).toEqual([]);
        expect(filesContaining(dir, Buffer.from(MODEL_KEY).toString('base64'))).toEqual([]);
      }
      // And the vault of the live profile never held it either (opened once the app is closed).
      for (const stack of stacks) {
        const vault = await Vault.open(
          join(stack.runDir, 'profile', 'vault'),
          createTestKeyProvider(PROFILE_KEY_SEED),
        );
        expect(vault.listSecrets().filter((s) => s.id.startsWith('provider.'))).toEqual([]);
      }
    });
  });

  describe('a profile with a question pending', () => {
    it('brings the question back, announces it, and wakes the agent when it is answered', async () => {
      const fixture = testFixture('vida-laboral-con-datos');
      const first = await startStack({
        hostBundle: host.bundle,
        scenario: questionScenario(),
        fixture,
      });
      let copy: string | undefined;
      let second: Stack | undefined;
      try {
        await first.app.send('sácame la vida laboral');
        const asked = await waitFor(() => first.app.pendingPrompts()[0], 'the question');
        // A checkpoint needs an idle app; a restart does not: the form stays in the transcript.
        await first.app.close();
        copy = mkdtempSync(join(tmpdir(), 'sa-eval-pending-'));
        await copyProfile(join(first.runDir, 'profile'), copy);

        second = await startStack({
          hostBundle: host.bundle,
          scenario: questionScenario(),
          fixture,
          restoreFrom: { profileDir: copy },
        });
        const { app } = second;
        expect(app.pendingPrompts()).toEqual([asked]);
        expect(app.idle()).toBe(false);
        expect(second.of('prompt_shown').map((o) => o.prompt)).toEqual([asked]);
        expect(app.counters().prompts).toBe(1);

        await app.respond(asked.itemId, {
          kind: 'form',
          values: { provincia: 'Sevilla' },
          dismissed: false,
          savedToVault: [],
        });
        expect(await app.untilIdle({ timeoutMs: 90_000 })).toBe(true);
        const said = second.of('assistant_message').filter((m) => m.agent === 'procedure');
        expect(said.map((m) => m.text)).toEqual(['Gracias, sigo.']);
      } finally {
        await first.close();
        await second?.close();
        for (const stack of [first, second]) if (stack) removeRunDir(stack.runDir);
        if (copy) removeRunDir(copy);
      }
    }, 180_000);
  });
});

afterAll(expectNoEgress);
