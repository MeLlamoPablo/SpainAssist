import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';

/** Who signed in with ChatGPT, as proven by an OpenAI ID token. */
export interface ChatGPTIdentity {
  /** `iss` of the token. */
  issuer: string;
  /** `sub`: OpenAI's public subject identifier (the same for every client of the account). */
  subject: string;
}

export interface IdentityVerifier {
  /** Throws InvalidIdentityError when the token is not a valid OpenAI ID token for us. */
  verify(idToken: string): Promise<ChatGPTIdentity>;
}

export class InvalidIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIdentityError';
  }
}

export interface ChatGPTVerifierOptions {
  /** Expected `iss`, e.g. https://auth.openai.com. */
  issuer: string;
  /** Signing keys: OpenAI's published JWKS (createRemoteJWKSet) or a local set in tests. */
  keys: JWTVerifyGetKey;
  /**
   * Every `aud` must start with this: "Sign in with ChatGPT" for local apps registers one
   * client per installation (`oaiapp_…`), so there is no fixed client id to compare with.
   * The prefix keeps out ID tokens issued to OpenAI's own clients (e.g. Codex CLI).
   */
  audiencePrefix: string;
  /** Oldest accepted `iat`, in seconds. */
  maxAgeSeconds?: number;
}

const ID_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Verifies OpenAI ID tokens from "Sign in with ChatGPT": RS256 signature against OpenAI's JWKS,
 * issuer, expiry (60 s leeway), age, and an audience of a per-install agent client. The nonce
 * was already checked by the app that ran the login; a replayed token only returns the same
 * account's own key. Error messages never contain the token or its claims.
 */
export function createChatGPTVerifier(options: ChatGPTVerifierOptions): IdentityVerifier {
  return {
    async verify(idToken) {
      if (!ID_TOKEN.test(idToken)) throw new InvalidIdentityError('malformed ID token');
      let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
      try {
        ({ payload } = await jwtVerify(idToken, options.keys, {
          issuer: options.issuer,
          algorithms: ['RS256'],
          requiredClaims: ['sub', 'aud', 'exp', 'iat'],
          clockTolerance: 60,
          maxTokenAge: options.maxAgeSeconds ?? 24 * 3600,
        }));
      } catch (err) {
        // jose's messages name the failed check (e.g. '"exp" claim timestamp check failed').
        throw new InvalidIdentityError(`ID token rejected (${(err as Error).name})`);
      }
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (
        audiences.length === 0 ||
        !audiences.every((a) => typeof a === 'string' && a.startsWith(options.audiencePrefix))
      ) {
        throw new InvalidIdentityError('ID token was not issued to a ChatGPT agent client');
      }
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new InvalidIdentityError('ID token has no subject');
      }
      return { issuer: options.issuer, subject: payload.sub };
    },
  };
}

/** OpenAI's JWKS, fetched lazily and cached by jose (keys rotate; unknown kids refetch). */
export function remoteJwks(url: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(url), { timeoutDuration: 10_000 });
}
