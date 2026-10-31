/**
 * Checkpoint and resume through the whole suite: a first run stops after the login, and a second
 * run, started from its checkpoint, carries on in the same world, with the same profile and the
 * same browser: the login still holds, the rules that matched keep when they matched, and the
 * result is the one of a run that never stopped.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { mockScenario } from '../../src/scenarios';
import {
  cleanup,
  e2eSuite,
  evaluate,
  expectNoEgress,
  observations,
  readJson,
  readRun,
  sha256,
  toolNames,
  vaultDocuments,
  workspace,
} from './harness';
import { pausedAfterLogin, resumedAfterLogin } from './scenarios';

afterAll(() => {
  cleanup();
  expectNoEgress();
});

e2eSuite('checkpoint and resume on the real SpainBench', () => {
  const space = workspace();
  const fixtureId = 'vida-laboral-sin-datos';

  it('carries on from a checkpoint to the result of a run that never stopped', async () => {
    const uninterrupted = evaluate(space, {
      fixtureId,
      scenario: mockScenario(fixtureId, 'oracle'),
    });

    // The first run: it logs in, stops and asks the user whether to go on.
    const first = await evaluate(space, { fixtureId, scenario: pausedAfterLogin(fixtureId) });
    const before = readRun(first);
    expect(first.result).toMatchObject({
      status: 'failed_required',
      score: 0,
      endedBy: 'quiescent',
    });
    // The job is not done: the report is not saved, and nothing links it.
    expect(first.result.rules.filter((rule) => !rule.passed).map((rule) => rule.ruleId)).toEqual([
      'pdf-saved-complete',
      'final-message-links-document',
    ]);
    expect(first.checkpoints).toEqual([1]);
    expect(before.state.downloads).toEqual([]);
    expect(before.state.sites['seg-social-es']).toMatchObject({
      authenticated: true,
      loginMethod: 'clave-permanente',
    });
    expect(await vaultDocuments(join(first.runDir, 'profile'))).toEqual([]);
    const loginSeen = before.result.rules.find((rule) => rule.ruleId === 'login-clave-permanente');
    const optionsSeen = before.result.rules.find((rule) => rule.ruleId === 'offered-auth-options');
    expect(loginSeen?.firstSeenAtSeq).toBeGreaterThan(0);

    // The checkpoint holds the world, the profile and the browser's cookies.
    const manifest = readJson<{
      atSeq: number;
      quiescent: boolean;
      answerState: { used: string[] };
      ruleState: { latched: Record<string, number> };
    }>(join(first.runDir, 'checkpoints', '1', 'manifest.json'));
    expect(manifest.quiescent).toBe(true);
    expect(manifest.answerState.used).toEqual([
      'choose-clave-permanente',
      'clave-permanente-credential',
    ]);
    expect(manifest.ruleState.latched['login-clave-permanente']).toBe(loginSeen?.firstSeenAtSeq);
    expect(existsSync(join(first.runDir, 'checkpoints', '1', 'bench-snapshot.json'))).toBe(true);

    // The second run, from that checkpoint: the user says "go on" and the orchestrator resumes.
    const second = await evaluate(space, {
      fixtureId,
      scenario: resumedAfterLogin(fixtureId),
      from: { runDir: first.runDir, checkpoint: 1 },
    });
    const after = readRun(second);
    expect(second.result).toMatchObject({
      status: 'completed',
      score: 1,
      scoreBeforePenalty: 1,
      wrongTurns: 0,
      endedBy: 'quiescent',
    });
    expect(second.result.notes).toEqual([
      `resumed-from:${before.result.runId}#1@${manifest.atSeq}`,
    ]);
    const same = await uninterrupted;
    expect(second.result.score).toBe(same.result.score);
    expect(second.result.rules.map((rule) => [rule.ruleId, rule.passed])).toEqual(
      same.result.rules.map((rule) => [rule.ruleId, rule.passed]),
    );

    // The log goes on from the checkpoint: the old events, a note, the user's "go on", the rest.
    const old = before.events.filter((event) => event.seq <= manifest.atSeq);
    expect(after.events.slice(0, old.length)).toEqual(old);
    const resumedAt = after.events[old.length];
    expect(resumedAt).toMatchObject({ type: 'note' });
    expect(after.events[old.length + 1]).toMatchObject({
      type: 'user_message',
      text: 'Sigue donde lo dejaste, por favor.',
    });
    expect(after.events.map((event) => event.seq)).toEqual(
      after.events.map((_event, index) => index + 1),
    );

    // Rules that matched keep when they matched: they were not seen again.
    for (const rule of [loginSeen, optionsSeen]) {
      expect(after.result.rules.find((r) => r.ruleId === rule?.ruleId)?.firstSeenAtSeq).toBe(
        rule?.firstSeenAtSeq,
      );
    }
    // The answers were not used again: nobody was asked a second time.
    expect(observations(after.events, 'prompt_shown')).toHaveLength(2);
    expect(observations(after.events, 'prompt_answered')).toHaveLength(2);
    expect(after.result.rules.find((r) => r.ruleId === 'asked-credentials-once')?.passed).toBe(
      true,
    );

    // What the second run did: the orchestrator read the card and resumed the procedure, whose
    // agent opened the logged-in page, which showed it (the cookies came back with the world).
    const later = after.events.filter((event) => event.seq > manifest.atSeq);
    expect(toolNames(later).slice(0, 2)).toEqual([
      'assistant:procedure_read',
      'assistant:procedure_message',
    ]);
    const reopened = observations(later, 'tool_end').find((event) => event.tool === 'browser_open');
    expect(reopened?.text).toContain(`URL: https://portal.seg-social.gob.es/wps/myportal/`);
    expect(reopened?.text).toContain('Descargar vida laboral');
    // No login happened again: the identity hosts were never visited by the second run.
    const hosts = new Set(
      observations(later, 'net')
        .filter((event) => event.record.channel === 'browser')
        .map((event) => event.record.host),
    );
    expect(hosts.has('idp.seg-social.es')).toBe(false);
    expect(hosts.has('clave-dninbrt.seg-social.gob.es')).toBe(false);
    expect(hosts.has('portal.seg-social.gob.es')).toBe(true);

    // The world is the one of the checkpoint plus this run: one login, one download.
    expect(after.state.sites['seg-social-es']).toMatchObject({
      authenticated: true,
      loginMethod: 'clave-permanente',
      failedLogins: 0,
    });
    expect(after.state.downloads).toHaveLength(1);
    const [document] = await vaultDocuments(join(second.runDir, 'profile'));
    expect(sha256(document?.bytes ?? Buffer.alloc(0))).toBe(after.state.downloads[0]?.sha256);

    // The checkpoint was not touched (the second run worked on a copy), and the usage counts the first.
    expect(await vaultDocuments(join(first.runDir, 'checkpoints', '1', 'app', 'profile'))).toEqual(
      [],
    );
    expect(existsSync(join(second.runDir, 'restore'))).toBe(true);
    expect(second.result.usage.requests).toBeGreaterThan(first.result.usage.requests);
  }, 360_000);
});
