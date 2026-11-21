import { z } from 'zod';
import type { AndroidApk } from './app';
import { DEFAULT_LIMITS } from './rooms';

const Env = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8794),
  TRUST_PROXY: z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((v) => v === '1' || v === 'true'),
  /** Comma-separated SHA-256 fingerprints of the Android app's signing certificates. */
  ANDROID_CERT_SHA256: z.string().default(''),
  ANDROID_PACKAGE: z.string().default('es.spainassist.firma'),
  INSTALL_URL: z.url().optional(),
  /**
   * The APK offered outside Google Play: its direct URL (a GitHub release asset), its version
   * (X.Y.Z) and the SHA-256 of the file (hex). All three or none; empty counts as unset.
   */
  ANDROID_APK_URL: z.string().default(''),
  ANDROID_APK_VERSION: z.string().default(''),
  ANDROID_APK_SHA256: z.string().default(''),
  ROOMS_PER_ADDRESS: z.coerce.number().int().positive().default(DEFAULT_LIMITS.roomsPerAddress),
  CONNECTIONS_PER_ADDRESS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_LIMITS.connectionsPerAddress),
  MAX_CONNECTIONS: z.coerce.number().int().positive().default(DEFAULT_LIMITS.maxConnections),
  ROOM_MEGABYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_LIMITS.roomBytes / 1024 / 1024),
  /** Backlog of one receiver before it is disconnected. */
  BUFFERED_MEGABYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_LIMITS.maxBuffered / 1024 / 1024),
  /** Backlog of all receivers together (keep it well under the container's memory limit). */
  MAX_BUFFERED_MEGABYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_LIMITS.maxBufferedTotal / 1024 / 1024),
});

const Apk = z.object({
  url: z.url({ protocol: /^https$/ }),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  sha256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .transform((s) => s.toLowerCase()),
});

/** The APK's three variables together, or none of them: some without the others is a mistake. */
function androidApk(e: z.infer<typeof Env>): AndroidApk | undefined {
  const vars = {
    ANDROID_APK_URL: e.ANDROID_APK_URL.trim(),
    ANDROID_APK_VERSION: e.ANDROID_APK_VERSION.trim(),
    ANDROID_APK_SHA256: e.ANDROID_APK_SHA256.trim(),
  };
  const missing = Object.entries(vars)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length === 3) return undefined;
  if (missing.length > 0)
    throw new Error(
      `Missing ${missing.join(', ')}: set ANDROID_APK_URL, ANDROID_APK_VERSION and ANDROID_APK_SHA256 together, or none of them`,
    );
  return Apk.parse({
    url: vars.ANDROID_APK_URL,
    version: vars.ANDROID_APK_VERSION,
    sha256: vars.ANDROID_APK_SHA256,
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = Env.parse(env);
  const apk = androidApk(e);
  return {
    host: e.HOST,
    port: e.PORT,
    trustProxy: e.TRUST_PROXY,
    androidPackage: e.ANDROID_PACKAGE,
    androidCertFingerprints: e.ANDROID_CERT_SHA256.split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(s)),
    installUrl: e.INSTALL_URL,
    ...(apk ? { androidApk: apk } : {}),
    limits: {
      roomsPerAddress: e.ROOMS_PER_ADDRESS,
      connectionsPerAddress: e.CONNECTIONS_PER_ADDRESS,
      maxConnections: e.MAX_CONNECTIONS,
      roomBytes: e.ROOM_MEGABYTES * 1024 * 1024,
      maxBuffered: e.BUFFERED_MEGABYTES * 1024 * 1024,
      maxBufferedTotal: e.MAX_BUFFERED_MEGABYTES * 1024 * 1024,
    },
  };
}
