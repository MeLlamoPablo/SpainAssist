import type { BrowserObservation } from '@sa/shared';
import { BridgeError, type BridgeTransport } from '../bridge/client';
import { searchBoe } from '../research/boe';
import {
  type BlockedRequest,
  decodeBody,
  type FetchedDocument,
  fetchDocument,
  fetchPublic,
  type HostResolver,
  pdfToText,
  readCapped,
  sliceText,
  USER_AGENT,
} from '../research/fetch';
import type { AnyToolDefinition } from '../tools/common';
import { type HostOp, HostOpError } from './workflow-run';

/**
 * The codemode operations of the agent host: what each `api.*` call of a workflow does. Most go
 * to the app over the bridge (the app enforces every policy again: roles, domains, approvals);
 * research and public HTTP run here, as the tools did. Results are JSON for the workflow, never
 * prose to parse.
 */

export interface ImageStore {
  put(mimeType: string, dataBase64: string): { imageId: string; mimeType: string };
  get(imageId: string): { mimeType: string; dataBase64: string } | undefined;
}

export function createImageStore(max = 20): ImageStore {
  const images = new Map<string, { mimeType: string; dataBase64: string }>();
  let n = 0;
  return {
    put(mimeType, dataBase64) {
      const imageId = `img_${++n}`;
      images.set(imageId, { mimeType, dataBase64 });
      while (images.size > max) images.delete(images.keys().next().value as string);
      return { imageId, mimeType };
    },
    get: (imageId) => images.get(imageId),
  };
}

export interface HostOpsDeps {
  bridge: BridgeTransport;
  images: ImageStore;
  /** The current run's id (ops scoped to the workflow). */
  runId(): string;
  /** The workflow's procedures, primary first (prompts and downloads belong to the primary). */
  procedures(): string[];
  /** Web research as a tool (web_research, or exa_search for BYOK), when configured. */
  research?: { kind: 'web_research' | 'exa'; search: AnyToolDefinition };
  imagesSupported: boolean;
  allowPrivateHosts?: boolean;
  fetchImpl?: typeof fetch;
  resolveHost?: HostResolver;
  onBlocked?: (request: BlockedRequest) => void;
  boeBaseUrl?: string;
}

/** A target from the sandbox (a locator chain) as the browser's `ref`. */
export function encodeTarget(target: unknown): string {
  if (!Array.isArray(target) || target.length === 0)
    throw new HostOpError('bad_request', 'Expected a locator or a ref.', 'not_started');
  const first = target[0] as unknown[];
  if (target.length === 1 && Array.isArray(first) && first[0] === 'ref') return String(first[1]);
  return `loc:${JSON.stringify(target)}`;
}

/** An observation without what only the model's snapshot needs. */
function actionResult(o: BrowserObservation) {
  return {
    url: o.url,
    title: o.title,
    downloads: o.downloads,
    signatures: o.signatures,
    dialogs: o.dialogs,
    notes: o.notes,
    pageErrors: o.pageErrors,
  };
}

function snapshotResult(o: BrowserObservation) {
  return { ...actionResult(o), snapshot: o.snapshot, truncated: o.truncated, tabs: o.tabs };
}

const NOT_STARTED = new Set([
  'bad_request',
  'policy_denied',
  'not_found',
  'unauthorized',
  'conflict',
]);

function toHostError(error: unknown): unknown {
  if (error instanceof BridgeError) {
    if (error.code === 'aborted') return error;
    return new HostOpError(
      error.code,
      error.message,
      NOT_STARTED.has(error.code) ? 'not_started' : 'unknown',
      error.code === 'timeout' || error.code === 'network' || error.code === 'unavailable',
    );
  }
  return error;
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
    .join('\n')
    .trim();
}

/** web_research's JSON result as an answer with its sources; other tools' text as is. */
function researchText(result: {
  content: { type: string; text?: string }[];
  structuredContent?: unknown;
}): string {
  const structured = result.structuredContent as
    | {
        output?: {
          content?: unknown;
          basis?: {
            url?: string;
            title?: string;
            citations?: { url?: string; title?: string }[];
          }[];
        };
      }
    | undefined;
  const output = structured?.output;
  if (!output) return text(result);
  const answer =
    typeof output.content === 'string' ? output.content : JSON.stringify(output.content, null, 2);
  const urls = new Map<string, string>();
  for (const b of output.basis ?? []) {
    if (b.url) urls.set(b.url, b.title ?? b.url);
    for (const c of b.citations ?? []) if (c.url) urls.set(c.url, c.title ?? c.url);
  }
  const sources = [...urls].slice(0, 20).map(([url, title]) => `- ${title}: ${url}`);
  return sources.length ? `${answer}\n\nSources:\n${sources.join('\n')}` : answer;
}

function str(value: unknown, what: string, max = 10_000): string {
  if (typeof value !== 'string' || !value.trim())
    throw new HostOpError('bad_request', `${what} must be a non-empty string.`, 'not_started');
  if (value.length > max)
    throw new HostOpError('bad_request', `${what} is too long.`, 'not_started');
  return value;
}

export function createHostOps(deps: HostOpsDeps): HostOp {
  const { bridge } = deps;
  /** Accumulated downloads per procedure (observations report each once). */
  const downloads = new Map<string, BrowserObservation['downloads']>();

  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw toHostError(error);
    }
  };

  const primary = (): string | undefined => deps.procedures()[0];

  const noteDownloads = (procedureId: string, o: BrowserObservation) => {
    if (!o.downloads.length) return;
    const list = downloads.get(procedureId) ?? [];
    for (const d of o.downloads) if (!list.some((x) => x.downloadId === d.downloadId)) list.push(d);
    downloads.set(procedureId, list);
  };

  async function browser(
    op: string,
    a: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const procedureId = str(a.procedureId, 'procedureId', 64);
    const opts = { signal, procedureId };
    const observe = async (p: Promise<BrowserObservation>, full = false) => {
      const o = await p;
      noteDownloads(procedureId, o);
      return full ? snapshotResult(o) : actionResult(o);
    };
    const target = () => encodeTarget(a.target);
    switch (op) {
      case 'goto':
        return observe(
          bridge.call('browser.open', { url: str(a.url, 'url', 4000), newTab: !!a.newTab }, opts),
        );
      case 'goBack':
        return observe(bridge.call('browser.back', {}, opts));
      case 'reload':
        return observe(bridge.call('browser.reload', {}, opts));
      case 'info':
        return bridge.call('browser.info', {}, opts);
      case 'snapshot':
        return observe(bridge.call('browser.snapshot', {}, opts), true);
      case 'wait': {
        const o = await bridge.call(
          'browser.wait',
          {
            ...(typeof a.text === 'string' ? { text: a.text } : {}),
            ...(typeof a.textGone === 'string' ? { textGone: a.textGone } : {}),
            ...(typeof a.seconds === 'number' ? { seconds: a.seconds } : {}),
          },
          opts,
        );
        noteDownloads(procedureId, o);
        return typeof a.text === 'string' || typeof a.textGone === 'string'
          ? snapshotResult(o)
          : undefined;
      }
      case 'press':
        if (Array.isArray(a.target))
          return (
            await bridge.call(
              'browser.query',
              { target: target(), op: 'press', args: { key: String(a.key ?? '') } },
              opts,
            )
          ).value;
        return observe(bridge.call('browser.press', { key: str(a.key, 'key', 40) }, opts));
      case 'click':
        return observe(bridge.call('browser.click', { ref: target() }, opts));
      case 'fill':
        return observe(
          bridge.call(
            'browser.type',
            { ref: target(), text: String(a.value ?? ''), submit: !!a.submit },
            opts,
          ),
        );
      case 'check':
        return observe(
          bridge.call('browser.check', { ref: target(), checked: a.checked !== false }, opts),
        );
      case 'selectOption':
        return observe(
          bridge.call(
            'browser.select',
            { ref: target(), values: (a.values as string[]) ?? [] },
            opts,
          ),
        );
      case 'setInputFiles':
        return observe(
          bridge.call(
            'browser.upload',
            { ref: target(), documentIds: (a.documentIds as string[]) ?? [] },
            opts,
          ),
        );
      case 'fillFromVault':
        return observe(
          bridge.call(
            'browser.fillFromVault',
            { ref: target(), key: str(a.key, 'key', 80), submit: !!a.submit },
            opts,
          ),
        );
      case 'fillFromUser':
        return observe(
          bridge.call(
            'browser.fillFromUser',
            {
              ref: target(),
              title: str(a.title, 'title', 160),
              label: str(a.label, 'label', 100),
              ...(typeof a.message === 'string' ? { message: a.message } : {}),
              submit: !!a.submit,
            },
            opts,
          ),
        );
      case 'loginClave':
        return observe(
          bridge.call(
            'browser.loginClave',
            {
              usernameRef: encodeTarget(a.username),
              passwordRef: encodeTarget(a.password),
              rejected: !!a.rejected,
              ...(typeof a.message === 'string' ? { message: a.message } : {}),
            },
            opts,
          ),
        );
      case 'useCertificate':
        return bridge.call(
          'browser.useCertificate',
          {
            credentialId: str(a.credentialId, 'credentialId', 120),
            ...(Array.isArray(a.origins) ? { origins: a.origins as string[] } : {}),
          },
          opts,
        );
      case 'screenshot': {
        if (!deps.imagesSupported)
          throw new HostOpError(
            'policy_denied',
            'This model cannot see images: read page.snapshot() instead.',
            'not_started',
          );
        const shot = await bridge.call('browser.screenshot', { fullPage: !!a.fullPage }, opts);
        return deps.images.put(shot.mimeType, shot.dataBase64);
      }
      case 'tabs': {
        const action = a.action === 'select' || a.action === 'close' ? a.action : 'list';
        const result = await bridge.call(
          'browser.tabs',
          { action, ...(typeof a.index === 'number' ? { index: a.index } : {}) },
          opts,
        );
        return action === 'list' ? result.tabs : undefined;
      }
      case 'close':
        return bridge.call('browser.close', {}, opts);
      case 'reopenHeaded':
        return observe(bridge.call('browser.reopenHeaded', {}, opts), true);
      case 'downloads':
        return downloads.get(procedureId) ?? [];
      default: {
        const queryOps = new Set([
          'textContent',
          'innerText',
          'inputValue',
          'getAttribute',
          'isVisible',
          'isEnabled',
          'isChecked',
          'count',
          'allTextContents',
          'allInnerTexts',
          'waitFor',
          'hover',
          'focus',
          'dblclick',
          'evaluate',
          'evaluateAll',
        ]);
        if (!queryOps.has(op))
          throw new HostOpError('bad_request', `Unknown browser operation ${op}.`, 'not_started');
        const pageLevel = Array.isArray(a.target) && a.target.length === 0;
        const options = (a.options ?? {}) as Record<string, unknown>;
        const result = await bridge.call(
          'browser.query',
          {
            target: pageLevel ? '' : target(),
            op: op as 'count',
            args: {
              ...(typeof a.name === 'string' ? { name: a.name } : {}),
              ...(typeof a.fn === 'string' ? { fn: a.fn } : {}),
              ...(a.arg !== undefined ? { arg: a.arg } : {}),
              ...(typeof options.state === 'string' ? { state: options.state } : {}),
              ...(typeof options.timeout === 'number'
                ? { timeout: Math.min(60_000, Math.round(options.timeout)) }
                : {}),
            },
          },
          opts,
        );
        if (result.observation) noteDownloads(procedureId, result.observation);
        return result.observation ? actionResult(result.observation) : result.value;
      }
    }
  }

  async function readDocument(a: Record<string, unknown>, signal: AbortSignal) {
    const doc = await bridge.call(
      'vault.document',
      { documentId: str(a.id, 'id', 120) },
      { signal },
    );
    const bytes = Buffer.from(doc.dataBase64, 'base64');
    const base = { id: doc.id, name: doc.name, mimeType: doc.mimeType };
    if (doc.mimeType === 'application/pdf') {
      const pdf = await pdfToText(bytes);
      const offset = typeof a.offset === 'number' ? a.offset : 0;
      const page = sliceText(pdf.text, offset, 40_000);
      return {
        ...base,
        pages: pdf.pages,
        text: page.chunk,
        ...(page.nextOffset ? { nextOffset: page.nextOffset } : {}),
      };
    }
    if (doc.mimeType.startsWith('image/')) {
      if (!deps.imagesSupported)
        throw new HostOpError(
          'policy_denied',
          'This model cannot see images: ask the user for what you need.',
          'not_started',
        );
      return { ...base, image: deps.images.put(doc.mimeType, doc.dataBase64) };
    }
    if (doc.mimeType.startsWith('text/') || doc.mimeType === 'application/json')
      return { ...base, text: bytes.toString('utf8').slice(0, 100_000) };
    throw new HostOpError('bad_request', `Cannot read ${doc.mimeType} files.`, 'not_started');
  }

  async function fetchUrl(a: Record<string, unknown>, signal: AbortSignal) {
    const url = str(a.url, 'url', 4000);
    let doc: FetchedDocument;
    try {
      doc = await fetchDocument(url, {
        signal,
        mode: 'auto',
        allowPrivateHosts: deps.allowPrivateHosts,
        fetchImpl: deps.fetchImpl,
        resolveHost: deps.resolveHost,
        onBlocked: deps.onBlocked,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new HostOpError(
        'unavailable',
        `Could not read ${url}: ${(error as Error).message}`,
        'not_started',
        true,
      );
    }
    const page = sliceText(
      doc.text,
      typeof a.offset === 'number' ? a.offset : 0,
      Math.min(typeof a.maxChars === 'number' ? a.maxChars : 30_000, 100_000),
    );
    return {
      url: doc.url,
      ...(doc.title ? { title: doc.title } : {}),
      kind: doc.kind,
      text: page.chunk,
      truncated: page.nextOffset !== undefined || doc.truncatedBytes,
      ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
    };
  }

  async function httpFetch(a: Record<string, unknown>, signal: AbortSignal) {
    const url = str(a.url, 'url', 8000);
    const headers = new Headers((a.headers as Record<string, string>) ?? {});
    if (!headers.has('user-agent')) headers.set('user-agent', USER_AGENT);
    let start: URL;
    try {
      start = new URL(url);
    } catch {
      throw new HostOpError('bad_request', `Invalid URL: ${url}`, 'not_started');
    }
    try {
      const {
        res,
        url: final,
        redirects,
      } = await fetchPublic(start, {
        method: typeof a.method === 'string' ? a.method : undefined,
        headers,
        body: typeof a.body === 'string' ? a.body : undefined,
        signal,
        allowPrivateHosts: deps.allowPrivateHosts,
        fetchImpl: deps.fetchImpl,
        resolveHost: deps.resolveHost,
        onBlocked: deps.onBlocked,
      });
      const { bytes, truncated } = await readCapped(res, 5 * 1024 * 1024);
      return {
        status: res.status,
        statusText: res.statusText,
        url: final.href,
        redirected: redirects > 0,
        truncated,
        headers: Object.fromEntries(res.headers.entries()),
        text: decodeBody(res.headers.get('content-type') ?? '', bytes).text,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      throw new HostOpError(
        'unavailable',
        `fetch ${url} failed: ${(error as Error).message}`,
        'not_started',
        true,
      );
    }
  }

  const ops: Record<string, (a: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>> =
    {
      setStatus: async (a, signal) => {
        await bridge.call(
          'workflow.setStatus',
          { status: str(a.status, 'status', 120) },
          { signal },
        );
      },
      'procedures.list': async (a, signal) =>
        (await bridge.call('procs.list', { includeArchived: !!a.includeArchived }, { signal }))
          .procedures,
      'procedures.get': (a, signal) =>
        bridge.call('procs.get', { id: str(a.id, 'id', 64) }, { signal }),
      'procedures.getOrCreate': (a, signal) =>
        bridge.call(
          'procs.getOrCreate',
          { ...(a as { id: string; title: string }), runId: deps.runId() },
          { signal },
        ),
      'procedures.update': (a, signal) =>
        bridge.call(
          'procs.update',
          {
            id: str(a.id, 'id', 64),
            expectedVersion: typeof a.expectedVersion === 'number' ? a.expectedVersion : 0,
            patch: (a.patch ?? {}) as never,
          },
          { signal },
        ),
      'procedures.context': (a, signal) =>
        bridge.call('procs.context', { id: str(a.id, 'id', 64) }, { signal }),
      'procedures.setContext': async (a, signal) => {
        await bridge.call(
          'procs.setContext',
          { id: str(a.id, 'id', 64), context: (a.context ?? {}) as never },
          { signal },
        );
        return undefined;
      },
      'workflows.list': async (_a, signal) =>
        (await bridge.call('workflows.list', {}, { signal })).workflows,
      'workflows.get': (a, signal) =>
        bridge.call('workflows.get', { id: str(a.id, 'id', 64) }, { signal }),
      'workflows.cancel': async (a, signal) => {
        await bridge.call(
          'workflows.cancel',
          {
            id: str(a.id, 'id', 64),
            ...(typeof a.reason === 'string' ? { reason: a.reason } : {}),
          },
          { signal },
        );
        return undefined;
      },
      search: async (a, signal) => {
        if (!deps.research)
          throw new HostOpError(
            'unavailable',
            'Web research is not configured for this provider.',
            'not_started',
          );
        const prompt = str(a.prompt ?? a.query, 'prompt', 8000);
        const mode = a.mode === 'balanced' || a.mode === 'deep' ? a.mode : 'fast';
        const params =
          deps.research.kind === 'exa' ? { query: prompt.slice(0, 500) } : { query: prompt, mode };
        const result = await deps.research.search.execute(
          'codemode',
          params,
          signal,
          undefined,
          undefined as never,
        );
        if ((result as { isError?: boolean }).isError)
          throw new HostOpError(
            'unavailable',
            text(result) || 'Web research failed.',
            'not_started',
            true,
          );
        return researchText(result);
      },
      fetchUrl,
      fetch: httpFetch,
      'boe.search': async (a, signal) => {
        const laws = await searchBoe(
          { query: str(a.query, 'query', 300), ...(a.field === 'texto' ? { field: 'texto' } : {}) },
          {
            signal,
            ...(deps.boeBaseUrl ? { baseUrl: deps.boeBaseUrl } : {}),
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          },
        );
        return laws;
      },
      'vault.read': (a, signal) =>
        bridge.call('vault.read', Array.isArray(a.keys) ? { keys: a.keys as string[] } : {}, {
          signal,
        }),
      'vault.save': (a, signal) =>
        bridge.call('vault.save', { items: (a.items ?? []) as never }, { signal }),
      'documents.read': readDocument,
      'documents.saveDownload': (a, signal) =>
        bridge.call(
          'downloads.save',
          { downloadId: str(a.downloadId, 'downloadId', 120), name: str(a.name, 'name', 120) },
          { signal, procedureId: primary() },
        ),
      'documents.rename': (a, signal) =>
        bridge.call(
          'vault.renameDocument',
          { documentId: str(a.id, 'id', 120), name: str(a.name, 'name', 120) },
          { signal },
        ),
      'feedback.search': async (a, signal) =>
        (await bridge.call('feedback.search', a as { query: string }, { signal })).results,
      'feedback.submit': (a, signal) => bridge.call('feedback.submit', a as never, { signal }),
      'feedback.vote': (a, signal) => bridge.call('feedback.vote', a as never, { signal }),
      'user.confirm': (a, signal) => {
        const kind = a.kind === 'submission' || a.kind === 'payment' ? a.kind : 'action';
        return bridge.call(
          'prompt.confirm',
          {
            confirmKind: kind,
            title: str(a.title, 'title', 160),
            message: str(a.message, 'message', 2000),
            ...(Array.isArray(a.details)
              ? { details: a.details as { label: string; value: string }[] }
              : {}),
            ...(typeof a.confirmLabel === 'string' ? { confirmLabel: a.confirmLabel } : {}),
            ...(typeof a.rejectLabel === 'string' ? { rejectLabel: a.rejectLabel } : {}),
            ...(a.danger === true ? { danger: true } : {}),
          },
          { signal, procedureId: primary() },
        );
      },
      'user.requestAction': (a, signal) =>
        bridge.call(
          'prompt.userAction',
          {
            actionKind: a.kind as 'manual_step',
            title: str(a.title, 'title', 160),
            message: str(a.message, 'message', 2000),
            showBrowser: a.showBrowser !== false,
            attachScreenshot: !!a.attachScreenshot,
          },
          { signal, procedureId: primary() },
        ),
      'user.requestCredential': (a, signal) =>
        bridge.call(
          'prompt.credential',
          {
            credential: a.credential as 'clave_permanente',
            title: str(a.title, 'title', 160),
            message: str(a.message, 'message', 2000),
          },
          { signal, procedureId: primary() },
        ),
      'user.phoneCall': (a, signal) =>
        bridge.call('prompt.phoneCall', a as never, { signal, procedureId: primary() }),
    };

  return async (op, args, { signal }) => {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    if (op.startsWith('browser.')) return call(() => browser(op.slice(8), a, signal));
    const fn = ops[op];
    if (!fn) throw new HostOpError('bad_request', `Unknown operation ${op}.`, 'not_started');
    return call(() => fn(a, signal));
  };
}
