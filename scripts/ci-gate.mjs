// The release gate (release.yml's `ci` job): a tag ships only if CI passed for its commit.
//
// It looks for runs of ci.yml on the commit that a push to master or a manual dispatch started
// (a pull request's run checked a merge commit, not this one):
// - one succeeded: the release goes ahead;
// - one is still queued or running (or re-running): it waits for it;
// - one failed: the release stops. Re-run its failed jobs, then the release's;
// - none, or only cancelled ones (a newer push to master replaced it, or the commit was never the
//   tip of a push): it dispatches CI on the tag and waits for that run.
// It gives up when the tag moves to another commit (that commit's release run decides) and after
// a time limit.
import { appendFile } from 'node:fs/promises';

const WORKFLOW = 'ci.yml';
/** Runs that checked this very commit. */
const EVENTS = new Set(['push', 'workflow_dispatch']);
/** Conclusions that say nothing about the code: such a run is ignored. */
const NOT_RUN = new Set(['cancelled', 'skipped', 'stale', 'neutral']);
/** How long a dispatched run may take to show up in the API. */
const DISPATCH_WAIT_MS = 5 * 60_000;

/**
 * Resolves `{ ok, reason, url? }` once CI's verdict on `sha` is known. `api(method, path, body?)`
 * calls GitHub's REST API for this repository (paths start with `/actions` or `/commits`).
 */
export async function waitForCi({
  api,
  sha,
  tag,
  log = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  timeoutMs = 100 * 60_000,
  pollMs = 30_000,
}) {
  const deadline = now() + timeoutMs;
  let dispatchedAt;
  let waitingFor;
  let errors = 0;
  while (now() < deadline) {
    let verdict;
    try {
      verdict = await poll();
      errors = 0;
    } catch (error) {
      // GitHub's API fails now and then: only a run of failures stops the gate.
      if (++errors >= 5)
        return { ok: false, reason: `GitHub's API keeps failing: ${error.message}` };
      log(`GitHub's API failed (${error.message}), retrying`);
    }
    if (verdict) return verdict;
    await sleep(pollMs);
  }
  return {
    ok: false,
    reason: `No CI verdict for ${sha} after ${Math.round(timeoutMs / 60_000)} min`,
  };

  /** CI's verdict, or undefined while there is none yet. */
  async function poll() {
    const tagged = await api('GET', `/commits/${encodeURIComponent(tag)}`);
    if (tagged.sha !== sha)
      return {
        ok: false,
        reason: `${tag} now points at ${tagged.sha}: its own release run decides`,
      };
    const { workflow_runs: all = [] } = await api(
      'GET',
      `/actions/workflows/${WORKFLOW}/runs?head_sha=${sha}&per_page=100`,
    );
    const runs = all.filter((run) => EVENTS.has(run.event));
    const passed = runs.find((run) => run.status === 'completed' && run.conclusion === 'success');
    if (passed) return { ok: true, reason: `CI passed for ${sha}`, url: passed.html_url };
    // A run in progress may still pass (a re-run of failed jobs is the same run).
    const running = runs.find((run) => run.status !== 'completed');
    if (running) {
      if (waitingFor !== running.id) log(`Waiting for CI (${running.status}): ${running.html_url}`);
      waitingFor = running.id;
      return undefined;
    }
    const failed = runs.find((run) => !NOT_RUN.has(run.conclusion ?? 'cancelled'));
    if (failed)
      return {
        ok: false,
        reason: `CI ${failed.conclusion} for ${sha}: re-run its failed jobs, then this release's`,
        url: failed.html_url,
      };
    if (dispatchedAt === undefined) {
      await api('POST', `/actions/workflows/${WORKFLOW}/dispatches`, { ref: tag });
      dispatchedAt = now();
      log(`No CI run for ${sha}: started one on ${tag}`);
    } else if (now() - dispatchedAt > DISPATCH_WAIT_MS) {
      return { ok: false, reason: `The CI run started on ${tag} never appeared` };
    }
    return undefined;
  }
}

async function main() {
  // COMMIT: the tag's commit (`git rev-parse HEAD`), in case GITHUB_SHA names a tag object.
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_REF_NAME, GITHUB_STEP_SUMMARY } = process.env;
  const sha = process.env.COMMIT || process.env.GITHUB_SHA;
  if (![GH_TOKEN, GITHUB_REPOSITORY, sha, GITHUB_REF_NAME].every(Boolean))
    throw new Error('Needs GH_TOKEN, GITHUB_REPOSITORY, COMMIT or GITHUB_SHA, and GITHUB_REF_NAME');
  const base = `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${GITHUB_REPOSITORY}`;
  const api = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  };
  const result = await waitForCi({
    api,
    sha,
    tag: GITHUB_REF_NAME,
    log: (line) => console.log(line),
  });
  const line = `${result.ok ? '✅' : '❌'} ${result.reason}${result.url ? ` (${result.url})` : ''}`;
  console.log(line);
  if (GITHUB_STEP_SUMMARY) await appendFile(GITHUB_STEP_SUMMARY, `${line}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
