/**
 * Browser capture (DEVELOPMENT ONLY): records what a procedure's browser context did, as raw
 * material for offline mock sites (SpainBench). Off unless `BrowserServiceOptions.capture` is set.
 *
 * While a context lives, everything goes to a private scratch directory: the HAR (Playwright
 * writes it when the context closes), the raw trace files (the browser's `tracesDir`), the HTML
 * of every page and frame after each action, and `actions.jsonl`. When the context ends (closed,
 * the procedure stopped, the app quitting, the browser gone) `finish` scrubs every secret the
 * session typed with `secret: true` (plus the TLS sidecar's proxy password) out of each file and
 * writes the result to `<dir>/<run>/`. The scratch copy is then deleted; anything a crash leaves
 * there is deleted by the next service (`claimScratch`). The capture folder only ever gets
 * scrubbed files.
 *
 * Personal data (names, DNI numbers, addresses...) is NOT scrubbed: capture only with synthetic
 * or throwaway accounts. See README.md ("Browser capture").
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { secretVariants } from './errors';
import { withTimeout } from './util';
import { readZip, writeZip, type ZipEntry } from './zip';

export interface CaptureOptions {
  /**
   * The folder of a procedure's captures, asked when a run is saved; each run gets a
   * `<start time>` subfolder. Undefined discards the run (e.g. the procedure was deleted).
   */
  dir(procedureId: string): string | undefined;
  /**
   * Private scratch space for unscrubbed files while contexts are open (e.g. under the app's
   * temporary directory). A new service deletes whatever earlier ones left there.
   */
  scratchDir: string;
  /**
   * Replace the secrets a procedure typed with `secret: true` in everything saved. Default true.
   * Only synthetic runs (the eval suite, with made-up accounts) turn it off, to keep the typed
   * values in the HAR, the pages and the trace; the TLS helper's password is redacted either way.
   */
  scrub?: boolean;
}

/** The agent tool call behind a browser action, for `actions.jsonl`. */
export interface CaptureToolCall {
  tool: string;
  args?: unknown;
}

const toolCalls = new AsyncLocalStorage<CaptureToolCall>();

/**
 * Runs `fn` with `call` as the agent tool call of the browser actions it makes (recorded in
 * captures only). Its args are scrubbed like the rest of the capture.
 */
export function withCaptureTool<T>(call: CaptureToolCall, fn: () => Promise<T>): Promise<T> {
  return toolCalls.run(call, fn);
}

export function currentCaptureTool(): CaptureToolCall | undefined {
  return toolCalls.getStore();
}

/**
 * Init script of captured contexts: fields marked `data-sa-secret` render as dots, so trace
 * screenshots don't show secrets typed into plain text fields. An adopted stylesheet is not part
 * of the page's HTML (`page.content()`).
 */
export const SECRET_FIELD_STYLE = `(() => {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('[data-sa-secret]{-webkit-text-security:disc !important}');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {}
})();`;

export interface CaptureStep {
  /** The BrowserService method (open, click, type...). */
  action: string;
  args: Record<string, unknown>;
  /** The element a ref pointed to, from the snapshot the agent saw. */
  target?: { ref: string; role?: string; name?: string };
  tool?: CaptureToolCall;
  /** The action's error, as the agent got it. */
  error?: string;
}

const MAX_FRAMES = 20;
/** Scratch directories of the services alive in this process (see `claimScratch`). */
const liveScratch = new Set<string>();

/** Scratch directory of a new service, after deleting what dead services left behind. */
export async function claimScratch(root: string): Promise<string> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const names = await fs.readdir(root).catch(() => [] as string[]);
  await Promise.all(
    names
      .map((name) => path.join(root, name))
      .filter((dir) => !liveScratch.has(dir))
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
  const dir = path.join(root, randomUUID());
  liveScratch.add(dir);
  await fs.mkdir(dir, { mode: 0o700 });
  return dir;
}

export async function releaseScratch(dir: string): Promise<void> {
  liveScratch.delete(dir);
  await fs.rm(dir, { recursive: true, force: true });
}

/** Playwright's `tracesDir` for a service's scratch directory. */
export function tracesDirOf(scratch: string): string {
  return path.join(scratch, 'traces');
}

/** One recorded browser context. */
export class CaptureRun {
  /** Trace name (its raw files in tracesDir are `<id>.*`). */
  readonly id = randomUUID();
  readonly startedAt = new Date();
  private steps = 0;
  private readonly dir: string;

  private constructor(scratch: string) {
    this.dir = path.join(scratch, 'runs', this.id);
  }

  static async create(scratch: string): Promise<CaptureRun> {
    const run = new CaptureRun(scratch);
    await fs.mkdir(path.join(run.dir, 'pages'), { recursive: true, mode: 0o700 });
    return run;
  }

  get harPath(): string {
    return path.join(this.dir, 'network.har');
  }

  get tracePath(): string {
    return path.join(this.dir, 'trace.zip');
  }

  /** Saves the HTML of every page and frame, then the step's line of `actions.jsonl`. */
  async recordStep(step: CaptureStep, pages: Page[], active: Page | undefined): Promise<void> {
    const n = ++this.steps;
    const prefix = String(n).padStart(4, '0');
    const tabs = [];
    for (const [t, page] of pages.entries()) {
      if (page.isClosed()) continue;
      const frames = [];
      for (const [f, frame] of page.frames().slice(0, MAX_FRAMES).entries()) {
        const html = await withTimeout(frame.content(), 5_000, undefined);
        let file: string | undefined;
        if (html !== undefined) {
          file = `pages/${prefix}-t${t}-f${f}.html`;
          await fs.writeFile(path.join(this.dir, file), html, { mode: 0o600 });
        }
        frames.push({ index: f, url: frame.url(), name: frame.name() || undefined, file });
      }
      tabs.push({
        tab: t,
        active: page === active,
        url: page.url(),
        title: await withTimeout(page.title(), 2_000, ''),
        frames,
      });
    }
    const line = { step: n, at: new Date().toISOString(), ...step, pages: tabs };
    await fs.appendFile(path.join(this.dir, 'actions.jsonl'), `${JSON.stringify(line)}\n`, {
      mode: 0o600,
    });
  }

  /**
   * Scrubs the run into `<dir>/<start time>/` (nothing when `dir` is undefined) and deletes the
   * scratch copy, also on failure. `secrets` become «secret:<n>» (n = their order), `redact`
   * values «redacted». The context must be closed already (Playwright writes the HAR then).
   */
  async finish(opts: {
    dir: string | undefined;
    secrets: string[];
    redact: string[];
    /** The typed secrets are kept (`secrets` is empty): the capture says so. */
    keepTyped?: boolean;
    tracesDir: string;
    browserVersion?: string;
  }): Promise<string | undefined> {
    const read = (name: string) => fs.readFile(path.join(this.dir, name)).catch(() => undefined);
    const trace = await read('trace.zip');
    let traceEntries: ZipEntry[] | undefined;
    try {
      traceEntries = trace ? readZip(trace) : undefined;
      if (!opts.dir) return undefined;
      const scrubber = new Scrubber(opts.secrets, opts.redact);
      const out = await createRunDir(opts.dir, this.startedAt);
      const write = (name: string, data: Buffer | string) =>
        fs.writeFile(path.join(out, name), data, { mode: 0o600 });

      await fs.mkdir(path.join(out, 'pages'), { mode: 0o700 });
      for (const name of (await fs.readdir(path.join(this.dir, 'pages'))).sort()) {
        const html = await read(`pages/${name}`);
        if (html) await write(`pages/${name}`, scrubber.buffer(html));
      }
      const actions = await read('actions.jsonl');
      await write('actions.jsonl', actions ? scrubber.buffer(actions) : '');
      const har = await read('network.har');
      if (har) await write('network.har', JSON.stringify(scrubber.har(JSON.parse(String(har)))));
      if (traceEntries) {
        const entries = traceEntries.map((e) => ({ name: e.name, data: scrubber.buffer(e.data) }));
        await write('trace.zip', writeZip(entries));
      }
      // Last: a run without capture.json is incomplete.
      await write(
        'capture.json',
        `${JSON.stringify(
          {
            startedAt: this.startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            steps: this.steps,
            browserVersion: opts.browserVersion,
            har: !!har,
            trace: !!traceEntries,
            secrets: opts.secrets.length,
            scrubbed: opts.keepTyped
              ? 'Only the TLS helper password. Typed secrets and personal data are NOT scrubbed: synthetic data only.'
              : 'Secrets typed with secret: true (as «secret:<n>», in raw, URL, form, JSON and HTML encodings) and the TLS helper password. Personal data is NOT scrubbed.',
          },
          null,
          2,
        )}\n`,
      );
      return out;
    } finally {
      await fs.rm(this.dir, { recursive: true, force: true });
      await this.dropRawTrace(opts.tracesDir, traceEntries);
    }
  }

  /**
   * Deletes this run's raw trace files, and the shared trace resources (response bodies,
   * screenshots) its trace used, except those another open run uses too. What stays is deleted
   * with the scratch directory when the service closes.
   */
  private async dropRawTrace(tracesDir: string, entries: ZipEntry[] | undefined): Promise<void> {
    const files = await fs.readdir(tracesDir).catch(() => [] as string[]);
    const own = files.filter((name) => name.startsWith(this.id));
    await Promise.all(own.map((name) => fs.rm(path.join(tracesDir, name), { force: true })));
    const resources = (entries ?? [])
      .filter((e) => e.name.startsWith('resources/'))
      .map((e) => e.name.slice('resources/'.length));
    if (!resources.length) return;
    const others = await Promise.all(
      files
        .filter((name) => !name.startsWith(this.id) && /\.(?:trace|network)$/.test(name))
        .map((name) => fs.readFile(path.join(tracesDir, name), 'utf8').catch(() => '')),
    );
    const used = others.join('\n');
    await Promise.all(
      resources
        .filter((name) => !used.includes(name))
        .map((name) => fs.rm(path.join(tracesDir, 'resources', name), { force: true })),
    );
  }
}

async function createRunDir(dir: string, startedAt: Date): Promise<string> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  for (let n = 1; ; n++) {
    const out = path.join(dir, n === 1 ? stamp : `${stamp}-${n}`);
    try {
      await fs.mkdir(out, { mode: 0o700 });
      return out;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n > 100) throw err;
    }
  }
}

/** Header values replaced whole: they carry the TLS helper's proxy password. */
const REDACTED_HEADERS = new Set(['proxy-authorization']);

/** Replaces secrets (and their encodings) with placeholders in text, bytes and HARs. */
export class Scrubber {
  private readonly rules: { text: string; bytes: Buffer; placeholder: Buffer; label: string }[];

  constructor(secrets: string[], redact: string[] = []) {
    const rules = new Map<string, string>();
    const add = (value: string, label: string) => {
      for (const variant of captureVariants(value))
        if (!rules.has(variant)) rules.set(variant, label);
    };
    for (const [i, secret] of secrets.entries()) add(secret, `«secret:${i + 1}»`);
    for (const value of redact) add(value, '«redacted»');
    this.rules = [...rules]
      .sort((a, b) => b[0].length - a[0].length)
      .map(([text, label]) => ({
        text,
        bytes: Buffer.from(text, 'utf8'),
        placeholder: Buffer.from(label, 'utf8'),
        label,
      }));
  }

  text(value: string): string {
    let out = value;
    for (const rule of this.rules)
      if (out.includes(rule.text)) out = out.split(rule.text).join(rule.label);
    return out;
  }

  buffer(value: Buffer): Buffer {
    let out = value;
    for (const rule of this.rules) {
      let at = out.indexOf(rule.bytes);
      if (at < 0) continue;
      const parts: Buffer[] = [];
      let from = 0;
      while (at >= 0) {
        parts.push(out.subarray(from, at), rule.placeholder);
        from = at + rule.bytes.length;
        at = out.indexOf(rule.bytes, from);
      }
      parts.push(out.subarray(from));
      out = Buffer.concat(parts);
    }
    return out;
  }

  /** Every string of a HAR, base64 bodies decoded first; proxy credentials dropped whole. */
  har(value: unknown): unknown {
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map((v) => this.har(v));
    if (!value || typeof value !== 'object') return value;
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(obj)) out[key] = this.har(v);
    if (typeof obj.name === 'string' && REDACTED_HEADERS.has(obj.name.toLowerCase()))
      out.value = '«redacted»';
    if (obj.encoding === 'base64' && typeof obj.text === 'string') {
      const raw = Buffer.from(obj.text, 'base64');
      const scrubbed = this.buffer(raw);
      out.text = scrubbed === raw ? obj.text : scrubbed.toString('base64');
    }
    return out;
  }
}

/** How a secret may appear in captured files: raw, URL/form/JSON-encoded, HTML-escaped. */
export function captureVariants(secret: string): string[] {
  const variants = new Set(secretVariants(secret));
  for (const v of [...variants]) {
    variants.add(
      v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    );
  }
  return [...variants].filter(Boolean);
}
