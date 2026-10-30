import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForCi } from './ci-gate.mjs';

const SHA = 'a'.repeat(40);
const TAG = 'v1.2.3';
const RUNS = `/actions/workflows/ci.yml/runs?head_sha=${SHA}&per_page=100`;

const run = (id, event, status, conclusion = null) => ({
  id,
  event,
  status,
  conclusion,
  html_url: `https://github.com/o/r/actions/runs/${id}`,
});

/**
 * A fake GitHub API: each poll reads the tag, then the runs (`polls`, one list per poll; the last
 * one repeats). Every request is recorded. No network.
 */
function github({ polls, tagSha = () => SHA, fail = () => false }) {
  const requests = [];
  let poll = -1;
  const api = async (method, path, body) => {
    requests.push(body ? `${method} ${path} ${JSON.stringify(body)}` : `${method} ${path}`);
    if (fail(requests.length)) throw new Error('HTTP 502');
    if (path === `/commits/${TAG}`) {
      poll++;
      return { sha: tagSha(poll) };
    }
    if (path === RUNS) return { workflow_runs: polls[Math.min(poll, polls.length - 1)] };
    if (method === 'POST' && path === '/actions/workflows/ci.yml/dispatches') return undefined;
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return { api, requests };
}

/** A clock that each sleep moves forward. */
function clock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
}

const gate = (api, extra = {}) => waitForCi({ api, sha: SHA, tag: TAG, ...clock(), ...extra });

test("passes on a successful push run, ignoring a pull request's", async () => {
  const { api } = github({
    polls: [
      [run(1, 'pull_request', 'completed', 'failure'), run(2, 'push', 'completed', 'success')],
    ],
  });
  const result = await gate(api);
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://github.com/o/r/actions/runs/2');
});

test('waits for a run in progress, then follows its verdict', async () => {
  const { api, requests } = github({
    polls: [
      [run(3, 'push', 'queued')],
      [run(3, 'push', 'in_progress')],
      [run(3, 'push', 'completed', 'success')],
    ],
  });
  const lines = [];
  const result = await gate(api, { log: (line) => lines.push(line) });
  assert.equal(result.ok, true);
  assert.equal(requests.filter((r) => r.startsWith('POST')).length, 0);
  assert.equal(lines.length, 1);
});

test('stops on a failed run, but waits while it is re-run', async () => {
  const failed = github({ polls: [[run(4, 'push', 'completed', 'failure')]] });
  const result = await gate(failed.api);
  assert.equal(result.ok, false);
  assert.match(result.reason, /CI failure/);

  const rerun = github({
    polls: [
      [run(4, 'push', 'completed', 'failure'), run(5, 'workflow_dispatch', 'in_progress')],
      [run(4, 'push', 'completed', 'failure'), run(5, 'workflow_dispatch', 'completed', 'success')],
    ],
  });
  assert.equal((await gate(rerun.api)).ok, true);
});

test('starts CI on the tag when the commit has none, or only cancelled runs', async () => {
  for (const first of [[], [run(6, 'push', 'completed', 'cancelled')]]) {
    const { api, requests } = github({
      polls: [
        first,
        [...first, run(7, 'workflow_dispatch', 'queued')],
        [...first, run(7, 'workflow_dispatch', 'completed', 'success')],
      ],
    });
    const result = await gate(api);
    assert.equal(result.ok, true);
    assert.deepEqual(
      requests.filter((r) => r.startsWith('POST')),
      [`POST /actions/workflows/ci.yml/dispatches {"ref":"${TAG}"}`],
    );
  }
});

test('gives up when the dispatched run never shows up, or when time runs out', async () => {
  const never = github({ polls: [[]] });
  const result = await gate(never.api);
  assert.equal(result.ok, false);
  assert.match(result.reason, /never appeared/);
  assert.equal(never.requests.filter((r) => r.startsWith('POST')).length, 1);

  const slow = github({ polls: [[run(8, 'push', 'in_progress')]] });
  const late = await gate(slow.api, { timeoutMs: 10 * 60_000 });
  assert.equal(late.ok, false);
  assert.match(late.reason, /No CI verdict/);
});

test('stops when the tag moves to another commit', async () => {
  const { api } = github({
    polls: [[run(9, 'push', 'in_progress')]],
    tagSha: (poll) => (poll === 0 ? SHA : 'b'.repeat(40)),
  });
  const result = await gate(api);
  assert.equal(result.ok, false);
  assert.match(result.reason, /now points at b{40}/);
});

test('retries the API a few times before giving up', async () => {
  const flaky = github({
    polls: [[run(10, 'push', 'completed', 'success')]],
    fail: (n) => n <= 3,
  });
  assert.equal((await gate(flaky.api)).ok, true);

  const down = github({ polls: [[]], fail: () => true });
  const result = await gate(down.api);
  assert.equal(result.ok, false);
  assert.match(result.reason, /keeps failing/);
});
