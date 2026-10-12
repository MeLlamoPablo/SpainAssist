/**
 * In-page replacement for AutoFirma's `autoscript.js` (`AutoScript` / `MiniApplet` globals).
 *
 * `installAutoscriptShim` is serialized with `Function.prototype.toString()` and injected into
 * every frame before any page script runs (see `buildAutoscriptShimSource`). It therefore MUST be
 * self-contained:
 *  - no runtime imports and no references to module scope (only `import type`);
 *  - no syntax a bundler may rewrite into helper calls (`async`/`await`, classes, object/array
 *    spread, `for...of`, decorators, enums).
 *
 * How it works (see docs/research/autofirma.md §2.2):
 *  - `AutoScript` and `MiniApplet` become accessor properties of `window`. They read as
 *    `undefined` until the site's own script assigns them (a top-level `var AutoScript = ...`
 *    calls our setter instead of redefining the property), and from then on they return the shim
 *    object. The site's real script still runs, so its other globals (`Base64`, `Cipher`,
 *    `SupportDialog`, ...) keep working; the real AutoScript object is just never used.
 *  - Every operation is serialized into an `AfirmaCall` (callbacks stripped) and sent to the
 *    browser binding `window[config.binding]`, which resolves with an `AfirmaReply`. The site's
 *    success / error callbacks are then invoked asynchronously with the same argument shapes as
 *    AutoFirma 1.10 (`(signatureB64, certificateB64, extraData)`, `(errorType, message, code)`).
 *  - Nothing here opens `afirma://` URLs, WebSockets or the intermediate servlets.
 *  - The shim implements the whole public surface of autoscript.js 1.10.1, the 1.8.x copies
 *    some platforms bundle (`setWaitCertMaxLoops`, `setWaitCertTimeout`) and the MiniApplet 1.5
 *    helpers. When the page's own AutoScript object has a method the shim lacks, the shim gets a
 *    no-op with that name (constants are copied), so a page never dies on a missing method.
 *  - Diagnostics go through the same binding as `{ method: config.notice, args: [kind, detail] }`
 *    (`AFIRMA_NOTICE`): `'loaded'` once the page creates its AutoScript object, `'ignored'` the
 *    first time the page calls one of those no-ops. They never sign anything.
 *
 * Wire layout of `AfirmaCall.args` (AutoScript positional arguments without the callbacks):
 *  - sign:               [dataB64, algorithm, format, params]
 *  - coSign:             [signB64, dataB64, algorithm, format, params]  (`cosign` → dataB64 null)
 *  - counterSign:        [signB64, algorithm, format, params]           (also `countersign`)
 *  - signAndSaveToFile:  [operationId, dataB64, algorithm, format, params, outputFileName]
 *  - selectCertificate:  [params]
 *  - signBatchProcess:   [stopOnError, batchPreSignerUrl, batchPostSignerUrl, certFilters,
 *                         batch (object built by createBatch/addDocumentToBatch), localBatch]
 *  - signBatch:          [batchB64, batchPreSignerUrl, batchPostSignerUrl, params]
 *                         (legacy XML batch: Base64 of a `<signbatch>` document, signed by the
 *                         app against the site's BatchPresigner / BatchPostsigner)
 *  - saveDataToFile:     [dataB64, title, fileName, extension, description]
 *  - getFileNameContentBase64 / getMultiFileNameContentBase64: [title, extensions, description,
 *                         filePath]
 */
import type { AfirmaCall } from '@sa/shared';

/** Configuration baked into the injected source. */
export interface AutoscriptShimConfig {
  /** Name of the binding exposed to pages by the browser (`AFIRMA_BINDING`). */
  binding: string;
  /** `AfirmaCall.method` of the shim's diagnostics (`AFIRMA_NOTICE`). */
  notice: string;
  /** `AutoScript.VERSION` until the site's own script provides the real one. */
  version: string;
}

/** Diagnostics object stored (non-enumerable) at `window[Symbol.for('sa.afirma.shim')]`. */
export interface AutoscriptShimHandle {
  readonly config: AutoscriptShimConfig;
  diagnostics(): {
    /** Globals the page has assigned so far, e.g. `{ AutoScript: true, MiniApplet: true }`. */
    assigned: Record<string, boolean>;
    /** VERSION values of the real AutoScript objects the page created. */
    realVersions: string[];
    /** Operations forwarded to the binding that have not finished yet. */
    pending: number;
    /** Methods of the page's AutoScript the shim answers with a no-op. */
    stubbed: string[];
  };
}

export const SHIM_HANDLE_SYMBOL = 'sa.afirma.shim';

export function installAutoscriptShim(config: AutoscriptShimConfig): void {
  type Fn = (...args: unknown[]) => unknown;
  type Batch = {
    algorithm: unknown;
    format: unknown;
    suboperation: unknown;
    extraparams?: string;
    stoponerror?: unknown;
    singlesigns: Record<string, unknown>[];
  };

  const w = window as unknown as Record<string | symbol, unknown>;
  const MARK = Symbol.for('sa.afirma.shim');
  if (w[MARK]) return;

  // Capture intrinsics before page scripts can replace them.
  const defineProperty = Object.defineProperty;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const setTimeoutRef = window.setTimeout.bind(window);
  const PromiseRef = Promise;
  const jsonStringify = JSON.stringify;
  const jsonParse = JSON.parse;
  const isArray = Array.isArray;
  const fromCharCode = String.fromCharCode;
  const objectKeys = Object.keys;
  const XHR = window.XMLHttpRequest;
  const loc = window.location;
  const initialBinding = w[config.binding];

  const CANCELLED = 'es.gob.afirma.core.AOCancelledOperationException';
  const GENERIC = 'java.lang.Exception';
  const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

  const lastError = { type: '', message: '', code: '' };
  const state = {
    keystore: null as unknown,
    sticky: false,
    resetSticky: false,
    localBatch: false,
    batch: null as Batch | null,
  };
  let queue: Promise<void> = PromiseRef.resolve();
  let pending = 0;
  const assigned: Record<string, unknown> = {};
  const hasAssigned: Record<string, boolean> = {};
  const realVersions: string[] = [];
  const stubbed: string[] = [];
  const noticed: Record<string, boolean> = {};

  // ------------------------------------------------------------------------------------------
  // Base64 helpers, identical to autoscript's `Base64` global (UTF-8 with "\r\n" -> "\n").
  // ------------------------------------------------------------------------------------------
  function utf8Encode(input: string): string {
    const s = input.replace(/\r\n/g, '\n');
    let out = '';
    for (let n = 0; n < s.length; n++) {
      const c = s.charCodeAt(n);
      if (c < 128) {
        out += fromCharCode(c);
      } else if (c < 2048) {
        out += fromCharCode((c >> 6) | 192) + fromCharCode((c & 63) | 128);
      } else {
        out +=
          fromCharCode((c >> 12) | 224) +
          fromCharCode(((c >> 6) & 63) | 128) +
          fromCharCode((c & 63) | 128);
      }
    }
    return out;
  }

  function utf8Decode(bin: string): string {
    let out = '';
    let i = 0;
    while (i < bin.length) {
      const c = bin.charCodeAt(i);
      if (c < 128) {
        out += fromCharCode(c);
        i += 1;
      } else if (c > 191 && c < 224) {
        out += fromCharCode(((c & 31) << 6) | (bin.charCodeAt(i + 1) & 63));
        i += 2;
      } else {
        out += fromCharCode(
          ((c & 15) << 12) | ((bin.charCodeAt(i + 1) & 63) << 6) | (bin.charCodeAt(i + 2) & 63),
        );
        i += 3;
      }
    }
    return out;
  }

  function binToBase64(bin: string): string {
    let out = '';
    let i = 0;
    while (i < bin.length) {
      const c1 = bin.charCodeAt(i++);
      const c2 = bin.charCodeAt(i++);
      const c3 = bin.charCodeAt(i++);
      let e3 = ((c2 & 15) << 2) | (c3 >> 6);
      let e4 = c3 & 63;
      if (Number.isNaN(c2)) {
        e3 = 64;
        e4 = 64;
      } else if (Number.isNaN(c3)) {
        e4 = 64;
      }
      out +=
        B64_CHARS.charAt(c1 >> 2) +
        B64_CHARS.charAt(((c1 & 3) << 4) | (c2 >> 4)) +
        B64_CHARS.charAt(e3) +
        B64_CHARS.charAt(e4);
    }
    return out;
  }

  function base64ToBin(input: string): string {
    const s = input.replace(/[^A-Za-z0-9+/=]/g, '');
    let out = '';
    let i = 0;
    while (i < s.length) {
      const e1 = B64_CHARS.indexOf(s.charAt(i++));
      const e2 = B64_CHARS.indexOf(s.charAt(i++));
      const e3 = B64_CHARS.indexOf(s.charAt(i++));
      const e4 = B64_CHARS.indexOf(s.charAt(i++));
      out += fromCharCode((e1 << 2) | (e2 >> 4));
      if (e3 !== 64) out += fromCharCode(((e2 & 15) << 4) | (e3 >> 2));
      if (e4 !== 64) out += fromCharCode(((e3 & 3) << 6) | e4);
    }
    return out;
  }

  function textToBase64(text: unknown): string {
    return binToBase64(utf8Encode(String(text)));
  }

  // ------------------------------------------------------------------------------------------
  // Forwarding to the binding
  // ------------------------------------------------------------------------------------------
  function clean(value: unknown): unknown {
    if (value === undefined || value === null) return null;
    const t = typeof value;
    if (t === 'string' || t === 'boolean') return value;
    if (t === 'number') return Number.isFinite(value as number) ? value : null;
    if (t === 'function' || t === 'symbol' || t === 'bigint') return null;
    try {
      return jsonParse(jsonStringify(value));
    } catch (_e) {
      return null;
    }
  }

  function later(cb: unknown, args: unknown[]): void {
    if (typeof cb !== 'function') return;
    setTimeoutRef(() => {
      (cb as Fn).apply(null, args);
    }, 0);
  }

  function fail(ko: unknown, type: string, message: string, code: string): void {
    lastError.type = type;
    lastError.message = message;
    lastError.code = code;
    later(ko, [type, message, code]);
  }

  function deliver(reply: unknown, ok: unknown, ko: unknown): void {
    const r = reply as {
      ok?: unknown;
      callbackArgs?: unknown;
      errorType?: unknown;
      errorMessage?: unknown;
      errorCode?: unknown;
    } | null;
    if (r && r.ok === true) {
      later(ok, isArray(r.callbackArgs) ? (r.callbackArgs as unknown[]).slice() : []);
      return;
    }
    if (r && r.ok === false) {
      const type = typeof r.errorType === 'string' && r.errorType ? r.errorType : GENERIC;
      const message = typeof r.errorMessage === 'string' ? r.errorMessage : '';
      let code = typeof r.errorCode === 'string' ? r.errorCode : '';
      if (!code) code = type === CANCELLED ? 'AS500001' : 'AS620019';
      fail(ko, type, message, code);
      return;
    }
    fail(ko, GENERIC, 'Respuesta no valida', 'AS220006');
  }

  function invoke(method: string, args: unknown[], ok: unknown, ko: unknown): void {
    const cleaned: unknown[] = [];
    for (let i = 0; i < args.length; i++) cleaned.push(clean(args[i]));
    const call: AfirmaCall = { method, args: cleaned, origin: loc.origin, url: loc.href };
    pending++;
    const run = (): Promise<void> =>
      new PromiseRef<void>((resolve) => {
        const done = (): void => {
          pending--;
          resolve();
        };
        const binding = typeof initialBinding === 'function' ? initialBinding : w[config.binding];
        if (typeof binding !== 'function') {
          fail(
            ko,
            GENERIC,
            'Ha ocurrido un error al intentar invocar a la aplicacion nativa mediante websocket',
            'AS620017',
          );
          done();
          return;
        }
        let result: unknown;
        try {
          result = (binding as Fn)(call);
        } catch (_e) {
          fail(ko, GENERIC, 'Error desconocido', 'AS620019');
          done();
          return;
        }
        PromiseRef.resolve(result).then(
          (reply) => {
            deliver(reply, ok, ko);
            done();
          },
          () => {
            fail(ko, GENERIC, 'Error desconocido', 'AS620019');
            done();
          },
        );
      });
    // One operation at a time per frame, like AutoFirma (which would otherwise overwrite the
    // callbacks of a pending operation): later calls wait for earlier ones to finish.
    queue = queue.then(run, run);
  }

  /** Diagnostics for the app, once per kind and detail; never waits, never throws. */
  function notify(kind: string, detail: string): void {
    const key = `${kind}:${detail}`;
    if (noticed[key]) return;
    noticed[key] = true;
    const binding = typeof initialBinding === 'function' ? initialBinding : w[config.binding];
    if (typeof binding !== 'function') return;
    try {
      const call: AfirmaCall = {
        method: config.notice,
        args: [kind, detail],
        origin: loc.origin,
        url: loc.href,
      };
      PromiseRef.resolve((binding as Fn)(call)).then(undefined, () => {});
    } catch (_e) {
      // Diagnostics only.
    }
  }

  function afterOperation(): void {
    state.resetSticky = false;
  }

  // ------------------------------------------------------------------------------------------
  // The replacement object: the complete public surface of autoscript.js 1.10.1 plus the
  // documented lower-case `countersign` and the legacy MiniApplet 1.5 helpers.
  // ------------------------------------------------------------------------------------------
  const shim: Record<string, unknown> = {
    VERSION: config.version,

    CHECKTIME_NO: 'CT_NO',
    CHECKTIME_RECOMMENDED: 'CT_RECOMMENDED',
    CHECKTIME_OBLIGATORY: 'CT_OBLIGATORY',

    JAVA_ARGUMENTS: null,
    SYSTEM_PROPERTIES: null,

    KEYSTORE_WINDOWS: 'WINDOWS',
    KEYSTORE_APPLE: 'APPLE',
    KEYSTORE_PKCS12: 'PKCS12',
    KEYSTORE_PKCS11: 'PKCS11',
    KEYSTORE_MOZILLA: 'MOZ_UNI',
    KEYSTORE_SHARED_NSS: 'SHARED_NSS',
    KEYSTORE_JAVA: 'JAVA',
    KEYSTORE_JCEKS: 'JCEKS',
    KEYSTORE_JAVACE: 'JAVACE',
    KEYSTORE_DNIE: 'DNIEJAVA',

    AUTOFIRMA_LAUNCHING_TIME: 2000,
    AUTOFIRMA_CONNECTION_RETRIES: 15,

    // Deprecated members, kept with their documented behaviour.
    setForceAFirma: () => {},
    setJnlpService: () => {},
    echo: () => 'Cliente JavaScript',
    isJNLP: () => false,
    needNativeAppInstalled: () => true,

    // Loading and configuration: never touch the network, never show dialogs.
    cargarAppAfirma: (_clientAddress?: unknown, keystore?: unknown) => {
      if (keystore != null) state.keystore = keystore;
    },
    cargarMiniApplet: (_codeBase?: unknown, keystore?: unknown) => {
      if (keystore != null) state.keystore = keystore;
    },
    checkTime: () => {
      // AutoFirma does a synchronous request and may alert(); the app checks the clock itself.
    },
    setKeyStore: (keystore?: unknown) => {
      state.keystore = keystore != null ? keystore : null;
      state.resetSticky = true;
    },
    setForceWSMode: () => {},
    setServlets: () => {},
    setPortRange: () => {},
    setStickySignatory: (sticky?: unknown) => {
      if (state.sticky && !sticky) state.resetSticky = true;
      state.sticky = !!sticky;
    },
    setLocale: () => {},
    setMinimumClientVersion: () => {},
    setAppName: () => {},
    setServiceTimeout: () => {},
    enableProgressDialog: () => {},
    // Certificate wait settings of the 1.8.x copies bundled by some platforms (e.g. the gsede
    // clientSigner.js); there is no certificate to wait for here.
    setWaitCertMaxLoops: () => {},
    setWaitCertTimeout: () => {},

    // Cryptographic operations (forwarded).
    sign: (
      dataB64: unknown,
      algorithm: unknown,
      format: unknown,
      params: unknown,
      ok?: unknown,
      ko?: unknown,
    ) => {
      invoke('sign', [dataB64, algorithm, format, params], ok, ko);
      afterOperation();
    },
    coSign: (
      signB64: unknown,
      dataB64: unknown,
      algorithm: unknown,
      format: unknown,
      params: unknown,
      ok?: unknown,
      ko?: unknown,
    ) => {
      invoke('coSign', [signB64, dataB64, algorithm, format, params], ok, ko);
      afterOperation();
    },
    cosign: (
      signB64: unknown,
      algorithm: unknown,
      format: unknown,
      params: unknown,
      ok?: unknown,
      ko?: unknown,
    ) => {
      invoke('coSign', [signB64, null, algorithm, format, params], ok, ko);
      afterOperation();
    },
    counterSign: (
      signB64: unknown,
      algorithm: unknown,
      format: unknown,
      params: unknown,
      ok?: unknown,
      ko?: unknown,
    ) => {
      invoke('counterSign', [signB64, algorithm, format, params], ok, ko);
      afterOperation();
    },
    signAndSaveToFile: (
      operationId: unknown,
      dataB64: unknown,
      algorithm: unknown,
      format: unknown,
      params: unknown,
      outputFileName: unknown,
      ok?: unknown,
      ko?: unknown,
    ) => {
      invoke(
        'signAndSaveToFile',
        [operationId, dataB64, algorithm, format, params, outputFileName],
        ok,
        ko,
      );
      afterOperation();
    },
    selectCertificate: (params: unknown, ok?: unknown, ko?: unknown) => {
      invoke('selectCertificate', [params], ok, ko);
      afterOperation();
    },

    // Batches: built locally exactly like autoscript does, signed by the app.
    createBatch: (
      algorithm: unknown,
      format: unknown,
      suboperation: unknown,
      extraparams?: unknown,
    ) => {
      const batch: Batch = { algorithm, format, suboperation, singlesigns: [] };
      if (extraparams) batch.extraparams = textToBase64(extraparams);
      state.batch = batch;
    },
    addDocumentToBatch: (
      id: unknown,
      datareference: unknown,
      format?: unknown,
      suboperation?: unknown,
      extraparams?: unknown,
    ) => {
      const batch = state.batch;
      if (!id || datareference == null) {
        throw new Error('No se ha indicado el id o datareference de la firma');
      }
      if (!batch) {
        throw new Error(
          'No hay ningun lote creado. Es necesario crear uno antes de agregar firmas',
        );
      }
      for (let i = 0; i < batch.singlesigns.length; i++) {
        // biome-ignore lint/suspicious/noDoubleEquals: autoscript compares ids with ==
        if (batch.singlesigns[i].id == id) {
          throw new Error(
            `El id de la firma a agregar = "${String(batch.singlesigns[i].id)}" ya existe en el lote`,
          );
        }
      }
      const single: Record<string, unknown> = { id, datareference };
      if (format) single.format = format;
      if (suboperation) single.suboperation = suboperation;
      if (extraparams) single.extraparams = textToBase64(extraparams);
      batch.singlesigns.push(single);
    },
    setLocalBatchProcess: (local?: unknown) => {
      state.localBatch = !!local;
    },
    signBatchProcess: (
      stopOnError: unknown,
      batchPreSignerUrl: unknown,
      batchPostSignerUrl: unknown,
      certFilters: unknown,
      ok?: unknown,
      ko?: unknown,
    ) => {
      const batch = state.batch;
      if (!batch) {
        throw new Error('No hay ningun lote creado. Es necesario crear uno antes de firmar.');
      }
      batch.stoponerror = stopOnError;
      invoke(
        'signBatchProcess',
        [stopOnError, batchPreSignerUrl, batchPostSignerUrl, certFilters, batch, state.localBatch],
        ok,
        ko,
      );
      state.batch = null;
      afterOperation();
    },
    signBatch: (
      batchB64: unknown,
      batchPreSignerUrl: unknown,
      batchPostSignerUrl: unknown,
      params: unknown,
      ok?: unknown,
      ko?: unknown,
    ) => {
      invoke('signBatch', [batchB64, batchPreSignerUrl, batchPostSignerUrl, params], ok, ko);
      afterOperation();
    },
    getCurrentLog: (_ok?: unknown, ko?: unknown) => {
      // Same as autoscript 1.10.1: synchronous error, last error not updated.
      if (typeof ko === 'function') {
        (ko as Fn)(
          'java.lang.UnsupportedOperationException',
          'El metodo JavaScript no se encuentra operativo',
          'AS500010',
        );
      }
    },

    // File helpers (forwarded; the app decides whether it can offer them).
    saveDataToFile: (
      dataB64: unknown,
      title: unknown,
      fileName: unknown,
      extension: unknown,
      description: unknown,
      ok?: unknown,
      ko?: unknown,
    ) => {
      invoke('saveDataToFile', [dataB64, title, fileName, extension, description], ok, ko);
    },
    getFileNameContentBase64: (
      title: unknown,
      extensions: unknown,
      description: unknown,
      filePath: unknown,
      ok?: unknown,
      ko?: unknown,
    ) => {
      invoke('getFileNameContentBase64', [title, extensions, description, filePath], ok, ko);
    },
    getMultiFileNameContentBase64: (
      title: unknown,
      extensions: unknown,
      description: unknown,
      filePath: unknown,
      ok?: unknown,
      ko?: unknown,
    ) => {
      invoke('getMultiFileNameContentBase64', [title, extensions, description, filePath], ok, ko);
    },

    // Errors
    getErrorMessage: () => lastError.message,
    getErrorType: () => lastError.type,
    getErrorCode: () => lastError.code,
    getErrorCodeNumber: () => (lastError.code ? lastError.code.substring(2) : null),

    // JavaScript utilities
    getBase64FromText: (plainText: unknown) => (plainText != null ? textToBase64(plainText) : null),
    getTextFromBase64: (dataB64: unknown) =>
      dataB64 != null ? utf8Decode(base64ToBin(String(dataB64))) : null,
    downloadRemoteData: (url: unknown, ok?: unknown, ko?: unknown) => {
      const xhr = new XHR();
      xhr.open('GET', String(url), true);
      xhr.responseType = 'arraybuffer';
      xhr.onload = () => {
        if (xhr.readyState === 4 && xhr.status === 200 && typeof ok === 'function') {
          const bytes = new Uint8Array(xhr.response as ArrayBuffer);
          let bin = '';
          for (let i = 0; i < bytes.length; i++) bin += fromCharCode(bytes[i]);
          (ok as Fn)(binToBase64(bin));
        }
      };
      xhr.onerror = (e) => {
        if (typeof ko === 'function') (ko as Fn)(e);
      };
      xhr.send();
    },

    // Environment: always a desktop browser, never the mobile flows.
    isAndroid: () => false,
    isIOS: () => false,

    // Legacy MiniApplet 1.5 (Junta de Andalucía) helpers.
    isAppletLoaded: () => false,
    setTryMiniapplet: () => {},
    waitMiniappletLoading: () => {},
  };

  shim.countersign = shim.counterSign;

  // Legacy MiniApplet 1.5 `multiModeSign`: one operation per document, each reported to the same
  // callbacks (sites that need their own version, like Andalucía's batchscript.js, replace it).
  shim.multiModeSign = (
    operationArray: unknown,
    dataArray: unknown,
    originalDataArray: unknown,
    arrayLength: unknown,
    algorithm: unknown,
    format: unknown,
    params: unknown,
    ok?: unknown,
    ko?: unknown,
  ) => {
    const ops = operationArray as unknown[];
    const datas = dataArray as unknown[];
    const originals = originalDataArray as unknown[];
    const n = Number(arrayLength);
    if (!algorithm || !format) {
      later(ko, [
        'ERROR [multiModeSign()]',
        'El algoritmo de firma y el formato son parámetros obligatorios (commonSignAlgorithm, commonSignFormat)',
      ]);
      return;
    }
    if (
      !isArray(ops) ||
      !isArray(datas) ||
      !isArray(originals) ||
      !(n > 0) ||
      ops.length !== n ||
      datas.length !== n ||
      originals.length !== n
    ) {
      later(ko, [
        'ERROR [multiModeSign()]',
        'Definición incorrecta de los parámetros de entrada (operationArray, dataArray, originalDataArray, arrayLength). Los tamaños de tabla deben coincidir con el indicado y no pueden ser vacías.',
      ]);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (ops[i] === 'sign') {
        invoke('sign', [datas[i], algorithm, format, params], ok, ko);
      } else if (ops[i] === 'cosign') {
        invoke('coSign', [datas[i], originals[i], algorithm, format, params], ok, ko);
      } else if (ops[i] === 'countersign') {
        invoke('counterSign', [datas[i], algorithm, format, params], ok, ko);
      }
    }
    afterOperation();
  };

  // ------------------------------------------------------------------------------------------
  // Traps on the globals
  // ------------------------------------------------------------------------------------------
  /** A no-op standing in for a method of the page's AutoScript that the shim doesn't know. */
  function stub(name: string): Fn {
    return () => {
      notify('ignored', name);
      return undefined;
    };
  }

  function adopt(value: unknown): void {
    if (!value || value === shim) return;
    if (typeof value !== 'object' && typeof value !== 'function') return;
    const real = value as Record<string, unknown>;
    const version = real.VERSION;
    if (typeof version === 'string' && version) {
      shim.VERSION = version;
      realVersions.push(version);
    }
    let names: string[] = [];
    try {
      names = objectKeys(real);
    } catch (_e) {
      names = [];
    }
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (name in shim) continue;
      let member: unknown;
      try {
        member = real[name];
      } catch (_e) {
        continue;
      }
      const t = typeof member;
      if (t === 'function') {
        shim[name] = stub(name);
        stubbed.push(name);
      } else if (member === null || t === 'string' || t === 'number' || t === 'boolean') {
        shim[name] = member;
      }
    }
    notify('loaded', typeof version === 'string' ? version : '');
  }

  function trap(name: string): void {
    const existing = getOwnPropertyDescriptor(w, name);
    if (existing && !existing.configurable) return;
    if (existing && 'value' in existing) {
      hasAssigned[name] = true;
      assigned[name] = existing.value;
      adopt(existing.value);
    }
    defineProperty(w, name, {
      configurable: true,
      enumerable: true,
      get: () => {
        if (!hasAssigned[name]) return undefined;
        const value = assigned[name];
        return value ? shim : value;
      },
      set: (value: unknown) => {
        hasAssigned[name] = true;
        assigned[name] = value;
        adopt(value);
      },
    });
  }

  trap('AutoScript');
  trap('MiniApplet');

  defineProperty(w, MARK, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: {
      config,
      diagnostics: () => ({
        assigned: {
          AutoScript: !!hasAssigned.AutoScript,
          MiniApplet: !!hasAssigned.MiniApplet,
        },
        realVersions: realVersions.slice(),
        pending,
        stubbed: stubbed.slice(),
      }),
    },
  });
}
