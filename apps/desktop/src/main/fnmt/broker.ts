/**
 * The app's stand-in for FNMT's Configurador (docs/research/fnmt.md §7): answers the
 * `requestCert` and `installCert` calls the in-page shim (`@sa/signer`'s FNMT_SHIM_SOURCE)
 * forwards from FNMT's request and download pages.
 *
 * - requestCert: after the user approves, makes the key pair and the PKCS#10 as the Configurador
 *   does, keeps the private key in the vault (a pending certificate request, which must outlive
 *   the procedure and restarts: the identity check can take days) and gives the page the
 *   request, which the page sends to FNMT.
 * - installCert: finds the pending key for the certificate FNMT hands back, builds the path from
 *   the FNMT CAs the app ships, and after the user approves stores it as an ordinary certificate
 *   credential, then forgets the pending key.
 *
 * The private key never leaves the main process. Only FNMT's sedes may call it
 * (`certificateRequestAllowedOn`).
 */
import { createHash, X509Certificate } from 'node:crypto';
import {
  type ConfirmPrompt,
  certificateRequestAllowedOn,
  FNMT_ERROR,
  type FnmtCall,
  type FnmtReply,
  type Language,
} from '@sa/shared';
import {
  certificateInfo,
  createCertificateRequest,
  issuedCertificatePath,
  parseIssuedCertificates,
  publicKeyHash,
  requestKeySpec,
} from '@sa/signer';
import type { PromptManager } from '../chat/prompts';
import type { EventBus } from '../core/events';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import { errorMessage, hostOf } from '../core/util';
import type { VaultPort } from '../ports';
import type { ProcedureService } from '../procedures/service';
import { FNMT_AUTHORITIES } from './authorities';
import { type FnmtDebugLog, pem } from './debug-log';

export interface FnmtBrokerDeps {
  vault: () => VaultPort;
  prompts: Pick<PromptManager, 'ask'>;
  procedures: Pick<ProcedureService, 'has' | 'addNotice'>;
  events: EventBus;
  logger: Logger;
  lang: () => Language;
  /** TEMPORARY (`debug-log.ts`): everything, private keys included, for repairing a run. */
  debug?: FnmtDebugLog;
  /** FNMT's CAs, for the certificate path (default: the ones the app ships). */
  authorities?: readonly Uint8Array[];
}

const CANCELLED_REQUEST = 'Has cancelado la solicitud del certificado.';
const CANCELLED_INSTALL =
  'No has guardado el certificado. Puedes volver a descargarlo con el mismo código de solicitud.';
const KEY_NOT_FOUND =
  'No se encuentra en la app la clave de este certificado. Hay que descargarlo en el mismo equipo y con la misma app con la que se solicitó.';

function fail(errorType: string, errorMessage: string): FnmtReply {
  return { ok: false, errorType, errorMessage };
}

export class FnmtBroker {
  constructor(private readonly deps: FnmtBrokerDeps) {}

  /** The browser's `fnmt.handler`. Never throws: every failure is an FnmtReply. */
  readonly handle = async (call: FnmtCall, procedureId: string): Promise<FnmtReply> => {
    const debug = this.debug(procedureId);
    debug('call', { call });
    let reply: FnmtReply;
    try {
      if (!certificateRequestAllowedOn(call.url)) {
        this.deps.logger.warn('FNMT call from a page that is not FNMT', {
          procedureId,
          host: hostOf(call.url),
        });
        reply = fail(FNMT_ERROR.generic, 'Esta página no puede solicitar certificados a la app.');
      } else if (!this.deps.procedures.has(procedureId)) {
        reply = fail(FNMT_ERROR.cancelled, 'El trámite ya no existe.');
      } else if (call.method === 'requestCert') {
        reply = await this.request(call, procedureId);
      } else if (call.method === 'installCert') {
        reply = await this.install(call, procedureId);
      } else {
        reply = fail('java.lang.UnsupportedOperationException', 'Operación no admitida');
      }
    } catch (err) {
      this.deps.logger.error('FNMT call failed', {
        procedureId,
        method: call.method,
        error: errorMessage(err),
      });
      debug('error', { error: err });
      reply = fail(FNMT_ERROR.generic, 'Se ha producido un error en la app.');
    }
    debug('reply', { reply });
    return reply;
  };

  private async request(call: FnmtCall, procedureId: string): Promise<FnmtReply> {
    const { deps } = this;
    const debug = this.debug(procedureId);
    const lang = deps.lang();
    const host = hostOf(call.url);
    if (call.args[3] === true) {
      return fail(
        FNMT_ERROR.cardNotSupported,
        'Esta solicitud exige generar las claves en una tarjeta criptográfica, y la app no las admite.',
      );
    }
    const spec = requestKeySpec(call.args[0], call.args[1]);
    const keyLabel = spec.type === 'ec' ? 'EC P-256' : `RSA ${spec.bits}`;
    const approved = await this.confirm(procedureId, {
      kind: 'confirm',
      confirmKind: 'credential',
      title: t(lang, 'certificateRequestTitle'),
      message: t(lang, 'certificateRequestMessage', { host }),
      details: [
        { label: t(lang, 'detailFor'), value: host },
        { label: t(lang, 'detailKey'), value: keyLabel },
      ],
      confirmLabel: t(lang, 'requestLabel'),
      rejectLabel: t(lang, 'dontRequestLabel'),
    });
    debug('consent', { method: 'requestCert', approved, spec });
    if (!approved) return fail(FNMT_ERROR.cancelled, CANCELLED_REQUEST);

    const request = createCertificateRequest(spec);
    const pkcs8 = request.privateKey.export({ type: 'pkcs8', format: 'der' });
    debug('key', {
      keyDescription: request.keyDescription,
      publicKeyHash: request.publicKeyHash,
      privateKeyPem: pem(pkcs8, 'PRIVATE KEY'),
      publicKeyPem: pem(request.publicKey, 'PUBLIC KEY'),
      pkcs10: request.pkcs10.toString('base64'),
      pkcs10Pem: pem(request.pkcs10, 'CERTIFICATE REQUEST'),
    });
    // The key is in the vault before the page gets the request: a request FNMT accepted is
    // worthless without it.
    const pending = await deps.vault().addCertificateRequest({
      publicKeyHash: request.publicKeyHash,
      privateKey: pkcs8,
      keyDescription: request.keyDescription,
      origin: call.origin,
      procedureId,
    });
    debug('pending', { pending });
    deps.logger.info('FNMT certificate request created', {
      procedureId,
      host,
      key: request.keyDescription,
      requestId: pending.id,
    });
    deps.events.emit({ type: 'vault.changed' });
    deps.procedures.addNotice(procedureId, 'success', t(lang, 'certificateRequested'));
    return { ok: true, result: request.pkcs10.toString('base64') };
  }

  private async install(call: FnmtCall, procedureId: string): Promise<FnmtReply> {
    const { deps } = this;
    const debug = this.debug(procedureId);
    const lang = deps.lang();
    const host = hostOf(call.url);
    const data = call.args[0];
    if (typeof data !== 'string' || !data) {
      return fail('java.lang.IllegalArgumentException', 'No se ha recibido el certificado');
    }
    let certificates: Buffer[];
    try {
      certificates = parseIssuedCertificates(data);
    } catch (err) {
      debug('error', { step: 'parse', error: err });
      return fail(FNMT_ERROR.generic, 'No se ha podido leer el certificado que envía la página.');
    }
    const parsed = certificates.map((der) => {
      const cert = new X509Certificate(der);
      const spki = cert.publicKey.export({ type: 'spki', format: 'der' });
      return { der, cert, hash: publicKeyHash(spki) };
    });
    debug('certificates', {
      certificates: parsed.map(({ der, cert, hash }) => ({
        subject: cert.subject,
        issuer: cert.issuer,
        serialNumber: cert.serialNumber,
        validFrom: cert.validFrom,
        validTo: cert.validTo,
        ca: cert.ca,
        publicKeyHash: hash,
        sha256: createHash('sha256').update(der).digest('hex'),
        pem: pem(der, 'CERTIFICATE'),
      })),
    });

    const vault = deps.vault();
    let match: { leaf: (typeof parsed)[number]; requestId: string } | undefined;
    for (const p of parsed) {
      const pending = vault.findCertificateRequest(p.hash);
      if (pending) {
        match = { leaf: p, requestId: pending.id };
        break;
      }
    }
    if (!match) {
      // The page may install the same certificate twice (a reload): the first one stored it.
      const fingerprints = new Set(
        parsed.map((p) => createHash('sha256').update(p.der).digest('hex')),
      );
      const stored = vault
        .listCredentials()
        .find(
          (c) => c.kind === 'certificate' && fingerprints.has(c.certificate?.fingerprint ?? ''),
        );
      debug('no_pending_key', {
        pending: vault.listCertificateRequests(),
        alreadyStored: stored?.id ?? null,
      });
      if (stored) return { ok: true };
      return fail(FNMT_ERROR.keyNotFound, KEY_NOT_FOUND);
    }

    const path = issuedCertificatePath(
      match.leaf.der,
      certificates,
      deps.authorities ?? FNMT_AUTHORITIES,
    );
    debug('path', {
      requestId: match.requestId,
      path: path.map((der) => new X509Certificate(der).subject),
    });
    const info = certificateInfo(match.leaf.der);
    const approved = await this.confirm(procedureId, {
      kind: 'confirm',
      confirmKind: 'credential',
      title: t(lang, 'certificateInstallTitle'),
      message: t(lang, 'certificateInstallMessage', { host }),
      details: [
        { label: t(lang, 'detailHolder'), value: (info.holderName ?? info.subject).slice(0, 500) },
        { label: t(lang, 'detailIssuer'), value: info.issuer.slice(0, 500) },
        { label: t(lang, 'detailValidTo'), value: info.validTo.slice(0, 10) },
      ],
      confirmLabel: t(lang, 'saveLabel'),
      rejectLabel: t(lang, 'dontSaveLabel'),
    });
    debug('consent', { method: 'installCert', approved });
    // Declining keeps the pending key: the user can download the certificate again later.
    if (!approved) return fail(FNMT_ERROR.cancelled, CANCELLED_INSTALL);

    const key = await vault.getCertificateRequestKey(match.requestId);
    const credential = await vault.addCertificateFromKey({
      privateKey: key,
      certificates: path,
      fileName: 'FNMT',
    });
    debug('credential', { credential });
    await vault.deleteCertificateRequest(match.requestId);
    deps.logger.info('FNMT certificate installed', {
      procedureId,
      host,
      credentialId: credential.id,
      path: path.length,
    });
    deps.events.emit({ type: 'vault.changed' });
    deps.procedures.addNotice(
      procedureId,
      'success',
      t(lang, 'certificateInstalled', { label: credential.label }),
    );
    return { ok: true };
  }

  /** The user's answer; a prompt cancelled with its procedure (or the app quitting) is a no. */
  private async confirm(procedureId: string, prompt: ConfirmPrompt): Promise<boolean> {
    try {
      const answer = await this.deps.prompts.ask(procedureId, prompt);
      return answer.kind === 'confirm' && answer.approved;
    } catch (err) {
      this.deps.logger.info('FNMT prompt not answered', { procedureId, error: errorMessage(err) });
      return false;
    }
  }

  /** TEMPORARY: writes to the debug log without ever waiting for it or failing. */
  private debug(procedureId: string): (event: string, data: Record<string, unknown>) => void {
    return (event, data) => {
      void this.deps.debug?.write(event, { procedureId, ...data });
    };
  }
}
