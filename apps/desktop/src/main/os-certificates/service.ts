/**
 * External certificates: FNMT certificates installed in the operating system (macOS keychain),
 * which the app finds by itself and uses without ever holding their keys. Finding them is silent
 * and needs no consent: nothing is used until the user approves a login or a signature, as with
 * a certificate in the vault. A login signs through the sidecar's remote-key calls and a
 * document through `ExternalSigningKey`, the paths the DNIe in the phone already uses.
 */
import { constants, createHash, publicDecrypt, randomBytes, X509Certificate } from 'node:crypto';
import type {
  CertificateInfo,
  CredentialSummary,
  ExternalSigningKey,
  SignatureDigest,
} from '@sa/shared';
import { SidecarError, type SidecarHash, type SidecarIdentity } from '@sa/sidecar';
import type { Logger } from '../core/logger';
import { errorMessage } from '../core/util';
import { type OsKeyStore, OsKeyStoreError } from './store';

const ID_PREFIX = 'os-';

const TLS_DIGESTS: Record<SidecarHash, SignatureDigest> = {
  'SHA-1': 'sha1',
  'SHA-256': 'sha256',
  'SHA-384': 'sha384',
  'SHA-512': 'sha512',
};

/** Whether a credential id names an external certificate (never a vault credential). */
export function isOsCredentialId(id: string): boolean {
  return id.startsWith(ID_PREFIX);
}

interface OsCertificate {
  id: string;
  der: Buffer;
  /** Leaf, then its issuing CA. */
  chain: Buffer[];
  info: CertificateInfo;
}

export interface OsCertificatesDeps {
  store: OsKeyStore;
  /** DER of the CAs whose certificates the app looks for: FNMT's, issuing CAs and roots. */
  authorities: readonly Uint8Array[];
  certificateInfo(der: Uint8Array): CertificateInfo;
  logger: Logger;
  now?: () => number;
}

export class OsCertificates {
  private found: OsCertificate[] = [];
  private readonly authorities: { der: Buffer; x509: X509Certificate; subject: string }[];
  /** Certificates whose key the OS already let the app use in this run, by id. */
  private readonly authorized = new Map<string, Promise<void>>();
  private refreshing?: Promise<boolean>;

  constructor(private readonly deps: OsCertificatesDeps) {
    this.authorities = deps.authorities.map((der) => ({
      der: Buffer.from(der),
      x509: new X509Certificate(der),
      subject: deps.certificateInfo(der).subject,
    }));
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * What makes a certificate one the app links: issued by one of the authorities (signature
   * checked), for a person (not a CA) and with an RSA key, the only kind the remote-key paths
   * sign with.
   */
  private issuerOf(der: Uint8Array): Buffer | undefined {
    try {
      const cert = new X509Certificate(der);
      if (cert.ca || cert.publicKey.asymmetricKeyType !== 'rsa') return undefined;
      return this.authorities.find(
        (ca) => cert.checkIssued(ca.x509) && cert.verify(ca.x509.publicKey),
      )?.der;
    } catch {
      return undefined;
    }
  }

  /** Whether the app would find this certificate (DER) once it is in the OS store. */
  eligible(der: Uint8Array): boolean {
    return this.issuerOf(der) !== undefined;
  }

  /** Whether a vault certificate looks movable: in date and from one of the authorities. */
  movable(info: CertificateInfo): boolean {
    return (
      Date.parse(info.validTo) > this.now() &&
      this.authorities.some((ca) => ca.subject === info.issuer)
    );
  }

  /**
   * Reads the OS store again. Resolves true when the certificates changed. Never throws: a
   * store that can't be read keeps the last list.
   */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.read().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async read(): Promise<boolean> {
    let ders: Buffer[];
    try {
      ders = await this.deps.store.list();
    } catch (err) {
      this.deps.logger.warn('OS certificates could not be listed', { error: errorMessage(err) });
      return false;
    }
    const found = new Map<string, OsCertificate>();
    for (const der of ders) {
      const issuer = this.issuerOf(der);
      if (!issuer) continue;
      const info = this.deps.certificateInfo(der);
      const id = `${ID_PREFIX}${info.fingerprint}`;
      found.set(id, { id, der, chain: [der, issuer], info });
    }
    const before = this.found.map((c) => c.id).join();
    this.found = [...found.values()];
    for (const id of this.authorized.keys()) if (!found.has(id)) this.authorized.delete(id);
    return before !== this.found.map((c) => c.id).join();
  }

  /** The certificates found, without the expired ones: the user can't remove those here. */
  list(): CredentialSummary[] {
    const now = this.now();
    return this.found
      .filter((c) => Date.parse(c.info.validTo) > now)
      .map((c) => ({
        id: c.id,
        kind: 'certificate',
        label: c.info.holderName ? `Certificado de ${c.info.holderName}` : 'Certificado digital',
        // Use is the consent: the app never asked before listing it.
        policy: 'ask',
        createdAt: c.info.validFrom,
        certificate: c.info,
        external: true,
      }));
  }

  private require(id: string): OsCertificate {
    const certificate = this.found.find((c) => c.id === id);
    if (!certificate)
      throw new OsKeyStoreError('not_found', 'The certificate is no longer in the system');
    return certificate;
  }

  private async sign(id: string, digest: Uint8Array, hash: SignatureDigest): Promise<Buffer> {
    const { der } = this.require(id);
    try {
      return await this.deps.store.sign(der, digest, hash);
    } catch (err) {
      const code = err instanceof OsKeyStoreError ? err.code : 'failed';
      this.deps.logger.warn('OS certificate signature failed', {
        code,
        status: err instanceof OsKeyStoreError ? err.status : undefined,
      });
      if (code === 'not_found') void this.refresh();
      throw err;
    }
  }

  /**
   * Makes the OS ask now, if it is going to (macOS: "Spain Assist quiere firmar con la clave…"),
   * by signing a random digest that is thrown away. Later signatures then answer at once.
   */
  private authorize(id: string): Promise<void> {
    let pending = this.authorized.get(id);
    if (!pending) {
      pending = this.sign(id, randomBytes(32), 'sha256').then(
        () => {},
        (err) => {
          this.authorized.delete(id);
          throw err;
        },
      );
      this.authorized.set(id, pending);
    }
    return pending;
  }

  /** The identity of a certificate login: the sidecar asks here for each handshake signature. */
  sidecarIdentity(id: string): SidecarIdentity {
    const { chain } = this.require(id);
    return {
      id,
      chain,
      // The key is on this machine: no need for the DNIe's two connections per host.
      maxConns: 6,
      key: {
        prepare: async () => {
          try {
            await this.authorize(id);
          } catch (err) {
            throw new SidecarError(
              err instanceof OsKeyStoreError && err.code === 'denied' ? 'declined' : 'unavailable',
              errorMessage(err),
            );
          }
        },
        sign: async (digest, hash) => {
          try {
            return await this.sign(id, digest, TLS_DIGESTS[hash]);
          } catch (err) {
            throw new SidecarError('declined', errorMessage(err));
          }
        },
      },
    };
  }

  /** The key of one signature operation (AutoFirma replacement). */
  signingKey(id: string): ExternalSigningKey {
    const { chain } = this.require(id);
    return {
      kind: 'external',
      credentialId: id,
      certificates: chain,
      sign: (data, digest) => this.sign(id, createHash(digest).update(data).digest(), digest),
      release: () => {},
    };
  }

  /**
   * Adds a certificate the app holds (`p12`: 3DES, SHA-1 MAC) to the OS store, and resolves only
   * once the app has found it there and signed with it: after that the app's own copy can go.
   */
  async install(p12: Uint8Array, passphrase: string, der: Uint8Array): Promise<void> {
    if (!this.eligible(der))
      throw new OsKeyStoreError('failed', 'The app would not find this certificate in the system');
    await this.deps.store.importPkcs12(p12, passphrase);
    await this.refresh();
    const id = `${ID_PREFIX}${this.deps.certificateInfo(der).fingerprint}`;
    const digest = randomBytes(32);
    const signature = await this.sign(id, digest, 'sha256');
    // What a PKCS#1 v1.5 signature over a SHA-256 digest holds, as a TLS server would check it.
    const signed = publicDecrypt(
      { key: new X509Certificate(der).publicKey, padding: constants.RSA_PKCS1_PADDING },
      signature,
    );
    const valid = signed.equals(Buffer.concat([SHA256_DIGEST_INFO, digest]));
    if (!valid) throw new OsKeyStoreError('failed', 'The system signed with a different key');
    this.authorized.set(id, Promise.resolve());
  }
}

/** DER prefix of a PKCS#1 v1.5 `DigestInfo` for SHA-256 (RFC 8017 §9.2). */
const SHA256_DIGEST_INFO = Buffer.from('3031300d060960864801650304020105000420', 'hex');
