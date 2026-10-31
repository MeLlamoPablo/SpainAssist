/**
 * In-page stand-in for FNMT's Configurador: replaces the `FnmtCertRequest` global of FNMT's
 * `fnmtcertrq.js` (docs/research/fnmt.md §2.1, §7.3).
 *
 * `installFnmtShim` is serialized with `Function.prototype.toString()` and injected into every
 * frame before any page script runs (see `buildFnmtShimSource`), so the same rules as the
 * AutoScript shim (`runtime.ts`) apply: self-contained, only `import type`, and no syntax a
 * bundler may rewrite into helper calls (`async`/`await`, classes, spreads, `for...of`).
 *
 * How it works:
 *  - `FnmtCertRequest` becomes an accessor property of `window`. It reads as `undefined` until
 *    FNMT's script assigns it (its top-level `var FnmtCertRequest = (function(){…})(window)`
 *    calls our setter), and from then on returns the shim object. The page's own object is kept
 *    for its harmless helpers (Base64 conversions, downloads, platform checks), which pass
 *    through.
 *  - `requestCert(ok, ko, keyType, keyLength, csrType, forceCard)` and `installCert(ok, ko,
 *    cert)` are sent to the binding `window[config.binding]` as an `FnmtCall`; the reply
 *    (`FnmtReply`) calls `ok(result)` or `ko(errorType, message)` asynchronously, as the real
 *    object does after its relay round trip. No `fnmtcr://` link, relay or polling.
 *  - `forceCard === true` (a smart card is required) fails at once: the app has no card support.
 *  - `cargarAppFnmt` and `setServlets` are accepted and ignored: there is no relay.
 *  - Any other method of the page's object gets a no-op, and the app a notice (`'ignored'`).
 */
import type { FnmtCall } from '@sa/shared';

/** Configuration baked into the injected source. */
export interface FnmtShimConfig {
  /** Name of the binding exposed to pages by the browser (`FNMT_BINDING`). */
  binding: string;
  /** `FnmtCall.method` of the shim's diagnostics (`FNMT_NOTICE`). */
  notice: string;
  /** `FnmtCertRequest.VERSION` until FNMT's own script provides the real one. */
  version: string;
  /** Error types (`FNMT_ERROR`). */
  errors: { generic: string; cardNotSupported: string };
}

/** Diagnostics object stored (non-enumerable) at `window[Symbol.for('sa.fnmt.shim')]`. */
export interface FnmtShimHandle {
  readonly config: FnmtShimConfig;
  diagnostics(): {
    /** The page assigned its FnmtCertRequest object. */
    assigned: boolean;
    /** VERSION of the page's object. */
    realVersion: string;
    /** Operations forwarded to the binding that have not finished yet. */
    pending: number;
    /** Methods of the page's object the shim answers with a no-op. */
    stubbed: string[];
  };
}

export function installFnmtShim(config: FnmtShimConfig): void {
  type Fn = (...args: unknown[]) => unknown;

  const w = window as unknown as Record<string | symbol, unknown>;
  const MARK = Symbol.for('sa.fnmt.shim');
  if (w[MARK]) return;

  // Capture intrinsics before page scripts can replace them.
  const defineProperty = Object.defineProperty;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const setTimeoutRef = window.setTimeout.bind(window);
  const PromiseRef = Promise;
  const objectKeys = Object.keys;
  const loc = window.location;
  const initialBinding = w[config.binding];

  const lastError = { type: '', message: '' };
  let pending = 0;
  let hasAssigned = false;
  let assigned: unknown;
  let realVersion = '';
  const stubbed: string[] = [];
  const noticed: Record<string, boolean> = {};

  function binding(): unknown {
    return typeof initialBinding === 'function' ? initialBinding : w[config.binding];
  }

  function clean(value: unknown): unknown {
    if (value === undefined || value === null) return null;
    const t = typeof value;
    if (t === 'string' || t === 'boolean') return value;
    if (t === 'number') return Number.isFinite(value as number) ? value : null;
    return null;
  }

  function later(cb: unknown, args: unknown[]): void {
    if (typeof cb !== 'function') return;
    setTimeoutRef(() => {
      (cb as Fn).apply(null, args);
    }, 0);
  }

  function fail(ko: unknown, type: string, message: string): void {
    lastError.type = type;
    lastError.message = message;
    later(ko, [type, message]);
  }

  function deliver(reply: unknown, ok: unknown, ko: unknown): void {
    const r = reply as {
      ok?: unknown;
      result?: unknown;
      errorType?: unknown;
      errorMessage?: unknown;
    } | null;
    if (r && r.ok === true) {
      later(ok, typeof r.result === 'string' ? [r.result] : []);
      return;
    }
    if (r && r.ok === false) {
      const type =
        typeof r.errorType === 'string' && r.errorType ? r.errorType : config.errors.generic;
      fail(ko, type, typeof r.errorMessage === 'string' ? r.errorMessage : '');
      return;
    }
    fail(ko, config.errors.generic, 'Respuesta no válida de la aplicación');
  }

  function invoke(method: string, args: unknown[], ok: unknown, ko: unknown): void {
    const cleaned: unknown[] = [];
    for (let i = 0; i < args.length; i++) cleaned.push(clean(args[i]));
    const call: FnmtCall = {
      method: method as FnmtCall['method'],
      args: cleaned,
      origin: loc.origin,
      url: loc.href,
    };
    const fn = binding();
    if (typeof fn !== 'function') {
      fail(
        ko,
        'es.gob.fnmt.cert.certrequest.ApplicationNotFoundException',
        'La aplicación de solicitud de certificados no está disponible.',
      );
      return;
    }
    pending++;
    let result: unknown;
    try {
      result = (fn as Fn)(call);
    } catch (_e) {
      pending--;
      fail(ko, config.errors.generic, 'Error desconocido');
      return;
    }
    PromiseRef.resolve(result).then(
      (reply) => {
        pending--;
        deliver(reply, ok, ko);
      },
      () => {
        pending--;
        fail(ko, config.errors.generic, 'Error desconocido');
      },
    );
  }

  /** Diagnostics for the app, once per kind and detail; never waits, never throws. */
  function notify(kind: string, detail: string): void {
    const key = `${kind}:${detail}`;
    if (noticed[key]) return;
    noticed[key] = true;
    const fn = binding();
    if (typeof fn !== 'function') return;
    try {
      const call: FnmtCall = {
        method: config.notice as FnmtCall['method'],
        args: [kind, detail],
        origin: loc.origin,
        url: loc.href,
      };
      PromiseRef.resolve((fn as Fn)(call)).then(undefined, () => {});
    } catch (_e) {
      // Diagnostics only.
    }
  }

  function realMember(name: string): unknown {
    try {
      const real = assigned as Record<string, unknown> | null;
      return real ? real[name] : undefined;
    } catch (_e) {
      return undefined;
    }
  }

  /** Calls the page's own helper (pure conversions and checks), or `fallback` without one. */
  function passThrough(name: string, fallback: unknown): Fn {
    // The page's helpers take at most three arguments (downloadRemoteData(url, ok, ko)).
    return (a: unknown, b: unknown, c: unknown) => {
      const member = realMember(name);
      if (typeof member !== 'function') return fallback;
      return (member as Fn).call(assigned, a, b, c);
    };
  }

  const shim: Record<string, unknown> = {
    VERSION: config.version,
    cargarAppFnmt: () => {},
    setServlets: () => {},
    requestCert: (
      ok: unknown,
      ko: unknown,
      keyType: unknown,
      keyLength: unknown,
      csrType: unknown,
      forceCard: unknown,
    ) => {
      if (forceCard === true) {
        fail(
          ko,
          config.errors.cardNotSupported,
          'Esta solicitud exige generar las claves en una tarjeta criptográfica, y SpainAssist no las admite.',
        );
        return;
      }
      invoke('requestCert', [keyType, keyLength, csrType, forceCard], ok, ko);
    },
    installCert: (ok: unknown, ko: unknown, cert: unknown) => {
      if (typeof cert !== 'string' || !cert) {
        fail(
          ko,
          'java.lang.IllegalArgumentException',
          'No se ha recibido el certificado del servidor',
        );
        return;
      }
      invoke('installCert', [cert], ok, ko);
    },
    getErrorMessage: () => lastError.message,
    getErrorType: () => lastError.type,
    getBase64FromText: passThrough('getBase64FromText', null),
    getTextFromBase64: passThrough('getTextFromBase64', null),
    downloadRemoteData: passThrough('downloadRemoteData', undefined),
    isAndroid: passThrough('isAndroid', false),
    isIOS: passThrough('isIOS', false),
  };

  function stub(name: string): Fn {
    return () => {
      notify('ignored', name);
      return undefined;
    };
  }

  /** Takes the page's object: its VERSION and constants, and no-ops for unknown methods. */
  function adopt(real: unknown): void {
    if (!real || typeof real !== 'object') return;
    const r = real as Record<string, unknown>;
    let version: unknown;
    try {
      version = r.VERSION;
    } catch (_e) {
      version = undefined;
    }
    if (typeof version === 'string') {
      realVersion = version;
      shim.VERSION = version;
    }
    let names: string[];
    try {
      names = objectKeys(r);
    } catch (_e) {
      names = [];
    }
    for (let i = 0; i < names.length; i++) {
      const name = names[i] as string;
      if (name in shim) continue;
      let member: unknown;
      try {
        member = r[name];
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
    notify('loaded', realVersion);
  }

  const existing = getOwnPropertyDescriptor(w, 'FnmtCertRequest');
  if (existing && !existing.configurable) return;
  if (existing && 'value' in existing) {
    hasAssigned = true;
    assigned = existing.value;
    adopt(existing.value);
  }
  defineProperty(w, 'FnmtCertRequest', {
    configurable: true,
    enumerable: true,
    get: () => {
      if (!hasAssigned) return undefined;
      return assigned ? shim : assigned;
    },
    set: (value: unknown) => {
      hasAssigned = true;
      assigned = value;
      adopt(value);
    },
  });

  defineProperty(w, MARK, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: {
      config,
      diagnostics: () => ({
        assigned: hasAssigned,
        realVersion,
        pending,
        stubbed: stubbed.slice(),
      }),
    },
  });
}
