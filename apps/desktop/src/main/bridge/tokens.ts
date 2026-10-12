import { createHash, randomBytes } from 'node:crypto';

/**
 * Bearer tokens for agent processes: one per running agent, identifying its procedure.
 * A new token is issued on every agent start (the previous one stops working immediately).
 * Only hashes are kept as map keys.
 */
export class TokenRegistry {
  private readonly byHash = new Map<string, string>();
  private readonly hashByProcedure = new Map<string, string>();

  private static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  issue(procedureId: string): string {
    this.revoke(procedureId);
    const token = randomBytes(32).toString('base64url');
    const hash = TokenRegistry.hash(token);
    this.byHash.set(hash, procedureId);
    this.hashByProcedure.set(procedureId, hash);
    return token;
  }

  /** The procedure id for a token, or undefined. */
  resolve(token: string | undefined): string | undefined {
    if (!token) return undefined;
    return this.byHash.get(TokenRegistry.hash(token));
  }

  revoke(procedureId: string): void {
    const hash = this.hashByProcedure.get(procedureId);
    if (!hash) return;
    this.byHash.delete(hash);
    this.hashByProcedure.delete(procedureId);
  }

  /** Revokes `token` only if it is still the procedure's current token. */
  revokeToken(procedureId: string, token: string): void {
    if (this.hashByProcedure.get(procedureId) === TokenRegistry.hash(token))
      this.revoke(procedureId);
  }

  revokeAll(): void {
    this.byHash.clear();
    this.hashByProcedure.clear();
  }
}
