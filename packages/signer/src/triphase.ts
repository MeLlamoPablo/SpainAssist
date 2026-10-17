/**
 * Triphase ("firma trifásica") client, as AutoFirma's *TriPhaseSigner / PreSigner / PostSigner /
 * TriphaseDataSigner implement it. The site's server builds the signature; we only compute a
 * PKCS#1 (RSA) or DER ECDSA signature over each PRE blob with the user's key.
 *
 *   POST serverUrl  op=pre&cop=sign&format=CAdES&algo=..&cert=<b64u>,<b64u>&doc=<b64u>&params=<b64u>
 *     <- Base64URL(TriphaseData XML) | "ERR-NN: message"
 *   (sign each PRE -> PK1)
 *   POST serverUrl  op=post&...&session=<b64u(XML)>&doc=..
 *     <- "OK NEWID=<b64u>" | "ERR-NN: message"
 *
 * Values are Base64URL tokens written unencoded into the body (the server URL-decodes them).
 */
import { randomUUID } from 'node:crypto';
import type { ResolvedAlgorithm } from './algorithms';
import { AfirmaError } from './errors';
import { type ExtraParams, storeExtraParams } from './extra-params';
import type { KeySigner } from './key';
import { decodeBase64, toBase64, toBase64Url } from './util/base64';
import { elementChildren, parseXml } from './util/xml';

type TriphaseFormat =
  | 'CAdES'
  | 'CAdES-ASiC-S'
  | 'XAdES'
  | 'XAdES-ASiC-S'
  | 'FacturaE'
  | 'PAdES'
  | 'NONE';

export type Cop = 'sign' | 'cosign' | 'countersign';

export interface TriphaseOptions {
  serverUrl: string;
  cop: Cop;
  format: TriphaseFormat;
  algorithm: ResolvedAlgorithm;
  /** The bytes the page passed (a document or a document id, opaque to the client). */
  data: Buffer | null;
  extraParams: ExtraParams;
  signer: KeySigner;
  /** Leaf first. */
  chain: Buffer[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

const DEFAULT_TIMEOUT = 120_000;

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

/** Per-operation cookie jar (session affinity on load-balanced servers). */
class CookieJar {
  private cookies = new Map<string, string>();
  store(res: Response): void {
    const list =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : (res.headers.get('set-cookie') ?? '').split(/,(?=[^;]+=)/).filter(Boolean);
    for (const c of list) {
      const pair = c.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/** Body as AutoFirma writes it: `k=v&k=v` with the (Base64URL) values not URL-encoded. */
function formBody(fields: [string, string | undefined][]): string {
  return fields
    .filter((f): f is [string, string] => f[1] !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

async function postForm(
  url: string,
  body: string,
  opts: {
    fetch?: typeof fetch;
    jar?: CookieJar;
    timeoutMs?: number;
    phase: 'pre' | 'post' | 'batch';
  },
): Promise<string> {
  const doFetch = opts.fetch ?? fetch;
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: '*/*',
  };
  try {
    headers.Origin = new URL(url).origin;
  } catch {
    throw AfirmaError.invalidParameter(`URL de servidor no valida: ${url}`);
  }
  const cookie = opts.jar?.header();
  if (cookie) headers.Cookie = cookie;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT),
    });
  } catch (e) {
    throw AfirmaError.network(opts.phase, e instanceof Error ? e.message : String(e));
  }
  opts.jar?.store(res);
  const text = await res.text();
  if (!res.ok) throw AfirmaError.http(opts.phase, res.status);
  return text;
}

function checkServerReply(text: string, phase: 'pre' | 'post'): string {
  const t = text.trim();
  if (t.length <= 8 && !t.startsWith('OK')) {
    throw AfirmaError.triphase(phase, 'respuesta vacia o demasiado corta');
  }
  if (t.toUpperCase().startsWith('ERR-')) throw triphaseServerError(t, phase);
  return t;
}

/** `ERR-NN: message` → AF3004xx codes like AOTriphaseException. */
function triphaseServerError(text: string, phase: 'pre' | 'post'): AfirmaError {
  const m = /^ERR-(\d+)\s*:\s*(.*)$/is.exec(text.trim());
  const n = m ? Number(m[1]) : Number.NaN;
  const detail = m ? m[2] : text;
  const base = phase === 'pre' ? 300408 : 300429;
  const code = n >= 1 && n <= 20 ? `AF${base + n}` : phase === 'pre' ? 'AF300451' : 'AF300452';
  return new AfirmaError(
    'java.lang.Exception',
    `ERR-${m ? m[1] : '?'} en la ${phase === 'pre' ? 'prefirma' : 'postfirma'}: ${detail}`,
    code,
  );
}

// ---------------------------------------------------------------------------------------------
// TriphaseData
// ---------------------------------------------------------------------------------------------

interface TriphaseSign {
  id: string;
  signid?: string;
  params: Map<string, string>;
}

export interface TriphaseData {
  format?: string;
  signs: TriphaseSign[];
}

export function parseTriphaseData(xml: string): TriphaseData {
  let doc: Document;
  try {
    doc = parseXml(xml);
  } catch {
    throw AfirmaError.triphase('pre', 'datos trifasicos no validos');
  }
  return triphaseDataOf(doc);
}

function triphaseDataOf(doc: Document): TriphaseData {
  // The root name is ignored; its first child element must be <firmas>.
  const firmas = elementChildren(doc.documentElement)[0];
  if (firmas?.nodeName.toLowerCase() !== 'firmas') {
    throw AfirmaError.triphase('pre', 'datos trifasicos sin firmas');
  }
  const data: TriphaseData = { format: firmas.getAttribute('format') || undefined, signs: [] };
  for (const firma of elementChildren(firmas)) {
    const params = new Map<string, string>();
    for (const el of elementChildren(firma)) {
      const key = el.getAttribute('n');
      if (key) params.set(key, (el.textContent ?? '').trim());
    }
    const sign: TriphaseSign = { id: firma.getAttribute('Id') || randomUUID(), params };
    const signid = firma.getAttribute('signid');
    if (signid) sign.signid = signid;
    data.signs.push(sign);
  }
  return data;
}

/** Serialized exactly like AutoFirma's TriphaseData.toString() (no declaration, no escaping). */
function serializeTriphaseData(data: TriphaseData): string {
  let out = '<xml>\n';
  out += data.format ? ` <firmas format="${data.format}">\n` : ' <firmas>\n';
  for (const s of data.signs) {
    out += `  <firma Id="${s.id}"${s.signid ? ` signid="${s.signid}"` : ''}>\n`;
    for (const [k, v] of s.params) out += `   <param n="${k}">${v}</param>\n`;
    out += '  </firma>\n';
  }
  out += ' </firmas>\n</xml>';
  return out;
}

/** TriphaseDataSigner: PK1 = Signature(algo).sign(PRE); PRE dropped unless NEED_PRE=true. */
async function signTriphaseData(
  data: { signs: { params: Map<string, string> }[] },
  algorithm: ResolvedAlgorithm,
  signer: KeySigner,
): Promise<void> {
  if (data.signs.length === 0) throw AfirmaError.triphase('pre', 'no hay datos que firmar');
  for (const s of data.signs) {
    const pre = s.params.get('PRE');
    if (!pre) throw AfirmaError.triphase('pre', 'falta la prefirma (PRE)');
    const bytes = decodeBase64(pre);
    if (!bytes) throw AfirmaError.triphase('pre', 'prefirma no valida');
    s.params.set('PK1', toBase64(await signer.sign(bytes, algorithm)));
    if (s.params.get('NEED_PRE')?.toLowerCase() !== 'true') s.params.delete('PRE');
  }
}

// ---------------------------------------------------------------------------------------------
// Single signature
// ---------------------------------------------------------------------------------------------

function certParam(chain: Buffer[], onlyLeaf: boolean, separator: string): string {
  return (onlyLeaf ? chain.slice(0, 1) : chain).map(toBase64Url).join(separator);
}

function paramsParam(params: ExtraParams, now: Date): string | undefined {
  if (Object.keys(params).length === 0) return undefined;
  return toBase64Url(Buffer.from(storeExtraParams(params, now), 'utf8'));
}

/** Runs a triphase signature and returns what the server sends back as NEWID (decoded). */
export async function triphaseSign(opts: TriphaseOptions): Promise<Buffer> {
  const now = opts.now?.() ?? new Date();
  const jar = new CookieJar();
  const http = { fetch: opts.fetch, jar, timeoutMs: opts.timeoutMs };
  const algo = opts.algorithm.name;
  const onlyLeaf = opts.extraParams.includeOnlySignningCertificate === 'true';
  const doc = opts.data ? toBase64Url(opts.data) : undefined;

  let format: string = opts.format;
  let cop: Cop = opts.cop;
  let cert = certParam(opts.chain, onlyLeaf, ',');
  let params: string | undefined;
  const p: ExtraParams = { ...opts.extraParams };
  switch (opts.format) {
    case 'CAdES':
    case 'CAdES-ASiC-S':
      delete p.serverUrl;
      delete p.documentId;
      if (!doc) throw AfirmaError.noData();
      params = paramsParam(p, now);
      break;
    case 'XAdES':
    case 'XAdES-ASiC-S':
    case 'FacturaE':
      delete p.serverUrl;
      delete p.validatePkcs1;
      params = paramsParam(p, now);
      break;
    case 'PAdES':
      // AutoFirma's PDF triphase client sends "pades", always cop=sign, params untouched.
      format = 'pades';
      if (cop === 'countersign') throw AfirmaError.unsupportedOperation('contrafirma PAdES');
      cop = 'sign';
      if (!doc) throw AfirmaError.noData();
      params = paramsParam(p, now);
      break;
    case 'NONE':
      if (cop !== 'sign') throw AfirmaError.unsupportedOperation(`${cop} con formato NONE`);
      if (!doc) throw AfirmaError.noData();
      cert = certParam(opts.chain, true, ',');
      params = undefined;
      break;
  }
  if (cop === 'countersign' && opts.format !== 'PAdES') {
    // The CAdES/XAdES triphase clients pass the countersign target in the params.
    params = paramsParam({ ...p, target: p.target === 'tree' ? 'tree' : 'leafs' }, now);
  }

  const common: [string, string | undefined][] = [
    ['cop', cop],
    ['format', format],
    ['algo', algo],
    ['cert', cert],
  ];
  const preBody = formBody([['op', 'pre'], ...common, ['doc', doc], ['params', params]]);
  const preText = await postForm(opts.serverUrl, preBody, { ...http, phase: 'pre' });

  // AutoFirma's PKCS#1 triphase client skips the ERR-/length checks.
  const preReply = opts.format === 'NONE' ? preText.trim() : checkServerReply(preText, 'pre');
  const xml = decodeBase64(preReply);
  if (!xml) throw AfirmaError.triphase('pre', 'respuesta no valida');
  const triphase = parseTriphaseData(xml.toString('utf8'));
  await signTriphaseData(triphase, opts.algorithm, opts.signer);
  const session = toBase64Url(Buffer.from(serializeTriphaseData(triphase), 'utf8'));

  const postFields: [string, string | undefined][] =
    opts.format === 'PAdES'
      ? [['op', 'post'], ...common, ['doc', doc], ['session', session], ['params', params]]
      : opts.format === 'XAdES' || opts.format === 'XAdES-ASiC-S' || opts.format === 'FacturaE'
        ? [['op', 'post'], ...common, ['session', session], ['doc', doc], ['params', params]]
        : [['op', 'post'], ...common, ['params', params], ['session', session], ['doc', doc]];
  const postText = await postForm(opts.serverUrl, formBody(postFields), { ...http, phase: 'post' });
  const t = opts.format === 'NONE' ? postText.trim() : checkServerReply(postText, 'post');
  if (!t.startsWith('OK')) throw AfirmaError.triphase('post', 'respuesta inesperada del servidor');
  const newId = t.replace(/^OK\s*(NEWID=)?/, '').trim();
  const result = decodeBase64(newId);
  if (!result || result.length === 0) throw AfirmaError.triphase('post', 'resultado vacio');
  return result;
}

// ---------------------------------------------------------------------------------------------
// JSON batch (signBatchProcess)
// ---------------------------------------------------------------------------------------------

interface BatchSingleSign {
  id: string;
  datareference: string;
  format?: string;
  suboperation?: string;
  extraparams?: string;
  [key: string]: unknown;
}

export interface BatchRequest {
  algorithm: string;
  format: string;
  suboperation: string;
  extraparams?: string;
  stoponerror?: boolean;
  singlesigns: BatchSingleSign[];
  [key: string]: unknown;
}

export interface BatchResultEntry {
  id: string;
  result: string;
  description?: string;
  signature?: string;
}

export interface BatchResult {
  signs: BatchResultEntry[];
  [key: string]: unknown;
}

interface PresignResponse {
  td?: {
    format?: string;
    signs?: { signinfo?: { id: string; signid?: string; params: Record<string, string> }[] }[];
  };
  results?: BatchResultEntry[];
}

function parseJson<T>(text: string, phase: 'pre' | 'post'): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw AfirmaError.triphase(phase, 'respuesta del servidor de lotes no valida');
  }
}

export interface BatchOptions {
  batch: BatchRequest;
  preUrl: string;
  postUrl: string;
  algorithm: ResolvedAlgorithm;
  signer: KeySigner;
  chain: Buffer[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** JSON batch against the site's batch presigner/postsigner (AutoFirma BatchSigner). */
export async function batchSign(opts: BatchOptions): Promise<BatchResult> {
  const jar = new CookieJar();
  const http = { fetch: opts.fetch, jar, timeoutMs: opts.timeoutMs, phase: 'batch' as const };
  const certs = opts.chain.map(toBase64Url).join(';');
  let batch: BatchRequest = opts.batch;
  const jsonParam = () => toBase64Url(Buffer.from(JSON.stringify(batch), 'utf8'));

  const preText = await postForm(
    opts.preUrl,
    formBody([
      ['json', jsonParam()],
      ['certs', certs],
    ]),
    http,
  );
  const pre = parseJson<PresignResponse>(preText, 'pre');
  if (!pre.td && !pre.results) return { signs: [] };
  if (!pre.td) return { signs: pre.results ?? [] };

  const failed = new Map((pre.results ?? []).map((r) => [r.id, r]));
  if (failed.size) {
    batch = {
      ...batch,
      singlesigns: batch.singlesigns.map((s) => {
        const r = failed.get(s.id);
        if (!r) return s;
        const { datareference: _d, format: _f, suboperation: _s, extraparams: _e, ...rest } = s;
        return {
          ...rest,
          result: r.result,
          description: r.description,
        } as unknown as BatchSingleSign;
      }),
    };
  }

  const signinfo = (pre.td.signs ?? []).flatMap((s) => s.signinfo ?? []);
  const toSign = signinfo.map((si) => ({
    ...si,
    params: new Map(Object.entries(si.params ?? {})),
  }));
  await signTriphaseData({ signs: toSign }, opts.algorithm, opts.signer);
  const tridata = {
    format: pre.td.format,
    signinfo: toSign.map((s) => ({
      id: s.id,
      ...(s.signid ? { signid: s.signid } : {}),
      params: Object.fromEntries(s.params),
    })),
  };
  const postText = await postForm(
    opts.postUrl,
    formBody([
      ['json', jsonParam()],
      ['certs', certs],
      ['tridata', toBase64Url(Buffer.from(JSON.stringify(tridata), 'utf8'))],
    ]),
    http,
  );
  return parseJson<BatchResult>(postText, 'post');
}

// ---------------------------------------------------------------------------------------------
// XML batch (signBatch)
// ---------------------------------------------------------------------------------------------

/** One `<singlesign>` of a `<signbatch>` document, as the consent summary needs it. */
interface XmlBatchEntry {
  id: string;
  format?: string;
  suboperation?: string;
  /** Bytes of the data when the datasource is Base64 (not a URL or an id the server resolves). */
  dataSize?: number;
}

export interface XmlBatch {
  algorithm: string;
  stopOnError: boolean;
  signs: XmlBatchEntry[];
}

function childText(el: Element, name: string): string | undefined {
  const child = elementChildren(el).find((c) => c.nodeName.toLowerCase() === name);
  const text = child?.textContent?.trim();
  return text || undefined;
}

/**
 * Reads AutoFirma's legacy batch document (`es.gob.afirma.signers.batch.SignBatch`):
 *
 *   <signbatch stoponerror="true" algorithm="SHA256withRSA" [concurrenttimeout=".."]>
 *     <singlesign Id="..">
 *       <datasource>Base64 data | URL</datasource>
 *       <format>CAdES</format> <suboperation>sign</suboperation>
 *       <extraparams>Base64(Properties)</extraparams>
 *       <signsaver><class>..</class><config>..</config></signsaver>
 *     </singlesign>
 *   </signbatch>
 *
 * The servers do the format work; the client only needs the algorithm and what to show.
 */
export function parseXmlBatch(xml: string): XmlBatch {
  let doc: Document;
  try {
    doc = parseXml(xml);
  } catch {
    throw AfirmaError.invalidParameter('Lote de firma XML no valido');
  }
  const root = doc.documentElement;
  if (root.nodeName.toLowerCase() !== 'signbatch') {
    throw AfirmaError.invalidParameter('Lote de firma XML no valido: falta <signbatch>');
  }
  const algorithm = root.getAttribute('algorithm')?.trim();
  if (!algorithm) throw AfirmaError.invalidParameter('Lote de firma XML sin algoritmo');
  const signs: XmlBatchEntry[] = [];
  for (const el of elementChildren(root)) {
    if (el.nodeName.toLowerCase() !== 'singlesign') continue;
    const id = el.getAttribute('Id') || el.getAttribute('id');
    if (!id) throw AfirmaError.invalidParameter('Lote de firma XML con una firma sin Id');
    const datasource = childText(el, 'datasource');
    const data = datasource && !/^https?:/i.test(datasource) ? decodeBase64(datasource) : null;
    signs.push({
      id,
      format: childText(el, 'format'),
      suboperation: childText(el, 'suboperation'),
      ...(data ? { dataSize: data.length } : {}),
    });
  }
  if (signs.length === 0) throw AfirmaError.invalidParameter('Lote de firma XML vacio');
  return {
    algorithm,
    stopOnError: root.getAttribute('stoponerror')?.trim().toLowerCase() !== 'false',
    signs,
  };
}

export interface XmlBatchOptions {
  /** The `<signbatch>` document as the page gave it (decoded). */
  batch: Buffer;
  preUrl: string;
  postUrl: string;
  algorithm: ResolvedAlgorithm;
  signer: KeySigner;
  chain: Buffer[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The server's reply as XML text: AutoFirma's servers send it plain, some proxies Base64. */
function batchReplyXml(text: string, phase: 'pre' | 'post'): Document {
  const t = text.trim();
  if (t.toUpperCase().startsWith('ERR-')) throw triphaseServerError(t, phase);
  let xml = t;
  if (!t.startsWith('<')) {
    const decoded = decodeBase64(t)?.toString('utf8').trim();
    if (!decoded?.startsWith('<')) {
      throw AfirmaError.triphase(phase, 'respuesta del servidor de lotes no valida');
    }
    xml = decoded;
  }
  try {
    return parseXml(xml);
  } catch {
    throw AfirmaError.triphase(phase, 'respuesta del servidor de lotes no valida');
  }
}

export interface XmlBatchResult {
  /** The result log, re-serialized: `<signs><signresult id=".." result=".." description=".."/>…</signs>`. */
  log: string;
  results: BatchResultEntry[];
}

function resultLog(doc: Document, phase: 'pre' | 'post'): XmlBatchResult {
  const root = doc.documentElement;
  if (root.nodeName.toLowerCase() !== 'signs') {
    throw AfirmaError.triphase(phase, 'resultado del lote no valido');
  }
  const attr = (v: string) =>
    v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const results: BatchResultEntry[] = [];
  let log = '<signs>';
  for (const el of elementChildren(root)) {
    if (el.nodeName.toLowerCase() !== 'signresult') continue;
    const entry: BatchResultEntry = {
      id: el.getAttribute('id') ?? '',
      result: el.getAttribute('result') ?? '',
    };
    const description = el.getAttribute('description');
    if (description) entry.description = description;
    results.push(entry);
    log += `<signresult id="${attr(entry.id)}" result="${attr(entry.result)}" description="${attr(description ?? '')}"/>`;
  }
  return { log: `${log}</signs>`, results };
}

/**
 * Legacy XML batch against the site's batch presigner/postsigner, like AutoFirma's
 * `BatchSigner.sign(batchB64, presignerUrl, postsignerUrl, certificates, pk)`:
 *
 *   POST presignerUrl   xml=<b64u(batch)>&certs=<b64u cert>;<b64u cert>…
 *     <- TriphaseData XML (<xml><firmas><firma Id=".."><param n="PRE">..</param>…)
 *   (sign each PRE -> PK1)
 *   POST postsignerUrl  xml=<b64u(batch)>&certs=…&tridata=<b64u(TriphaseData XML with PK1)>
 *     <- <signs><signresult id=".." result="DONE_AND_SAVED" description=""/>…</signs>
 *
 * Returns the result log. A presigner that answers with a result log (every presignature
 * failed) ends the batch there.
 */
export async function xmlBatchSign(opts: XmlBatchOptions): Promise<XmlBatchResult> {
  const jar = new CookieJar();
  const http = { fetch: opts.fetch, jar, timeoutMs: opts.timeoutMs, phase: 'batch' as const };
  const xml = toBase64Url(opts.batch);
  const certs = opts.chain.map(toBase64Url).join(';');

  const preDoc = batchReplyXml(
    await postForm(
      opts.preUrl,
      formBody([
        ['xml', xml],
        ['certs', certs],
      ]),
      http,
    ),
    'pre',
  );
  if (preDoc.documentElement.nodeName.toLowerCase() === 'signs') return resultLog(preDoc, 'pre');
  const triphase = triphaseDataOf(preDoc);
  if (triphase.signs.length) await signTriphaseData(triphase, opts.algorithm, opts.signer);

  const postDoc = batchReplyXml(
    await postForm(
      opts.postUrl,
      formBody([
        ['xml', xml],
        ['certs', certs],
        ['tridata', toBase64Url(Buffer.from(serializeTriphaseData(triphase), 'utf8'))],
      ]),
      http,
    ),
    'post',
  );
  return resultLog(postDoc, 'post');
}
