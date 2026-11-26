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
  pdfImageSizes,
  pdfPage,
  pdfToText,
  readCapped,
  sliceText,
  USER_AGENT,
} from '../research/fetch';
import type { AnyToolDefinition } from '../tools/common';
import { type HostOp, HostOpError } from './run';

/**
 * The codemode operations of the agent host: what each `api.*` call of a run does. Most go
 * to the app over the bridge (the app enforces every policy again: roles, domains, approvals);
 * research and public HTTP run here, as the tools did. Results are JSON for the module, never
 * prose to parse.
 */

/** An image a run made, and where it came from (its caption when the module gives no label). */
interface StoredImage {
  mimeType: string;
  dataBase64: string;
  source?: string;
}

export interface ImageStore {
  put(mimeType: string, dataBase64: string, source?: string): { imageId: string; mimeType: string };
  get(imageId: string): StoredImage | undefined;
}

export function createImageStore(max = 20): ImageStore {
  const images = new Map<string, StoredImage>();
  let n = 0;
  return {
    put(mimeType, dataBase64, source) {
      const imageId = `img_${++n}`;
      images.set(imageId, { mimeType, dataBase64, ...(source ? { source } : {}) });
      while (images.size > max) images.delete(images.keys().next().value as string);
      return { imageId, mimeType };
    },
    get: (imageId) => images.get(imageId),
  };
}

export interface HostOpsDeps {
  bridge: BridgeTransport;
  /** The run the operations belong to (its end closes the certificate blocks it left open). */
  runId?: string;
  images: ImageStore;
  /** The run's procedures, the one touched last first (prompts and documents go to it). */
  procedures(): string[];
  /** Web research as a tool (web_research, or exa_search for BYOK), when configured. */
  research?: { kind: 'web_research' | 'exa'; search: AnyToolDefinition };
  /**
   * With research: whether the model read search results before this run (an earlier run's
   * report showed them). documents.create refuses until then.
   */
  researched?: () => boolean;
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

/** documents.create before the model read any search results (HostOpsDeps.researched). */
export const RESEARCH_FIRST =
  'Research first, in a run of its own: api.search what this kind of document legally requires (content, formalities, what must be done afterwards, like taxes or registration). Read the results, then create the document following them in a later run.';

export function createHostOps(deps: HostOpsDeps): HostOp {
  const { bridge } = deps;
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw toHostError(error);
    }
  };

  const primary = (): string | undefined => deps.procedures()[0];

  async function browser(
    op: string,
    a: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const procedureId = str(a.procedureId, 'procedureId', 64);
    const opts = { signal, procedureId };
    const observe = async (p: Promise<BrowserObservation>, full = false) => {
      const o = await p;
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
            { ref: target(), documents: (a.documents as string[]) ?? [] },
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
            ...(a.credentialId !== undefined
              ? { credentialId: str(a.credentialId, 'credentialId', 120) }
              : {}),
            ...(Array.isArray(a.origins) ? { origins: a.origins as string[] } : {}),
            ...(deps.runId ? { runId: deps.runId } : {}),
          },
          opts,
        );
      case 'endCertificate':
        return bridge.call(
          'browser.endCertificate',
          { blockId: str(a.blockId, 'blockId', 64) },
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
        return deps.images.put(shot.mimeType, shot.dataBase64, 'screenshot of the browser page');
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
        return (await bridge.call('downloads.list', {}, opts)).downloads;
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
        return result.observation ? actionResult(result.observation) : result.value;
      }
    }
  }

  async function readDocument(a: Record<string, unknown>, signal: AbortSignal) {
    const doc = await bridge.call(
      'vault.document',
      { document: str(a.name, 'name', 255) },
      { signal },
    );
    const bytes = Buffer.from(doc.dataBase64, 'base64');
    const base = { name: doc.name, mimeType: doc.mimeType };
    if (doc.mimeType === 'application/pdf') {
      if (a.page !== undefined) {
        let page: Awaited<ReturnType<typeof pdfPage>>;
        try {
          page = await pdfPage(bytes, Number(a.page), { image: deps.imagesSupported });
        } catch (error) {
          if (error instanceof RangeError)
            throw new HostOpError('bad_request', error.message, 'not_started');
          throw error;
        }
        return {
          ...base,
          pages: page.pages,
          text: page.text,
          ...(page.png ? { image: pageImage(page, documentSource(doc, Number(a.page))) } : {}),
        };
      }
      const pdf = await pdfToText(bytes);
      const text = sliceText(pdf.text, 0, 40_000);
      return {
        ...base,
        pages: pdf.pages,
        text: text.chunk,
        ...(text.nextOffset ? { truncated: true } : {}),
      };
    }
    if (doc.mimeType.startsWith('image/')) {
      if (!deps.imagesSupported)
        throw new HostOpError(
          'policy_denied',
          'This model cannot see images: ask the user for what you need.',
          'not_started',
        );
      return {
        ...base,
        image: deps.images.put(doc.mimeType, doc.dataBase64, documentSource(doc)),
      };
    }
    if (doc.mimeType.startsWith('text/') || doc.mimeType === 'application/json')
      return { ...base, text: bytes.toString('utf8').slice(0, 100_000) };
    throw new HostOpError('bad_request', `Cannot read ${doc.mimeType} files.`, 'not_started');
  }

  /** A PDF page's image for the module, with its size (fill's points are its pixels). */
  function pageImage(page: { png?: Uint8Array; width?: number; height?: number }, source: string) {
    return {
      ...deps.images.put('image/png', Buffer.from(page.png ?? []).toString('base64'), source),
      width: page.width,
      height: page.height,
    };
  }

  /** Which document (and page) an image shows, for its caption. */
  function documentSource(doc: { name: string }, page?: number): string {
    return `${page ? `page ${page} of ` : ''}document "${doc.name}"`;
  }

  async function fillDocument(a: Record<string, unknown>, signal: AbortSignal) {
    if (!deps.imagesSupported)
      throw new HostOpError(
        'policy_denied',
        'Filling in a PDF needs a model that can see its pages: ask the user to fill it in.',
        'not_started',
      );
    const name = str(a.name, 'name', 255);
    if (!Array.isArray(a.values) || a.values.length === 0)
      throw new HostOpError('bad_request', 'values: a non-empty list.', 'not_started');
    const doc = await bridge.call('vault.document', { document: name }, { signal });
    if (doc.mimeType !== 'application/pdf')
      throw new HostOpError('bad_request', 'Only PDF documents can be filled in.', 'not_started');
    // The agent points in pixels of the page images documents.read gives; the app wants
    // fractions of the page.
    const sizes = await pdfImageSizes(Buffer.from(doc.dataBase64, 'base64'));
    const values = (a.values as unknown[]).map((raw, i) => {
      const v = (raw ?? {}) as Record<string, unknown>;
      const where = `Value ${i + 1}`;
      const page = Number(v.page);
      const size = sizes[page - 1];
      if (!Number.isInteger(page) || !size)
        throw new HostOpError(
          'bad_request',
          `${where}: page ${String(v.page)} doesn't exist (this PDF has ${sizes.length}).`,
          'not_started',
        );
      const x = Number(v.x);
      const y = Number(v.y);
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x > size.width ||
        y > size.height
      )
        throw new HostOpError(
          'bad_request',
          `${where}: (${String(v.x)}, ${String(v.y)}) is outside page ${page}'s image (${Math.floor(size.width)}×${Math.floor(size.height)} px).`,
          'not_started',
        );
      const text = typeof v.text === 'string' ? v.text : undefined;
      const check = v.check === true;
      if (!check && !text?.trim())
        throw new HostOpError('bad_request', `${where}: give text or check: true.`, 'not_started');
      return {
        page,
        x: x / size.width,
        y: y / size.height,
        ...(check ? { check: true } : { text: text as string }),
      };
    });
    const filled = await bridge.call(
      'vault.fillDocument',
      {
        document: name,
        values,
        ...(typeof a.copyName === 'string' && a.copyName.trim()
          ? { name: str(a.copyName, 'name', 120) }
          : {}),
      },
      { signal, procedureId: primary() },
    );
    // The pages written on, to look at (a run shows at most four images).
    const copy = await bridge.call('vault.document', { document: filled.name }, { signal });
    const bytes = Buffer.from(copy.dataBase64, 'base64');
    const pages = [];
    for (const n of filled.pages.slice(0, 4))
      pages.push({
        page: n,
        image: pageImage(await pdfPage(bytes, n, { image: true }), documentSource(filled, n)),
      });
    return {
      name: filled.name,
      pages,
      warnings: filled.warnings,
    };
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
        await bridge.call('run.setStatus', { status: str(a.status, 'status', 120) }, { signal });
      },
      'procedures.list': async (a, signal) =>
        (await bridge.call('procs.list', { includeArchived: !!a.includeArchived }, { signal }))
          .procedures,
      'procedures.get': (a, signal) =>
        bridge.call('procs.get', { id: str(a.id, 'id', 64) }, { signal }),
      'procedures.getOrCreate': (a, signal) =>
        bridge.call('procs.getOrCreate', a as { id: string; title: string }, { signal }),
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
      'runs.cancel': async (a, signal) => {
        await bridge.call(
          'run.cancel',
          {
            runId: str(a.runId, 'runId', 64),
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
          { document: str(a.name, 'name', 255), name: str(a.newName, 'newName', 120) },
          { signal },
        ),
      'documents.fill': fillDocument,
      'documents.create': async (a, signal) => {
        if (deps.research && deps.researched && !deps.researched())
          throw new HostOpError('bad_request', RESEARCH_FIRST, 'not_started');
        return bridge.call(
          'vault.createDocument',
          { name: str(a.name, 'name', 120), markdown: str(a.markdown, 'markdown', 200_000) },
          { signal, procedureId: primary() },
        );
      },
      'documents.sign': (a, signal) =>
        bridge.call(
          'vault.signDocument',
          { document: str(a.name, 'name', 255) },
          { signal, procedureId: primary() },
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
