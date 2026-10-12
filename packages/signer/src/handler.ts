/**
 * Node side of the AutoFirma replacement: answers the `AfirmaCall`s the in-page shim forwards.
 *
 * Every operation that uses the certificate (signatures, batches, selectCertificate) first asks
 * the user through `ctx.approveSignature(summary)`; a null answer is reported to the page as
 * AutoFirma's cancellation error. Nothing is signed without that approval.
 */
import crypto from 'node:crypto';
import type {
  AfirmaCall,
  AfirmaDocument,
  AfirmaHandler,
  AfirmaHandlerContext,
  AfirmaReply,
  AfirmaSignatureSummary,
  SigningKey,
} from '@sa/shared';
import { z } from 'zod';
import { checkAlgorithm, type ResolvedAlgorithm, resolveAlgorithm } from './algorithms';
import { type CountersignTarget, cosignCades, countersignCades, createCades, OID } from './cades';
import { AfirmaError, CANCELLED_TYPE, toAfirmaError } from './errors';
import { type ExtraParams, isTrue, parseExtraParams } from './extra-params';
import {
  detectFormatForSign,
  detectFormatForSignature,
  type FormatFamily,
  type FormatSpec,
  LOCAL_FAMILIES,
  parseFormat,
} from './formats';
import { externalIdentity, p12Identity, type SignerIdentity } from './key';
import { sniffMime } from './mime';
import { openP12, P12Error } from './p12';
import { createPades } from './pades';
import { expandPolicy, type PolicyFormat, readPolicy } from './policy';
import {
  type BatchRequest,
  type BatchResult,
  type BatchResultEntry,
  batchSign,
  type Cop,
  parseXmlBatch,
  triphaseSign,
  xmlBatchSign,
} from './triphase';
import { decodeBase64, toBase64 } from './util/base64';
import { createXades } from './xades';

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

export interface PickedFile {
  name: string;
  data: Uint8Array;
}

export interface FilePickRequest {
  origin: string;
  /** Dialog title proposed by the site, if any. */
  title?: string;
  /** File extensions the site accepts (e.g. ["pdf", "xml"]). */
  extensions?: string[];
  description?: string;
  multiple: boolean;
  /** Why the file is needed: to sign it, or because the site asked to load files. */
  purpose: 'sign' | 'load';
}

export interface FileSaveRequest {
  origin: string;
  fileName?: string;
  title?: string;
  description?: string;
  data: Uint8Array;
}

export interface AfirmaHandlerOptions {
  /**
   * Lets the user (or the agent, from the vault) choose files when the site asks AutoFirma to
   * open a file chooser (`sign(null, ...)`, getFileNameContentBase64...). Resolve null if the
   * user cancels. Without it, those calls fail with an AutoFirma-style error.
   */
  pickFiles?(req: FilePickRequest): Promise<PickedFile[] | null>;
  /** Stores data the site asks AutoFirma to save (saveDataToFile, signAndSaveToFile). */
  saveFile?(req: FileSaveRequest): Promise<boolean>;
  /** Clock for signing times (tests). */
  now?(): Date;
  /** Largest document accepted (default 50 MB). */
  maxDataBytes?: number;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Input validation (the binding is callable by any page script: treat everything as hostile)
// ---------------------------------------------------------------------------------------------

const CallSchema = z.object({
  method: z.string().min(1).max(64),
  args: z.array(z.unknown()).max(16),
  origin: z.string().max(4096),
  url: z.string().max(65536),
});

const BatchSchema = z
  .object({
    algorithm: z.string().max(64),
    format: z.string().max(64),
    suboperation: z.string().max(32).nullish(),
    extraparams: z.string().max(65536).nullish(),
    stoponerror: z.unknown().optional(),
    singlesigns: z
      .array(
        z
          .object({
            id: z.union([z.string(), z.number()]).transform(String),
            datareference: z.string(),
            format: z.string().max(64).nullish(),
            suboperation: z.string().max(32).nullish(),
            extraparams: z.string().max(65536).nullish(),
          })
          .passthrough(),
      )
      .min(1)
      .max(500),
  })
  .passthrough();

function argString(args: unknown[], i: number, what: string): string | null {
  const v = args[i];
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw AfirmaError.invalidParameter(`Parametro no valido: ${what}`);
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function sha256(data: Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function whatIsIt(data: Uint8Array): string {
  const mime = sniffMime(data).mimeType;
  if (mime === 'application/pdf') return 'un documento PDF';
  if (mime === 'text/xml') return 'un documento XML (normalmente, el formulario de la solicitud)';
  if (mime === 'text/plain') return 'un texto';
  if (mime.startsWith('image/')) return 'una imagen';
  return 'unos datos';
}

function textPreview(data: Uint8Array): string | null {
  const mime = sniffMime(data).mimeType;
  if (mime !== 'text/plain' || data.length > 2000) return null;
  const text = Buffer.from(data).toString('utf8').trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function openCertificate(key: SigningKey): SignerIdentity {
  if (key.kind === 'external') return externalIdentity(key);
  try {
    return p12Identity(openP12(key.p12, key.passphrase));
  } catch (e) {
    if (e instanceof P12Error) {
      const reason =
        e.code === 'BAD_PASSWORD'
          ? 'la contraseña del certificado no es correcta'
          : e.code === 'UNSUPPORTED'
            ? 'el tipo de certificado no está soportado'
            : 'el fichero del certificado no es válido';
      throw new AfirmaError(
        'java.lang.Exception',
        `No se pudo abrir el certificado: ${reason}`,
        'AF201101',
      );
    }
    throw e;
  }
}

function checkValidity(identity: SignerIdentity, now: Date): void {
  const to = new Date(identity.info.validTo);
  const from = new Date(identity.info.validFrom);
  if (now > to || now < from) {
    throw new AfirmaError(
      'java.lang.Exception',
      'El certificado seleccionado está caducado o todavía no es válido',
      'AF501001',
    );
  }
}

interface ResolvedData {
  data: Buffer | null;
  fileName?: string;
}

// ---------------------------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------------------------

export function createAfirmaHandler(options: AfirmaHandlerOptions = {}): AfirmaHandler {
  const now = () => options.now?.() ?? new Date();
  const maxBytes = options.maxDataBytes ?? DEFAULT_MAX_BYTES;

  /** Asks the user; the caller must `identity.release()` when the operation ends. */
  async function approve(
    ctx: AfirmaHandlerContext,
    summary: AfirmaSignatureSummary,
  ): Promise<{ identity: SignerIdentity }> {
    const key = await ctx.approveSignature(summary);
    if (!key) throw AfirmaError.cancelled();
    let identity: SignerIdentity;
    try {
      identity = openCertificate(key);
      checkValidity(identity, now());
    } catch (e) {
      if (key.kind === 'external') key.release(false);
      throw e;
    }
    return { identity };
  }

  /** Runs `work` with the identity, then releases it (signed or not). */
  async function using<T>(identity: SignerIdentity, work: () => Promise<T>): Promise<T> {
    try {
      const result = await work();
      identity.release(true);
      return result;
    } catch (e) {
      identity.release(false);
      throw e;
    }
  }

  async function resolveSignData(
    call: AfirmaCall,
    ctx: AfirmaHandlerContext,
    dataB64: string | null,
    params: ExtraParams,
  ): Promise<ResolvedData> {
    if (dataB64 == null || dataB64 === '') {
      if (!options.pickFiles) throw AfirmaError.noData();
      const exts = params.filenameExts?.split(',').map((e) => e.trim().replace(/^\./, ''));
      const picked = await options.pickFiles({
        origin: call.origin,
        title: params.filenameDescription,
        extensions: exts?.filter(Boolean),
        description: params.filenameDescription,
        multiple: false,
        purpose: 'sign',
      });
      if (!picked?.[0]) throw AfirmaError.cancelled();
      const data = Buffer.from(picked[0].data);
      if (data.length > maxBytes) throw AfirmaError.invalidData('El fichero es demasiado grande');
      return { data, fileName: picked[0].name };
    }
    if (/^https?:\/\//i.test(dataB64)) {
      // AutoFirma downloads URLs given as data. Only from the page's own origin here.
      let url: URL;
      try {
        url = new URL(dataB64);
      } catch {
        throw AfirmaError.invalidData();
      }
      if (url.origin !== call.origin) {
        throw AfirmaError.invalidParameter('Solo se pueden descargar datos del propio sitio');
      }
      const res = await (ctx.fetch ?? fetch)(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw AfirmaError.network('pre', `HTTP ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > maxBytes) throw AfirmaError.invalidData('Los datos son demasiado grandes');
      return { data };
    }
    const data = decodeBase64(dataB64);
    if (!data) throw AfirmaError.invalidData();
    if (data.length > maxBytes) throw AfirmaError.invalidData('Los datos son demasiado grandes');
    return { data };
  }

  /** sign / coSign / counterSign / signAndSaveToFile. */
  async function signOperation(
    call: AfirmaCall,
    ctx: AfirmaHandlerContext,
    cop: Cop,
    input: {
      dataB64: string | null;
      signB64?: string | null;
      algorithm: string | null;
      format: string | null;
      params: string | null;
      outputFileName?: string | null;
    },
  ): Promise<{ args: unknown[]; format: string }> {
    const params = parseExtraParams(input.params);
    const spec: FormatSpec = parseFormat(input.format);
    const requestedFormat = spec.requested;

    // What gets signed
    let data: Buffer | null = null;
    let signature: Buffer | null = null;
    let fileName: string | undefined;
    if (cop === 'sign') {
      ({ data, fileName } = await resolveSignData(call, ctx, input.dataB64, params));
    } else {
      signature = input.signB64 ? decodeBase64(input.signB64) : null;
      if (!signature) throw AfirmaError.notSignature();
      if (signature.length > maxBytes)
        throw AfirmaError.invalidData('Los datos son demasiado grandes');
      // coSign's data argument is ignored by AutoFirma; kept only for detached CAdES cosign.
      data = input.dataB64 ? decodeBase64(input.dataB64) : null;
    }

    const family: FormatFamily =
      spec.family ??
      (cop === 'sign'
        ? detectFormatForSign(data as Buffer)
        : detectFormatForSignature(signature as Buffer));
    let triphase = spec.triphase;
    // Formats we cannot build locally: use the site's triphase server when it gave us one.
    if (!triphase && params.serverUrl) triphase = true;
    if (!triphase && !LOCAL_FAMILIES.has(family))
      throw AfirmaError.unsupportedFormat(requestedFormat);
    if (triphase && !params.serverUrl) {
      throw AfirmaError.invalidParameter(
        'No se ha indicado la URL del servidor de firma trifasica (serverUrl)',
      );
    }

    // Policy (local formats; the triphase server expands expPolicy itself)
    let effective: ExtraParams = params;
    if (!triphase && (family === 'CAdES' || family === 'XAdES' || family === 'PAdES')) {
      const subject = cop === 'sign' ? data : signature;
      effective = expandPolicy(params, family as PolicyFormat, subject ? subject.length : null);
    }
    if (!triphase && family === 'NONE' && cop !== 'sign') {
      throw AfirmaError.unsupportedOperation(`${cop} con formato NONE`);
    }

    // Summary for the human
    const subjectBytes = (cop === 'sign' ? data : signature) as Buffer;
    const formatLabel = triphase ? `${family} (trifásica)` : xadesVariantLabel(family, effective);
    const lines: string[] = [];
    if (cop === 'sign') {
      lines.push(
        `Firmar ${fileName ? `el fichero «${fileName}»` : whatIsIt(subjectBytes)} (${humanSize(subjectBytes.length)}) en formato ${formatLabel}.`,
      );
      const preview = textPreview(subjectBytes);
      if (preview) lines.push(`Contenido: «${preview}»`);
    } else if (cop === 'cosign') {
      lines.push(`Añadir tu firma a un documento ya firmado (cofirma ${formatLabel}).`);
    } else {
      lines.push(`Refrendar con tu firma las firmas existentes (contrafirma ${formatLabel}).`);
    }
    if (effective.policyIdentifier || params.expPolicy) {
      lines.push('Con la política de firma de la Administración General del Estado.');
    }
    if (triphase) {
      lines.push(
        'El servidor del sitio prepara la firma y tu certificado firma un resumen. No se puede mostrar el contenido exacto.',
      );
    }
    if (params.precalculatedHashAlgorithm) {
      lines.push('Solo se firma la huella del documento: no se puede mostrar su contenido.');
    }
    lines.push(`Lo pide ${call.origin}.`);
    const document: AfirmaDocument = {
      ...(fileName ? { name: fileName } : {}),
      mimeType: sniffMime(subjectBytes).mimeType,
      data: subjectBytes,
    };
    // The phone can check the signature covers the document: CAdES and PAdES built here.
    const verifiable =
      !triphase &&
      !params.precalculatedHashAlgorithm &&
      ((family === 'CAdES' && cop === 'sign') || (family === 'PAdES' && cop !== 'countersign'));
    // Reject an unsupported algorithm before the user is asked to approve.
    checkAlgorithm(input.algorithm);
    const { identity } = await approve(ctx, {
      method: call.method,
      format: requestedFormat,
      algorithm: input.algorithm ?? '',
      origin: call.origin,
      description: lines.join('\n'),
      dataSize: subjectBytes.length,
      dataSha256: sha256(subjectBytes),
      documents: [document],
      verifiable,
    });

    const signed = await using(identity, () => {
      const algorithm = resolveAlgorithm(input.algorithm, identity.keyType);
      return triphase
        ? triphaseSign({
            serverUrl: params.serverUrl as string,
            cop,
            format: family,
            algorithm,
            data: cop === 'sign' ? data : signature,
            extraParams: params,
            signer: identity.signer,
            chain: identity.chainDer,
            fetch: ctx.fetch,
            now,
          })
        : signLocally(family, cop, {
            data,
            signature,
            algorithm,
            identity,
            params: effective,
            now: now(),
            document: verifiable ? 0 : undefined,
          });
    });

    if (input.outputFileName != null && options.saveFile) {
      await options.saveFile({
        origin: call.origin,
        fileName: input.outputFileName || undefined,
        data: signed,
      });
    }
    const extraData = fileName ? `{"filename": ${JSON.stringify(fileName)}}` : null;
    return {
      args: [toBase64(signed), toBase64(identity.certificateDer), extraData],
      format: requestedFormat,
    };
  }

  async function signLocally(
    family: FormatFamily,
    cop: Cop,
    o: {
      data: Buffer | null;
      signature: Buffer | null;
      algorithm: ResolvedAlgorithm;
      identity: SignerIdentity;
      params: ExtraParams;
      now: Date;
      /** Index of the data among the approved documents, when the signer may check it. */
      document?: number;
    },
  ): Promise<Buffer> {
    const { identity, params, algorithm } = o;
    const chain = identity.chainDer;
    const signer = identity.signer;
    const policy = readPolicy(params);
    if (family === 'NONE') {
      return signer.sign(o.data as Buffer, algorithm);
    }
    if (family === 'CAdES') {
      const attributes = cadesAttributes(params, o.data, o.now, policy);
      const common = {
        algorithm,
        signer,
        chain,
        includeOnlySigningCertificate: isTrue(params.includeOnlySignningCertificate),
        attributes,
      };
      if (cop === 'cosign')
        return cosignCades({ ...common, signature: o.signature as Buffer, data: o.data });
      if (cop === 'countersign') {
        const target: CountersignTarget = params.target === 'tree' ? 'tree' : 'leafs';
        const { contentHints: _c, ...rest } = attributes;
        return countersignCades({
          ...common,
          attributes: rest,
          signature: o.signature as Buffer,
          target,
        });
      }
      const precalc = params.precalculatedHashAlgorithm;
      const implicit = !precalc && (params.mode ?? 'explicit').toLowerCase() === 'implicit';
      return createCades({
        ...common,
        data: precalc ? null : o.data,
        digest: precalc ? (o.data as Buffer) : undefined,
        implicit,
        ...(o.document !== undefined && !precalc
          ? { binding: { kind: 'cms' as const, document: o.document } }
          : {}),
      });
    }
    if (family === 'XAdES') {
      if (cop !== 'sign')
        throw AfirmaError.unsupportedOperation(`${cop} XAdES sin servidor trifasico`);
      return createXades({
        data: o.data as Buffer,
        algorithm,
        signer,
        chain,
        params,
        policy,
        signingTime: o.now,
      });
    }
    if (family === 'PAdES') {
      if (cop === 'countersign') throw AfirmaError.unsupportedOperation('contrafirma PAdES');
      // A PAdES cosign is a new signature on the (already signed) PDF.
      const pdf = (cop === 'sign' ? o.data : o.signature) as Buffer;
      return createPades({
        pdf,
        algorithm,
        signer,
        chain,
        params,
        policy,
        signingTime: o.now,
        document: o.document,
      });
    }
    throw AfirmaError.unsupportedFormat(family);
  }

  function cadesAttributes(
    params: ExtraParams,
    data: Buffer | null,
    signingTime: Date,
    policy: ReturnType<typeof readPolicy>,
  ) {
    const hintsWanted = params.includeContentHintAttribute?.toLowerCase() !== 'false';
    const sniffed = data && !params.precalculatedHashAlgorithm ? sniffMime(data) : null;
    const contentHints = hintsWanted
      ? {
          oid: params.contentTypeOid || sniffed?.oid || OID.data,
          description: params.contentDescription || sniffed?.description || 'binary',
        }
      : null;
    const mimeWanted = isTrue(params.includeMimeTypeAttribute);
    return {
      policy,
      signingTime:
        params.includeSigningTimeAttribute?.toLowerCase() === 'false' ? null : signingTime,
      contentHints,
      mimeType: mimeWanted
        ? params.mimeType || sniffed?.mimeType || 'application/octet-stream'
        : null,
      claimedRoles: params.signerClaimedRoles?.split('|').filter(Boolean),
      signingCertificateV2: params.signingCertificateV2
        ? isTrue(params.signingCertificateV2)
        : undefined,
      includeCertificatePolicies: !isTrue(params.doNotIncludePolicyOnSigningCertificate),
    };
  }

  async function selectCertificate(
    call: AfirmaCall,
    ctx: AfirmaHandlerContext,
  ): Promise<unknown[]> {
    const { identity } = await approve(ctx, {
      method: 'selectCertificate',
      format: '',
      algorithm: '',
      origin: call.origin,
      description: `${call.origin} quiere saber con qué certificado vas a firmar. No se firma nada todavía.`,
      documents: [],
      verifiable: false,
    });
    identity.release(true);
    return [toBase64(identity.certificateDer)];
  }

  async function batchOperation(call: AfirmaCall, ctx: AfirmaHandlerContext): Promise<unknown[]> {
    const parsed = BatchSchema.safeParse(call.args[4]);
    if (!parsed.success) throw AfirmaError.invalidParameter('Lote de firma no valido');
    const batch = parsed.data as unknown as BatchRequest;
    const stopOnError = call.args[0] === true || call.args[0] === 'true';
    const preUrl = argString(call.args, 1, 'batchPreSignerUrl');
    const postUrl = argString(call.args, 2, 'batchPostSignerUrl');
    const local = call.args[5] === true;
    const n = batch.singlesigns.length;
    if (!local && (!preUrl || !postUrl)) {
      throw AfirmaError.invalidParameter('No se han indicado los servicios de firma por lotes');
    }
    // Reject an unsupported algorithm before the user is asked to approve.
    checkAlgorithm(batch.algorithm);
    const { identity } = await approve(ctx, {
      method: call.method,
      format: batch.format,
      algorithm: batch.algorithm,
      origin: call.origin,
      description: [
        `Firmar un lote de ${n} ${n === 1 ? 'documento' : 'documentos'} en formato ${batch.format}.`,
        local
          ? 'Cada documento se firma en este equipo.'
          : 'El servidor del sitio prepara las firmas y tu certificado firma un resumen de cada documento.',
        `Lo pide ${call.origin}.`,
      ].join('\n'),
      dataSize: n,
      documents: [],
      verifiable: false,
      signatures: n,
    });
    const result: BatchResult = await using(identity, () => {
      const algorithm = resolveAlgorithm(batch.algorithm, identity.keyType);
      return local
        ? localBatch(batch, stopOnError, algorithm, identity)
        : batchSign({
            batch: { ...batch, stoponerror: stopOnError },
            preUrl: preUrl as string,
            postUrl: postUrl as string,
            algorithm,
            signer: identity.signer,
            chain: identity.chainDer,
            fetch: ctx.fetch,
          });
    });
    return [result, toBase64(identity.certificateDer)];
  }

  /** Legacy XML batch (`signBatch`): always against the site's batch servers. */
  async function xmlBatchOperation(
    call: AfirmaCall,
    ctx: AfirmaHandlerContext,
  ): Promise<{ args: unknown[]; failure?: string }> {
    const batchB64 = argString(call.args, 0, 'batchB64');
    const bytes = batchB64 ? decodeBase64(batchB64) : null;
    if (!bytes || bytes.length === 0) throw AfirmaError.invalidParameter('Lote de firma no valido');
    if (bytes.length > maxBytes) throw AfirmaError.invalidData('El lote es demasiado grande');
    const batch = parseXmlBatch(bytes.toString('utf8'));
    const preUrl = argString(call.args, 1, 'batchPreSignerUrl');
    const postUrl = argString(call.args, 2, 'batchPostSignerUrl');
    if (!preUrl || !postUrl) {
      throw AfirmaError.invalidParameter('No se han indicado los servicios de firma por lotes');
    }
    if (batch.signs.length > 500)
      throw AfirmaError.invalidParameter('Lote de firma demasiado grande');
    // Reject an unsupported algorithm before the user is asked to approve.
    checkAlgorithm(batch.algorithm);
    const n = batch.signs.length;
    const formats = [...new Set(batch.signs.map((s) => s.format).filter(Boolean))].join(', ');
    const inFormat = formats ? ` en formato ${formats}` : '';
    const { identity } = await approve(ctx, {
      method: call.method,
      format: formats,
      algorithm: batch.algorithm,
      origin: call.origin,
      description: [
        n > 1
          ? `Firmar un lote de ${n} documentos${inFormat}.`
          : (batch.signs[0]?.dataSize ?? Number.POSITIVE_INFINITY) <= 128
            ? `Firmar un código corto del sitio${inFormat} (normalmente, para identificarte).`
            : `Firmar un documento${inFormat}.`,
        'El servidor del sitio prepara las firmas y tu certificado firma un resumen de cada documento. No se puede mostrar el contenido exacto.',
        `Lo pide ${call.origin}.`,
      ].join('\n'),
      documents: [],
      verifiable: false,
      signatures: n,
    });
    const result = await using(identity, () =>
      xmlBatchSign({
        batch: bytes,
        preUrl,
        postUrl,
        algorithm: resolveAlgorithm(batch.algorithm, identity.keyType),
        signer: identity.signer,
        chain: identity.chainDer,
        fetch: ctx.fetch,
      }),
    );
    const failed = result.results.filter((r) => !BATCH_DONE.has(r.result));
    const failure =
      failed.length || result.results.length === 0
        ? `El servidor del sitio no completó ${failed.length || n} de ${n} firmas${failed[0] ? ` (${failed[0].result}${failed[0].description ? `: ${failed[0].description}` : ''})` : ''}`
        : undefined;
    return {
      args: [toBase64(Buffer.from(result.log, 'utf8')), toBase64(identity.certificateDer)],
      ...(failure ? { failure } : {}),
    };
  }

  async function localBatch(
    batch: BatchRequest,
    stopOnError: boolean,
    algorithm: ResolvedAlgorithm,
    identity: SignerIdentity,
  ): Promise<BatchResult> {
    const signs: BatchResultEntry[] = [];
    let failed = false;
    for (const single of batch.singlesigns) {
      if (failed && stopOnError) {
        signs.push({ id: single.id, result: 'SKIPPED' });
        continue;
      }
      try {
        const extra = single.extraparams ?? batch.extraparams;
        // AutoFirma: Base64 → literal "\n" to newlines → Properties.load (ISO-8859-1).
        const paramsText = extra
          ? Buffer.from(extra, 'base64').toString('latin1').trim().replace(/\\n/g, '\n')
          : '';
        const params = parseExtraParams(paramsText);
        const data = decodeBase64(single.datareference);
        if (!data || data.length > maxBytes) throw AfirmaError.invalidData();
        const spec = parseFormat(single.format ?? batch.format);
        const sub = (single.suboperation ?? batch.suboperation ?? 'sign').toLowerCase();
        const cop: Cop =
          sub === 'cosign' ? 'cosign' : sub === 'countersign' ? 'countersign' : 'sign';
        const family =
          spec.family ??
          (cop === 'sign' ? detectFormatForSign(data) : detectFormatForSignature(data));
        if (spec.triphase || !LOCAL_FAMILIES.has(family))
          throw AfirmaError.unsupportedFormat(spec.requested);
        const effective =
          family === 'NONE' ? params : expandPolicy(params, family as PolicyFormat, data.length);
        const signature = await signLocally(family, cop, {
          data: cop === 'sign' ? data : null,
          signature: cop === 'sign' ? null : data,
          algorithm,
          identity,
          params: effective,
          now: now(),
        });
        signs.push({ id: single.id, result: 'DONE_AND_SAVED', signature: toBase64(signature) });
      } catch (e) {
        failed = true;
        signs.push({ id: single.id, result: 'ERROR_PRE', description: toAfirmaError(e).message });
      }
    }
    if (failed && stopOnError) {
      for (const s of signs) {
        if (s.result === 'DONE_AND_SAVED') {
          s.result = 'SKIPPED';
          delete s.signature;
        }
      }
    }
    return { signs };
  }

  async function loadFiles(call: AfirmaCall, multiple: boolean): Promise<unknown[]> {
    if (!options.pickFiles) throw AfirmaError.unsupportedOperation('carga de ficheros');
    const title = argString(call.args, 0, 'title') ?? undefined;
    const exts = argString(call.args, 1, 'extensions');
    const description = argString(call.args, 2, 'description') ?? undefined;
    const picked = await options.pickFiles({
      origin: call.origin,
      title,
      extensions: exts
        ? exts
            .split(/[,;]/)
            .map((e) => e.trim().replace(/^\./, ''))
            .filter(Boolean)
        : undefined,
      description,
      multiple,
      purpose: 'load',
    });
    if (!picked || picked.length === 0) throw AfirmaError.cancelled();
    if (picked.some((f) => f.data.byteLength > maxBytes)) {
      throw AfirmaError.invalidData('El fichero es demasiado grande');
    }
    if (!multiple) return [picked[0].name, toBase64(picked[0].data)];
    return [picked.map((f) => f.name), picked.map((f) => toBase64(f.data))];
  }

  async function saveData(call: AfirmaCall): Promise<unknown[]> {
    if (!options.saveFile) throw AfirmaError.unsupportedOperation('guardado de ficheros');
    const data = decodeBase64(argString(call.args, 0, 'dataB64') ?? '');
    if (!data || data.length > maxBytes) throw AfirmaError.invalidData();
    const ok = await options.saveFile({
      origin: call.origin,
      title: argString(call.args, 1, 'title') ?? undefined,
      fileName: argString(call.args, 2, 'fileName') ?? undefined,
      description: argString(call.args, 4, 'description') ?? undefined,
      data,
    });
    if (!ok) throw AfirmaError.cancelled();
    return ['OK'];
  }

  return async (rawCall: AfirmaCall, ctx: AfirmaHandlerContext): Promise<AfirmaReply> => {
    const checked = CallSchema.safeParse(rawCall);
    const call: AfirmaCall = checked.success
      ? checked.data
      : {
          method: String(rawCall?.method ?? ''),
          args: [],
          origin: String(rawCall?.origin ?? ''),
          url: '',
        };
    let format = '';
    /** The operation ran, but the site's servers reported failed signatures. */
    let failure: string | undefined;
    try {
      if (!checked.success) throw AfirmaError.invalidParameter('Llamada no valida');
      const a = call.args;
      let callbackArgs: unknown[];
      switch (call.method) {
        case 'sign':
          format = argString(a, 2, 'format') ?? '';
          ({ args: callbackArgs, format } = await signOperation(call, ctx, 'sign', {
            dataB64: argString(a, 0, 'dataB64'),
            algorithm: argString(a, 1, 'algorithm'),
            format: argString(a, 2, 'format'),
            params: argString(a, 3, 'params'),
          }));
          break;
        case 'coSign':
          format = argString(a, 3, 'format') ?? '';
          ({ args: callbackArgs, format } = await signOperation(call, ctx, 'cosign', {
            signB64: argString(a, 0, 'signB64'),
            dataB64: argString(a, 1, 'dataB64'),
            algorithm: argString(a, 2, 'algorithm'),
            format: argString(a, 3, 'format'),
            params: argString(a, 4, 'params'),
          }));
          break;
        case 'cosign':
        case 'counterSign':
        case 'countersign':
          format = argString(a, 2, 'format') ?? '';
          ({ args: callbackArgs, format } = await signOperation(
            call,
            ctx,
            call.method === 'cosign' ? 'cosign' : 'countersign',
            {
              dataB64: null,
              signB64: argString(a, 0, 'signB64'),
              algorithm: argString(a, 1, 'algorithm'),
              format: argString(a, 2, 'format'),
              params: argString(a, 3, 'params'),
            },
          ));
          break;
        case 'signAndSaveToFile': {
          const op = (argString(a, 0, 'operationId') ?? 'sign').toLowerCase();
          const cop: Cop =
            op === 'cosign' ? 'cosign' : op === 'countersign' ? 'countersign' : 'sign';
          format = argString(a, 3, 'format') ?? '';
          const input = {
            dataB64: cop === 'sign' ? argString(a, 1, 'dataB64') : null,
            signB64: cop === 'sign' ? null : argString(a, 1, 'dataB64'),
            algorithm: argString(a, 2, 'algorithm'),
            format: argString(a, 3, 'format'),
            params: argString(a, 4, 'params'),
            outputFileName: argString(a, 5, 'outputFileName') ?? '',
          };
          ({ args: callbackArgs, format } = await signOperation(call, ctx, cop, input));
          break;
        }
        case 'selectCertificate':
          callbackArgs = await selectCertificate(call, ctx);
          break;
        case 'signBatchProcess':
          format = 'lote';
          callbackArgs = await batchOperation(call, ctx);
          break;
        case 'signBatch':
          format = 'lote';
          ({ args: callbackArgs, failure } = await xmlBatchOperation(call, ctx));
          break;
        case 'saveDataToFile':
          callbackArgs = await saveData(call);
          break;
        case 'getFileNameContentBase64':
          callbackArgs = await loadFiles(call, false);
          break;
        case 'getMultiFileNameContentBase64':
          callbackArgs = await loadFiles(call, true);
          break;
        default:
          throw AfirmaError.unsupportedOperation(call.method);
      }
      if (isSignatureMethod(call.method)) {
        ctx.report(
          failure
            ? { status: 'failed', format, origin: call.origin, message: failure }
            : { status: 'signed', format, origin: call.origin },
        );
      }
      return { ok: true, callbackArgs };
    } catch (e) {
      const err = toAfirmaError(e);
      if (isSignatureMethod(call.method)) {
        ctx.report({
          status: err.errorType === CANCELLED_TYPE ? 'rejected' : 'failed',
          format,
          origin: call.origin,
          message: err.message,
        });
      }
      const reply: AfirmaReply & { errorCode: string } = {
        ok: false,
        errorType: err.errorType,
        errorMessage: err.message,
        errorCode: err.errorCode,
      };
      return reply;
    }
  };
}

/** Batch results of a signature the site's servers made. */
const BATCH_DONE = new Set(['DONE_AND_SAVED', 'DONE_BUT_NOT_SAVED_YET', 'DONE_BUT_SAVED_SKIPPED']);

const SIGNATURE_METHODS = new Set([
  'sign',
  'coSign',
  'cosign',
  'counterSign',
  'countersign',
  'signAndSaveToFile',
  'signBatchProcess',
  'signBatch',
  'selectCertificate',
]);

function isSignatureMethod(method: string): boolean {
  return SIGNATURE_METHODS.has(method);
}

function xadesVariantLabel(family: FormatFamily, params: ExtraParams): string {
  if (family !== 'XAdES') return family;
  return params.format &&
    /^XAdES (Detached|Enveloped|Enveloping|Externally Detached)$/.test(params.format)
    ? params.format
    : 'XAdES Enveloping';
}

/** Default handler (no file chooser or save hooks). */
export const afirmaHandler: AfirmaHandler = createAfirmaHandler();
