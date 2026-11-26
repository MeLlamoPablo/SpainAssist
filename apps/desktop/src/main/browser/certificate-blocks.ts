import { randomUUID } from 'node:crypto';

/** How long a block's end waits after the last signature or handshake before it closes. */
const CERTIFICATE_QUIET_MS = 2_000;
/** A block's end never waits longer than this for the signatures in it (the user may be away). */
const MAX_WAIT_MS = 15 * 60_000;

export interface CertificateBlock {
  id: string;
  procedureId: string;
  /** The certificate or DNI the block's sites may use. */
  credentialId: string;
  /** Names the block to the phone that holds the DNI (`CompanionSignRequest.session`). */
  session: string;
  runId?: string;
  /** The block turned on TLS client-certificate logins for the procedure's browser. */
  tls: boolean;
  closing?: Promise<void>;
}

/**
 * The agent's certificate blocks (`page.withCertificate`): a procedure's sites may use one of the
 * user's certificates (AutoFirma signatures and logins, TLS client-certificate logins) only while
 * a block is open, and only the one the block names. Opening a block asks the user nothing: the
 * app asks when a site uses the certificate. Its end waits until the signatures and handshakes
 * in it are over, then `stop` turns the certificate off. A request outside a block is refused,
 * and the agent's next action fails with the reason (`refusal`).
 */
export class CertificateBlocks {
  private readonly blocks = new Map<string, CertificateBlock>();
  /** Certificate operations in progress, by procedure, and when the last one ended. */
  private readonly activity = new Map<string, { busy: number; last: number }>();
  /** Procedures whose page asked AutoFirma for a certificate outside a block. */
  private readonly refused = new Set<string>();

  constructor(
    private readonly stop: (block: CertificateBlock) => Promise<void>,
    private readonly quietMs = CERTIFICATE_QUIET_MS,
  ) {}

  /** A new block, or undefined when the procedure has one open already. */
  open(
    procedureId: string,
    credentialId: string,
    tls: boolean,
    runId?: string,
  ): CertificateBlock | undefined {
    if (this.current(procedureId)) return undefined;
    const session = randomUUID();
    const block: CertificateBlock = {
      id: `cert_${session}`,
      procedureId,
      credentialId,
      session,
      tls,
      ...(runId ? { runId } : {}),
    };
    this.blocks.set(block.id, block);
    this.refused.delete(procedureId);
    return block;
  }

  /** The procedure's open block. */
  current(procedureId: string): CertificateBlock | undefined {
    return [...this.blocks.values()].find((b) => b.procedureId === procedureId);
  }

  /** Forgets a block that could not start (nothing used it): `stop` is not called. */
  drop(blockId: string): void {
    this.blocks.delete(blockId);
  }

  /** Marks one certificate operation of the procedure as started; call the result when it ends. */
  busy(procedureId: string): () => void {
    const a = this.activity.get(procedureId) ?? { busy: 0, last: 0 };
    this.activity.set(procedureId, a);
    a.busy++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      a.busy--;
      a.last = Date.now();
    };
  }

  /** The procedure's page asked AutoFirma for a certificate outside a block (refused). */
  refuse(procedureId: string): void {
    this.refused.add(procedureId);
  }

  /**
   * Why the agent's last action fails: its page asked for a certificate outside a block. `hosts`:
   * the hosts that asked for a TLS client certificate and got none.
   */
  refusal(procedureId: string, hosts: string[] = []): string | undefined {
    const afirma = this.refused.delete(procedureId);
    if (this.current(procedureId)) return undefined;
    if (hosts.length) {
      const origins = hosts.map((h) => `"https://${h}"`).join(', ');
      return `${hosts.join(', ')} asked for the user's certificate outside page.withCertificate, and none was presented. Click the button that opened it again inside page.withCertificate({ credentialId, origins: [${origins}] }, async () => { … }).`;
    }
    if (afirma)
      return "The page asked to sign or log in with the user's certificate (AutoFirma) outside page.withCertificate, and the app refused it. Click the same button again inside page.withCertificate({ credentialId }, async () => { … }).";
    return undefined;
  }

  /** Ends a block once its signatures and handshakes are over. False: no such block. */
  async close(blockId: string): Promise<boolean> {
    const block = this.blocks.get(blockId);
    if (!block) return false;
    block.closing ??= (async () => {
      await this.quiet(block.procedureId);
      this.blocks.delete(block.id);
      await this.stop(block);
    })();
    await block.closing;
    return true;
  }

  /** The run ended: closes the blocks it left open (its module was cancelled or crashed). */
  closeRun(runId: string): void {
    for (const block of this.blocks.values())
      if (block.runId === runId) void this.close(block.id).catch(() => {});
  }

  private async quiet(procedureId: string): Promise<void> {
    const since = Date.now();
    const deadline = since + MAX_WAIT_MS;
    for (;;) {
      const a = this.activity.get(procedureId);
      const quietSince = Math.max(since, a?.last ?? 0);
      if (!a?.busy && Date.now() - quietSince >= this.quietMs) return;
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
