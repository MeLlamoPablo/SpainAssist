#!/usr/bin/env node
/**
 * Scanner model eval: replays saved scanner frames through the real scanner agent
 * (apps/desktop/src/main/scanner/agent.ts: runScanAgent, prompt, tool declarations, validation)
 * with pi's ModelRuntime, then scores the extracted fields against hand-checked ground truth.
 *
 *   node tools/scan-eval/run.mjs [--models a,b,c] [--runs 3] [--docs a,b] [--out results.json]
 *                                [--budget 5] [--dry-run] [--mock] [--repo <checkout>] [--data <dir>]
 *   node tools/scan-eval/run.mjs --rescore results/a.json[,results/b.json]
 *
 * Every model goes through our LiteLLM gateway. Without SA_GATEWAY_URL + SA_GATEWAY_KEY, the
 * script redeems SA_VOUCHER_CODE, or creates a one-day voucher with the key server's admin token
 * from infra/terraform/terraform.tfvars and redeems it. Secrets are never printed or written.
 * Model spec: `id[@reasoning]`, e.g. `claude-haiku-5-5`, `google/gemini-3.5-flash-lite@low`.
 * Costs are LiteLLM's charge per call (the x-litellm-response-cost header), or an estimate.
 * --dry-run: sends nothing. It builds every provider request (fetch is disabled) and drives the
 *   loop with the model replies recorded in session.jsonl. It prints sizes and counts only.
 * --mock: runs the full HTTP path against an in-process tools/mock-llm that replays the recorded
 *   replies. Real frames are replaced with a 1x1 placeholder JPEG.
 * --rescore: scores the fields saved in earlier result files against the current ground truth
 *   and scoring rules, and writes a combined report. It calls no model.
 * Fixtures (frames, recorded sessions, ground truth) are personal data, encrypted with git-crypt.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const DEFAULT_MODELS = [
  'claude-haiku-5-5',
  'claude-sonnet-5-5',
  'google/gemini-3.6-flash',
  'google/gemini-3.5-flash-lite',
];

const { values: args } = parseArgs({
  options: {
    models: { type: 'string', default: DEFAULT_MODELS.join(',') },
    runs: { type: 'string', default: '3' },
    docs: { type: 'string' },
    out: { type: 'string' },
    budget: { type: 'string', default: '5' },
    'dry-run': { type: 'boolean', default: false },
    mock: { type: 'boolean', default: false },
    rescore: { type: 'string' },
    repo: { type: 'string' },
    data: { type: 'string', default: join(HERE, 'fixtures') },
  },
});
const DRY = args['dry-run'];
const MOCK = args.mock;
const RESCORE = args.rescore
  ?.split(',')
  .map((f) => f.trim())
  .filter(Boolean);
if ([DRY, MOCK, RESCORE].filter(Boolean).length > 1)
  throw new Error('Use only one of --dry-run, --mock and --rescore.');
const RUNS = Number(args.runs);
const LANGUAGE = 'es';

function findRepo() {
  const candidates = [args.repo, resolve(HERE, '../..'), process.cwd()];
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, 'apps/desktop/src/main/scanner/agent.ts'))) return resolve(dir);
  }
  throw new Error('Pass --repo <SpainAssist checkout>.');
}
const REPO = findRepo();
const APP = join(REPO, 'apps/desktop');
const require = createRequire(join(APP, 'package.json'));
// require.resolve picks tsx's CommonJS build, whose loader registration breaks when imported
// from ESM; load the ESM build from tsx's export map instead.
const TSX = require.resolve('tsx/package.json');
const tsxApi = join(dirname(TSX), require(TSX).exports['./esm/api'].import.default);
const { tsImport } = await import(pathToFileURL(tsxApi).href);
const PARENT = pathToFileURL(join(APP, 'scan-eval.mjs')).href;
const { runScanAgent, scannerPrompt } = await tsImport('./src/main/scanner/agent.ts', PARENT);
const { configureModel } = await tsImport('@sa/agent', PARENT);
const { ModelRuntime } = await tsImport('@earendil-works/pi-coding-agent', PARENT);

// ---------------------------------------------------------------------------------------------
// Documents and ground truth
// ---------------------------------------------------------------------------------------------

/** git-crypt keeps locked files as "\0GITCRYPT\0…" blobs. */
function readFixture(path) {
  const data = readFileSync(path);
  if (data.subarray(0, 10).equals(Buffer.from('\0GITCRYPT\0')))
    throw new Error(`${path} is encrypted: run \`git-crypt unlock\` first.`);
  return data;
}

/** { name: { note, expect, frames, truth, missingIsFine } }, one folder per document in --data. */
const DOCS = JSON.parse(readFixture(join(args.data, 'docs.json')).toString('utf8'));
// expect: how a careful scan ends. "finish": every expected field is readable, so it calls
// finish_scan. "keep_asking": a field is unreadable or a side is missing, so it keeps asking for
// frames until the replay runs out (frames_exhausted); finishing would save a guess or a gap.
for (const [name, doc] of Object.entries(DOCS))
  if (doc.expect !== 'finish' && doc.expect !== 'keep_asking')
    throw new Error(`docs.json: "${name}" needs expect "finish" or "keep_asking".`);

const COMPACT_KEYS = new Set([
  'documentNumber',
  'documentSupportNumber',
  'dniIssuingTeam',
  'drivingCategories',
  // Licence field 4c prints a province code such as 41-00; models read the dash as . or ·.
  'documentIssuingAuthority',
]);
// Names often print in capitals without accents, and the prompt forbids adding them.
const NAME_KEYS = new Set(['givenName', 'surname1', 'surname2', 'fatherName', 'motherName']);
// The DNI prints "C." for calle; "C/" and "Calle" name the same street.
const STREET_TYPES = [
  [/^(c\/|c\.|cl\.|calle\b)\s*/, 'calle '],
  [/^(av\.|avda\.|avenida\b)\s*/, 'avenida '],
];
function normalize(key, value) {
  // drivingCategories is a list of rows ({ category, issueDate?, expiry?, restrictions? }): score the codes.
  if (Array.isArray(value))
    value = value.map((row) => (typeof row === 'string' ? row : row?.category)).join(',');
  let text = String(value).normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
  if (COMPACT_KEYS.has(key)) text = text.replace(/[\s.·-]/g, '');
  if (NAME_KEYS.has(key)) text = text.normalize('NFD').replace(/\p{M}/gu, '');
  if (key === 'addressStreet')
    for (const [pattern, type] of STREET_TYPES) text = text.replace(pattern, type);
  return text;
}

/** ok, finished_early (finished a keep_asking document), stalled (ran out of frames on a
 * finish document) or error (any other failure). */
function ending(doc, run) {
  if (run.status === 'complete') return doc.expect === 'finish' ? 'ok' : 'finished_early';
  if (run.error === 'frames_exhausted') return doc.expect === 'keep_asking' ? 'ok' : 'stalled';
  return 'error';
}

function score(doc, run) {
  const { fields } = run;
  const result = {};
  for (const [key, expected] of Object.entries(doc.truth)) {
    const got = fields?.[key];
    if (got === undefined || got === '' || (Array.isArray(got) && !got.length)) {
      result[key] = {
        status: doc.missingIsFine.includes(key) ? 'missing-ok' : 'missing',
        expected,
      };
      continue;
    }
    result[key] = {
      status: normalize(key, got) === normalize(key, expected) ? 'correct' : 'wrong',
      got,
      expected,
    };
  }
  const extras = Object.fromEntries(
    Object.entries(fields ?? {}).filter(([key]) => !(key in doc.truth)),
  );
  return { ending: ending(doc, run), fields: result, extras };
}

// ---------------------------------------------------------------------------------------------
// Gateway, voucher and models
// ---------------------------------------------------------------------------------------------

const realFetch = globalThis.fetch;
const GATEWAY_ENV = ['SA_GATEWAY_URL', 'SA_GATEWAY_KEY'];
const hasGateway = () => GATEWAY_ENV.every((name) => process.env[name]?.trim());
const TFVARS = join(REPO, 'infra/terraform/terraform.tfvars');

/**
 * Reads top-level string assignments (`name = "value"`, also `<<EOF` heredocs) from a .tfvars
 * file. Values stay in memory: callers must never print or write them.
 */
function readTfvars(path, names) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  const out = {};
  for (const name of names) {
    const quoted = new RegExp(`^\\s*${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm').exec(text);
    if (quoted) {
      out[name] = JSON.parse(`"${quoted[1]}"`);
      continue;
    }
    const heredoc = new RegExp(
      `^\\s*${name}\\s*=\\s*<<-?(\\w+)\\n([\\s\\S]*?)\\n\\s*\\1\\s*$`,
      'm',
    ).exec(text);
    if (heredoc) out[name] = heredoc[2];
  }
  return out;
}

const tfvars = DRY || MOCK ? {} : readTfvars(TFVARS, ['domain', 'key_server_admin_token']);
// variables.tf: var.domain, spainassist.es unless the tfvars set it.
const BASE_DOMAIN = tfvars.domain?.trim() || 'spainassist.es';
const KEY_SERVER_URL = process.env.SA_KEY_SERVER_URL?.trim() || `https://keys.${BASE_DOMAIN}`;

/**
 * Creates one voucher with the key server's admin API (POST /admin/vouchers, ADMIN_TOKEN =
 * tfvars key_server_admin_token). It expires in a day. Prints no token and no code.
 */
async function createVoucher() {
  const token = tfvars.key_server_admin_token?.trim();
  if (!token)
    throw new Error(`No key_server_admin_token in ${TFVARS}: set SA_VOUCHER_CODE instead.`);
  const res = await realFetch(`${KEY_SERVER_URL}/admin/vouchers`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      count: 1,
      amountUsd: Number(args.budget),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      note: 'scan-eval harness',
      batch: 'scan-eval',
    }),
  });
  const body = await res.json().catch(() => ({}));
  const code = body.codes?.[0];
  if (!res.ok || !code)
    throw new Error(`Voucher not created: ${body.error?.code ?? `HTTP ${res.status}`}`);
  console.log(`Voucher created for this eval: $${body.amountUsd}.`);
  return code;
}

/**
 * Without a gateway key: redeem SA_VOUCHER_CODE (or a new voucher) at the key server, as the app
 * does, and keep the returned gateway URL and key in this process's env only.
 */
async function ensureGatewayKey() {
  if (process.env.SA_GATEWAY_KEY?.trim()) return;
  const code = process.env.SA_VOUCHER_CODE?.trim() || (await createVoucher());
  const res = await realFetch(`${KEY_SERVER_URL}/v1/vouchers/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const body = await res.json().catch(() => ({}));
  // Error codes are fixed strings from the key server; never print the answer itself.
  if (!res.ok || !body.apiKey || !body.baseUrl)
    throw new Error(`Voucher not redeemed: ${body.error?.code ?? `HTTP ${res.status}`}`);
  process.env.SA_GATEWAY_KEY = body.apiKey;
  process.env.SA_GATEWAY_URL ||= body.baseUrl;
  console.log(`Voucher redeemed: budget $${body.limitUsd}.`);
}

/**
 * The gateway's models: GET {gateway root}/model/info. Our gateway has one "*" entry (every
 * OpenRouter model); voucher keys may not read the list, which means the same.
 */
async function loadGatewayCatalog() {
  const root = process.env.SA_GATEWAY_URL.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  const res = await realFetch(`${root}/model/info`, {
    headers: { Authorization: `Bearer ${process.env.SA_GATEWAY_KEY.trim()}` },
  });
  if (res.status === 401 || res.status === 403) {
    console.log(`Gateway /model/info: HTTP ${res.status} for this key; assuming the "*" route.`);
    return new Set(['*']);
  }
  if (!res.ok) throw new Error(`Gateway /model/info returned HTTP ${res.status}`);
  const { data } = await res.json();
  return new Set(data.map((entry) => entry.model_name));
}

/** Gateway name for a short id: `claude-haiku-5-5` → `anthropic/claude-haiku-5.5`, `gpt-6-luna` → `openai/gpt-6-luna`. */
function gatewayId(id) {
  if (id.includes('/')) return id;
  if (/^claude-/.test(id)) return `anthropic/${id.replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
  if (/^gpt-/.test(id)) return `openai/${id}`;
  return id;
}

function parseSpec(spec) {
  const match = /^([^@]+)(?:@(\w+))?$/.exec(spec.trim());
  if (!match) throw new Error(`Bad model spec "${spec}"`);
  const [, id, reasoning] = match;
  return { spec: spec.trim(), id: gatewayId(id), reasoning };
}

const PLACEHOLDER_KEY = 'scan-eval-no-key';
async function prepareModel(id, mockBaseUrl) {
  const credential = {
    type: 'api_key',
    key: DRY || MOCK ? PLACEHOLDER_KEY : process.env.SA_GATEWAY_KEY.trim(),
  };
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
    credentials: {
      read: async (provider) => (provider === 'litellm' ? credential : undefined),
      list: async () => [{ providerId: 'litellm', type: 'api_key' }],
      modify: async (provider) => (provider === 'litellm' ? credential : undefined),
      delete: async () => {},
    },
  });
  const known = runtime.getModels('openrouter').some((m) => m.id === id);
  const baseUrl = MOCK
    ? mockBaseUrl
    : process.env.SA_GATEWAY_URL?.trim() || 'http://127.0.0.1:9/v1';
  const model = configureModel(runtime, { provider: 'litellm', id, baseUrl });
  return { runtime, model, known };
}

/** Production rule (service.ts): Flash Lite scans with minimal; others need reasoning off. */
function chooseReasoning(model, requested) {
  if (requested === 'off') return { level: undefined, note: 'off (none effort)' };
  if (requested) return { level: requested, note: requested };
  if (model.id === 'google/gemini-3.5-flash-lite')
    return { level: 'minimal', note: 'minimal (production)' };
  const off = model.thinkingLevelMap?.off;
  if (!model.reasoning || off === undefined || off === 'none')
    return { level: undefined, note: 'off (production)' };
  const lowest = ['minimal', 'low', 'medium', 'high'].find((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped === undefined || typeof mapped === 'string';
  });
  return {
    level: lowest,
    note: `${lowest} (catalog cannot turn reasoning off; the app would refuse this model)`,
  };
}

// ---------------------------------------------------------------------------------------------
// Recorded sessions, frames
// ---------------------------------------------------------------------------------------------

function loadSession(name) {
  const lines = readFixture(join(args.data, name, 'session.jsonl'))
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const messages = lines.filter((l) => l.type === 'message').map((l) => l.message);
  return {
    system: messages.find((m) => m.role === 'system')?.content,
    assistant: messages.filter((m) => m.role === 'assistant'),
  };
}

// 1x1 white JPEG: used by --mock so real frames never leave the process.
const PLACEHOLDER_JPEG =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
function frameDataUrls(name, doc) {
  return doc.frames.map((file) =>
    MOCK
      ? `data:image/jpeg;base64,${PLACEHOLDER_JPEG}`
      : `data:image/jpeg;base64,${readFixture(join(args.data, name, file)).toString('base64')}`,
  );
}

function redactPayload(payload) {
  let images = 0;
  let imageBytes = 0;
  const json = JSON.stringify(payload, (_key, value) => {
    if (
      typeof value === 'string' &&
      value.length > 2000 &&
      /^(data:image\/[a-z]+;base64,)?[A-Za-z0-9+/=]+$/.test(value)
    ) {
      images += 1;
      imageBytes += value.length;
      return `<image ${value.length} b64 chars>`;
    }
    return value;
  });
  const p = payload ?? {};
  const knobs = {
    ...(p.thinking ? { thinking: p.thinking.type } : {}),
    ...(p.output_config ? { effort: p.output_config.effort } : {}),
    ...(p.reasoning_effort ? { reasoning_effort: p.reasoning_effort } : {}),
    ...(p.reasoning ? { reasoning: p.reasoning } : {}),
    ...(p.max_tokens ? { max_tokens: p.max_tokens } : {}),
    ...(p.max_completion_tokens ? { max_completion_tokens: p.max_completion_tokens } : {}),
    ...(p.max_output_tokens ? { max_output_tokens: p.max_output_tokens } : {}),
  };
  // Anthropic managed-effort models carry the active effort in a trailing system message.
  const managed = (p.messages ?? []).filter((m) => m?.output_config).at(-1);
  if (managed) knobs.messageEffort = managed.output_config.effort;
  const messageCount = (p.messages ?? p.input ?? p.contents ?? []).length;
  return {
    textBytes: json.length,
    images,
    imageBytes,
    messageCount,
    tools: (p.tools ?? []).length,
    knobs,
  };
}

// ---------------------------------------------------------------------------------------------
// One scan
// ---------------------------------------------------------------------------------------------

class DryRunStop extends Error {}
const MAX_CAPTURE_ROUNDS = 3; // the frame sequence is replayed at most this many times

async function scanOnce({ model, runtime, reasoning, name, doc, recorded }) {
  const frames = frameDataUrls(name, doc);
  let captureIndex = 0;
  let accumulated = {};
  const turns = [];
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    cost: 0,
    costSource: 'gateway',
  };
  const guidance = [];
  let toolErrors = 0;
  const controller = new AbortController();
  const started = performance.now();
  let modelMs = 0;
  const ports = {
    signal: controller.signal,
    capture: async (reason, success) => {
      if (reason) guidance.push({ reason, success });
      if (captureIndex >= frames.length * MAX_CAPTURE_ROUNDS) throw new Error('frames_exhausted');
      const frame = frames[captureIndex % frames.length];
      captureIndex += 1;
      return [frame];
    },
    record: async (message) => {
      if (
        message.role === 'toolResult' &&
        message.toolName === 'record_fields' &&
        !message.isError
      ) {
        try {
          accumulated = JSON.parse(message.content[0].text).fields;
        } catch {}
      }
      if (message.role === 'toolResult' && message.isError) toolErrors += 1;
    },
    complete: async (context) => {
      const turn = turns.length;
      let payloadInfo;
      let callCost;
      const options = {
        maxTokens: 1800,
        ...(reasoning ? { reasoning } : {}),
        signal: AbortSignal.timeout(45_000),
        // LiteLLM's charge for this call, in USD (it asks OpenRouter for the real cost).
        onResponse: (response) => {
          const cost = Number(response.headers?.['x-litellm-response-cost']);
          if (Number.isFinite(cost)) callCost = cost;
        },
        // Reasoning off: an explicit `none` effort, like the app on our gateway.
        onPayload: (payload) => {
          const body = reasoning ? payload : { ...payload, reasoning_effort: 'none' };
          payloadInfo = redactPayload(body);
          if (DRY) throw new DryRunStop('dry run');
          return body;
        },
      };
      if (DRY) {
        await runtime.completeSimple(model, context, options).catch(() => {});
        if (!payloadInfo) throw new Error('dry run: no payload was built');
        const reply = recorded.assistant[turn];
        if (!reply) throw new Error('script_exhausted');
        turns.push({ ...payloadInfo, ms: 0 });
        return structuredClone(reply);
      }
      for (let attempt = 1; ; attempt++) {
        const t0 = performance.now();
        const response = await runtime.completeSimple(model, context, options);
        const ms = performance.now() - t0;
        modelMs += ms;
        const u = response.usage ?? {};
        usage.input += u.input ?? 0;
        usage.output += u.output ?? 0;
        usage.cacheRead += u.cacheRead ?? 0;
        usage.cacheWrite += u.cacheWrite ?? 0;
        usage.reasoning += u.reasoning ?? 0;
        if (callCost === undefined) usage.costSource = 'estimate';
        usage.cost += callCost ?? u.cost?.total ?? 0;
        callCost = undefined;
        if (response.stopReason !== 'error' && response.stopReason !== 'aborted') {
          turns.push({ ...payloadInfo, ms: Math.round(ms), stopReason: response.stopReason });
          return response;
        }
        // Provider error text can describe the request; keep only a short, key-free message.
        const message = String(response.errorMessage ?? 'error').slice(0, 300);
        turns.push({ ...payloadInfo, ms: Math.round(ms), error: message });
        if (attempt >= 3) throw new Error(`read_failed: ${message}`);
      }
    },
  };
  let status = 'complete';
  let error;
  let fields;
  try {
    const result = await runScanAgent(LANGUAGE, ports);
    fields = result.fields;
  } catch (e) {
    status = 'incomplete';
    error = e instanceof Error ? e.message : String(e);
    fields = accumulated;
  }
  return {
    status,
    error,
    fields,
    captures: captureIndex,
    modelTurns: turns.length,
    toolErrors,
    guidance,
    turns,
    modelMs: Math.round(modelMs),
    wallMs: Math.round(performance.now() - started),
    usage,
  };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

if (DRY) {
  // Belt and braces: nothing may leave the process in a dry run.
  globalThis.fetch = async () => {
    throw new Error('network disabled in --dry-run');
  };
}

let mock;
if (MOCK) {
  const { createMockLlm } = await tsImport(join(REPO, 'tools/mock-llm/src/index.ts'), PARENT);
  mock = await createMockLlm({ port: 0, scenario: { name: 'scan-eval', rules: [] } });
}

// --rescore: the runs saved in earlier result files, scored again below.
const savedRuns = RESCORE?.flatMap((file) => JSON.parse(readFileSync(resolve(file), 'utf8')).runs);
const docNames = (
  args.docs ??
  Object.keys(DOCS)
    .filter((name) => !savedRuns || savedRuns.some((r) => r.doc === name))
    .join(',')
)
  .split(',')
  .map((d) => d.trim())
  .filter(Boolean);
for (const name of docNames)
  if (!DOCS[name]) throw new Error(`Unknown doc "${name}" (${Object.keys(DOCS).join(', ')})`);
const specs = RESCORE ? [] : args.models.split(',').filter(Boolean).map(parseSpec);
const recordedByDoc = RESCORE
  ? {}
  : Object.fromEntries(docNames.map((name) => [name, loadSession(name)]));

// Live runs need the gateway: its catalog decides which models exist.
let gatewayCatalog;
if (!DRY && !MOCK && !RESCORE) {
  await ensureGatewayKey();
  if (!hasGateway()) {
    console.error(
      `Set SA_VOUCHER_CODE, or ${GATEWAY_ENV.join(' and ')} (our LiteLLM gateway and a virtual key).`,
    );
    process.exit(1);
  }
  gatewayCatalog = await loadGatewayCatalog();
  console.log(`Gateway models: ${[...gatewayCatalog].sort().join(', ')}`);
}

const prompt = scannerPrompt(LANGUAGE);
for (const name of Object.keys(recordedByDoc)) {
  const same = recordedByDoc[name].system === prompt;
  console.log(
    `System prompt vs recorded ${name} session: ${same ? 'identical' : 'DIFFERENT (current source is used)'}`,
  );
}
console.log(
  `Mode: ${DRY ? 'dry run (nothing sent)' : MOCK ? `mock LLM at ${mock.baseUrl} (placeholder images)` : RESCORE ? `rescore of ${RESCORE.join(', ')} (nothing sent)` : 'live'}\n`,
);
const MODE = DRY ? 'dry-run' : MOCK ? 'mock' : RESCORE ? 'rescore' : 'live';

const runs = (savedRuns ?? [])
  .filter((r) => docNames.includes(r.doc))
  .map((r) => ({ ...r, score: score(DOCS[r.doc], r) }));
const skipped = [];
for (const spec of specs) {
  if (gatewayCatalog && !gatewayCatalog.has(spec.id) && !gatewayCatalog.has('*')) {
    console.log(`SKIP ${spec.spec}: the gateway has no model "${spec.id}".`);
    skipped.push({ spec: spec.spec, needed: `gateway model ${spec.id}` });
    continue;
  }
  let prepared;
  try {
    prepared = await prepareModel(spec.id, mock?.baseUrl);
  } catch (e) {
    console.log(`SKIP ${spec.spec}: ${e instanceof Error ? e.message : e}`);
    skipped.push({ spec: spec.spec, needed: String(e) });
    continue;
  }
  const { model, runtime, known } = prepared;
  const reasoning = chooseReasoning(model, spec.reasoning);
  console.log(
    `MODEL ${spec.spec} via litellm:${spec.id} | reasoning ${reasoning.note} | cost: LiteLLM's charge per call (estimate if missing: $${model.cost.input}/$${model.cost.output} per Mtok)${known ? '' : ' | not in pi catalog: metadata cloned from a sibling'}`,
  );
  for (const name of docNames) {
    const doc = DOCS[name];
    const recorded = recordedByDoc[name];
    for (let run = 1; run <= (DRY ? 1 : RUNS); run++) {
      if (MOCK) {
        mock.setScenario({
          name: `replay-${name}`,
          rules: recorded.assistant.map((m) => ({
            times: 1,
            reply: {
              toolCalls: m.content
                .filter((c) => c.type === 'toolCall')
                .map((c) => ({ name: c.name, arguments: c.arguments })),
            },
          })),
        });
      }
      const result = await scanOnce({
        model,
        runtime,
        reasoning: reasoning.level,
        name,
        doc,
        recorded,
      });
      const scored = score(doc, result);
      runs.push({
        model: spec.spec,
        route: spec.id,
        reasoning: reasoning.note,
        doc: name,
        run,
        ...result,
        score: scored,
      });
      const counts = countScore(scored);
      if (DRY) {
        console.log(
          `  ${name}: ${result.modelTurns} model turns, ${result.captures} captures, status ${result.status}${result.error ? ` (${result.error})` : ''}`,
        );
        for (const [i, t] of result.turns.entries()) {
          console.log(
            `    turn ${i + 1}: ${t.messageCount} messages, ${t.tools} tools, ${t.images} image(s) (${Math.round(t.imageBytes / 1024)} KiB b64), ${Math.round(t.textBytes / 1024)} KiB other JSON, ${JSON.stringify(t.knobs)}`,
          );
        }
        console.log(
          `    recorded replies scored: ${counts.correct} correct, ${counts.wrong} wrong, ${counts.missing} missing`,
        );
      } else {
        console.log(
          `  ${name} run ${run}: ${result.status}${result.error ? ` (${result.error})` : ''} | ${counts.correct} ok, ${counts.wrong} wrong, ${counts.missing} missing | ${(result.modelMs / 1000).toFixed(1)}s model, ${result.modelTurns} turns | $${result.usage.cost.toFixed(4)}${result.usage.costSource === 'estimate' ? ' (estimate)' : ''}`,
        );
      }
    }
  }
}
await mock?.close();

function countScore(scored) {
  const c = { correct: 0, wrong: 0, missing: 0, missingOk: 0 };
  for (const f of Object.values(scored.fields)) {
    if (f.status === 'correct') c.correct++;
    else if (f.status === 'wrong') c.wrong++;
    else if (f.status === 'missing') c.missing++;
    else c.missingOk++;
  }
  return c;
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const models = [...new Set(runs.map((r) => r.model))];
const lines = [];
for (const name of docNames) {
  const doc = DOCS[name];
  const keys = Object.keys(doc.truth);
  lines.push(`\n### ${name} (cells: correct/wrong/missing over runs)\n`);
  lines.push(`| field | ${models.join(' | ')} |`);
  lines.push(`| --- | ${models.map(() => '---').join(' | ')} |`);
  for (const key of keys) {
    const cells = models.map((m) => {
      const rs = runs.filter((r) => r.model === m && r.doc === name);
      const st = rs.map((r) => r.score.fields[key].status);
      const c = st.filter((s) => s === 'correct').length;
      const w = st.filter((s) => s === 'wrong').length;
      const miss = st.filter((s) => s.startsWith('missing')).length;
      return `${c}/${w}/${miss}`;
    });
    lines.push(
      `| ${key}${doc.missingIsFine.includes(key) ? ' (missing ok)' : ''} | ${cells.join(' | ')} |`,
    );
  }
  lines.push(
    `\n| ${name} totals (expect ${doc.expect}) | runs | ending ok | correct | WRONG | missing | model s/scan | wall s/scan | turns | in tok | out tok | cost $/scan |`,
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const m of models) {
    const rs = runs.filter((r) => r.model === m && r.doc === name);
    const counts = rs.map((r) => countScore(r.score));
    const sum = (k) => counts.reduce((a, c) => a + c[k], 0);
    lines.push(
      `| ${m} | ${rs.length} | ${rs.filter((r) => r.score.ending === 'ok').length} | ${sum('correct')} | ${sum('wrong')} | ${sum('missing')}${sum('missingOk') ? ` (+${sum('missingOk')} ok)` : ''} | ${(mean(rs.map((r) => r.modelMs)) / 1000).toFixed(1)} | ${(mean(rs.map((r) => r.wallMs)) / 1000).toFixed(1)} | ${mean(rs.map((r) => r.modelTurns)).toFixed(1)} | ${Math.round(mean(rs.map((r) => r.usage.input + r.usage.cacheRead + r.usage.cacheWrite)))} | ${Math.round(mean(rs.map((r) => r.usage.output)))} | ${mean(rs.map((r) => r.usage.cost)).toFixed(4)} |`,
    );
  }
  const wrongs = runs
    .filter((r) => r.doc === name)
    .flatMap((r) =>
      Object.entries(r.score.fields)
        .filter(([, f]) => f.status === 'wrong')
        .map(
          ([k, f]) =>
            `- ${r.model} run ${r.run}: ${k} = ${JSON.stringify(f.got)} (expected ${JSON.stringify(f.expected)})`,
        ),
    );
  const endings = runs
    .filter((r) => r.doc === name && r.score.ending !== 'ok')
    .map(
      (r) =>
        `- ${r.model} run ${r.run}: ${r.score.ending}${r.score.ending === 'finished_early' ? '' : ` (${r.error})`}`,
    );
  if (wrongs.length) lines.push(`\nWrong values:\n${wrongs.join('\n')}`);
  if (endings.length)
    lines.push(
      `\nWrong endings (unfinished scans score the fields from the last record_fields):\n${endings.join('\n')}`,
    );
}
lines.push(
  '\n### All documents\n',
  '| model | runs | ending ok | finished early | stalled | error | correct | WRONG | missing | cost $/pass |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
);
for (const m of models) {
  const rs = runs.filter((r) => r.model === m);
  const counts = rs.map((r) => countScore(r.score));
  const sum = (k) => counts.reduce((a, c) => a + c[k], 0);
  const endingCount = (e) => rs.filter((r) => r.score.ending === e).length;
  // One pass = one scan of every document: the mean cost per scan of each document, summed.
  const pass = docNames.reduce(
    (a, name) => a + mean(rs.filter((r) => r.doc === name).map((r) => r.usage.cost)),
    0,
  );
  lines.push(
    `| ${m} | ${rs.length} | ${endingCount('ok')} | ${endingCount('finished_early')} | ${endingCount('stalled')} | ${endingCount('error')} | ${sum('correct')} | ${sum('wrong')} | ${sum('missing')} | ${pass.toFixed(4)} |`,
  );
}
if (skipped.length)
  lines.push(`\nSkipped: ${skipped.map((s) => `${s.spec} (${s.needed})`).join('; ')}`);
const report = lines.join('\n');
console.log(report);

// Results hold personal data: they go to the gitignored results/ folder unless --out says otherwise.
const outPath = resolve(
  args.out ??
    join(HERE, 'results', `${MODE}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    {
      mode: MODE,
      date: new Date().toISOString(),
      runs,
      skipped,
      report,
    },
    null,
    2,
  ),
);
console.log(`\nResults: ${outPath}`);
