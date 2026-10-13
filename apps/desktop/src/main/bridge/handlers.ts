import {
  AGENT_HIDDEN_PERSONAL_KEYS,
  ASSISTANT_AGENT_ID,
  type BrowserObservation,
  type ConfirmPrompt,
  type CredentialPrompt,
  type CredentialSummary,
  credentialAllowedOn,
  type FormPrompt,
  type Language,
  type PersonalDataInput,
  PersonalFieldKey,
  type PersonalSaveIssue,
  type PhoneCallPrompt,
  type PromptResponse,
  personalFieldDef,
  type UserActionPrompt,
} from '@sa/shared';
import type { BrowserHolder } from '../browser/holder';
import { type PromptManager, redactResponse } from '../chat/prompts';
import type { Coordinator } from '../conversation/coordinator';
import type { ConversationService } from '../conversation/service';
import { BridgeError } from '../core/errors';
import type { EventBus } from '../core/events';
import { t } from '../core/i18n';
import { type Logger, truncate } from '../core/logger';
import { errorMessage, hostOf } from '../core/util';
import type { MediaStore } from '../media/store';
import { locateMapForm, type PlaceLookup, type PlaceResults } from '../places/resolve-form';
import type { Biometric, BrowserPort, VaultPort } from '../ports';
import type { ProcedureService } from '../procedures/service';
import type { ProviderManager } from '../providers/manager';
import type { FeedbackService } from '../remote/feedback';
import { setPersonalPartial } from '../vault/partial';
import type { BridgeContext, BridgeHandlers } from './server';

/** How long a map form that was not shown keeps its lookup results for a retry. */
const RETRY_PLACES_MS = 10 * 60_000;

/** Largest saved document `vault.document` sends to an agent (it travels base64 over the bridge). */
const MAX_READ_DOCUMENT_BYTES = 25 * 1024 * 1024;

export interface BridgeHandlerDeps {
  procedures: ProcedureService;
  conversation: ConversationService;
  coordinator: Pick<Coordinator, 'start' | 'message' | 'resume' | 'stop' | 'cancel'>;
  prompts: PromptManager;
  vault: () => VaultPort;
  browser: BrowserHolder;
  media: MediaStore;
  events: EventBus;
  providers: Pick<
    ProviderManager,
    'credentialFor' | 'refreshCredential' | 'exaKey' | 'voucherSpend'
  >;
  feedback: Pick<FeedbackService, 'search' | 'submit' | 'vote' | 'describeShared'>;
  biometric: Biometric;
  /** Origins that commonly ask for a TLS client certificate (from @sa/browser). */
  certificateOrigins: readonly string[];
  logger: Logger;
  lang: () => Language;
  placeLookup: PlaceLookup;
  /**
   * DNIe with the phone (`dnie-phone` feature flag). Off: agents never see a saved `dnie`
   * credential, and using one fails with an explanation.
   */
  dniePhone: boolean;
  /** How long an "ask before use" approval covers the same credential + site (default 2 min). */
  approvalTtlMs?: number;
}

function personalLabel(key: string, lang: Language, fallback?: string): string {
  return personalFieldDef(key)?.label[lang] ?? fallback ?? key.replace(/^custom\./, '');
}

/** Keys for a PIN ("pin", "custom.pin_dnie"): PINs are secrets, never personal data. */
const PIN_KEY = /(?:^|[._-])pin(?:$|[._-])/i;

/**
 * Agents never read, save, type or ask for these: the DNI CAN (it goes only to the phone) and
 * PINs (the DNIe's is typed on the desktop and goes only to the phone, D20).
 */
function hiddenFromAgents(key: string): boolean {
  return AGENT_HIDDEN_PERSONAL_KEYS.has(key) || PIN_KEY.test(key);
}

function refuseHiddenKey(key: string | undefined): void {
  if (!key || !hiddenFromAgents(key)) return;
  throw new BridgeError(
    'policy_denied',
    PIN_KEY.test(key)
      ? 'PINs are secrets, not personal data: agents never ask for, save or type them. A one-time PIN goes through browser_fill_from_user. The user saves the DNIe PIN in Mis datos (DNIe con el móvil), and only the paired phone gets it.'
      : `"${key}" is not available to agents.`,
  );
}

/**
 * Shared by live bridge requests and forms restored after an app restart. Saves what it can and
 * returns the rejected items, so the agent hears about them instead of a silent failure.
 */
export async function saveFormAnswers(
  deps: Pick<BridgeHandlerDeps, 'vault' | 'events' | 'conversation' | 'logger' | 'lang'>,
  owner: string,
  prompt: FormPrompt,
  response: Extract<PromptResponse, { kind: 'form' }>,
): Promise<PersonalSaveIssue[]> {
  const items: (PersonalDataInput & { label?: string })[] = [];
  for (const key of response.savedToVault) {
    const field = prompt.fields.find((f) => f.key === key);
    const value = response.values?.[key];
    if (!field?.vaultKey || typeof value !== 'string' || !value.trim()) continue;
    if (field.type === 'secret' || field.type === 'document') continue;
    if (!PersonalFieldKey.safeParse(field.vaultKey).success) continue;
    items.push({
      key: field.vaultKey,
      value: value.trim(),
      ...(field.vaultKey.startsWith('custom.') ? { label: field.label } : {}),
    });
  }
  if (!items.length) return [];
  try {
    const { saved, rejected } = await setPersonalPartial(deps.vault(), items, 'form', deps.logger);
    if (!saved.length) return rejected;
    deps.events.emit({ type: 'vault.changed' });
    const savedKeys = new Set(saved.map((item) => item.key));
    const labels = items
      .filter((item) => savedKeys.has(item.key))
      .map((item) => personalLabel(item.key, deps.lang(), item.label))
      .join(', ');
    deps.conversation.addNotice(
      'info',
      t(deps.lang(), 'savedToVault', { labels }),
      owner === ASSISTANT_AGENT_ID ? undefined : owner,
    );
    return rejected;
  } catch (err) {
    deps.logger.warn('could not save form answers', { error: errorMessage(err) });
    return items.map((item) => ({ key: item.key, reason: 'save_failed' }));
  }
}

/** Adds save failures to a form response; `savedToVault` keeps only what was really saved. */
export function withVaultErrors(
  prompt: FormPrompt,
  response: Extract<PromptResponse, { kind: 'form' }>,
  errors: PersonalSaveIssue[],
): Extract<PromptResponse, { kind: 'form' }> {
  const all = [...(response.vaultErrors ?? []), ...errors].slice(0, 50);
  if (!all.length) return response;
  const failed = new Set(errors.map((e) => e.key));
  return {
    ...response,
    savedToVault: response.savedToVault.filter((key) => {
      const vaultKey = prompt.fields.find((f) => f.key === key)?.vaultKey;
      return !vaultKey || !failed.has(vaultKey);
    }),
    vaultErrors: all,
  };
}

function isExpired(c: CredentialSummary): boolean {
  const validTo = c.certificate?.validTo;
  return !!validTo && Date.parse(validTo) < Date.now();
}

/**
 * Implementations of every host-bridge method (see @sa/shared bridge.ts). Each runs for the
 * procedure identified by the caller's token. Secrets never travel back to the agent.
 */
export function createBridgeHandlers(deps: BridgeHandlerDeps): BridgeHandlers {
  const lang = () => deps.lang();
  const approvals = new Map<string, number>();
  /**
   * Lookup results of each procedure's last map form that was not shown (an address not found,
   * the service down), so the retry only looks up the addresses that changed. Memory only, and
   * dropped by the next form: Mapbox results may not be stored.
   */
  const retryPlaces = new Map<string, { until: number; places: PlaceResults }>();

  async function browserCall<T>(fn: (b: BrowserPort) => Promise<T>): Promise<T> {
    try {
      return await fn(deps.browser.get());
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw new BridgeError('browser_error', truncate(errorMessage(err), 500));
    }
  }

  /** A browser action's observation, with news of the procedure's DNIe logins for the agent. */
  async function observe(
    procedureId: string,
    fn: (b: BrowserPort) => Promise<BrowserObservation>,
  ): Promise<BrowserObservation> {
    const observation = await browserCall(fn);
    const notes = deps.browser.loginNotes(procedureId);
    return notes.length ? { ...observation, notes: [...observation.notes, ...notes] } : observation;
  }

  function vaultChanged(): void {
    deps.events.emit({ type: 'vault.changed' });
  }

  /** "Guardado en Mis datos: …" in the conversation (whoever saved it). */
  function savedNotice(agentId: string, keys: { key: string; label?: string }[]): void {
    if (keys.length === 0) return;
    const labels = keys.map((k) => personalLabel(k.key, lang(), k.label)).join(', ');
    deps.conversation.addNotice(
      'info',
      t(lang(), 'savedToVault', { labels }),
      agentId === ASSISTANT_AGENT_ID ? undefined : agentId,
    );
  }

  /** A saved credential the agent may use (the DNIe only with its feature flag). */
  function requireCredential(id: string): CredentialSummary {
    const credential = deps.vault().getCredential(id);
    if (!credential)
      throw new BridgeError('not_found', 'No such credential. Call vault_read to list them.');
    if (credential.kind === 'dnie' && !deps.dniePhone)
      throw new BridgeError(
        'bad_request',
        'The DNIe through the phone is not available in this version of the app. Log in with Cl@ve or a digital certificate (.p12) instead, or tell the user which methods this site accepts.',
      );
    return credential;
  }

  function requireProcedure(id: string) {
    const procedure = deps.procedures.get(id);
    if (!procedure)
      throw new BridgeError('not_found', 'No such procedure. Call procedure_list to see them.');
    return procedure;
  }

  /**
   * In-app confirmation for credentials set to "ask", plus Touch ID when available and a
   * `touchIdReason` is given. The DNIe passes none: its phone approval and card are the second
   * factor.
   */
  async function approveCredentialUse(
    ctx: BridgeContext,
    cacheKey: string,
    prompt: Omit<ConfirmPrompt, 'kind' | 'confirmKind' | 'biometric'>,
    touchIdReason?: string,
  ): Promise<void> {
    const until = approvals.get(cacheKey);
    if (until && until > Date.now()) return;
    const response: PromptResponse = await deps.prompts.ask(
      ctx.procedureId,
      {
        kind: 'confirm',
        confirmKind: 'credential',
        ...prompt,
        confirmLabel: t(lang(), 'useLabel'),
        rejectLabel: t(lang(), 'dontUseLabel'),
        biometric: touchIdReason !== undefined && deps.biometric.available(),
      },
      { signal: ctx.signal },
    );
    if (response.kind !== 'confirm' || !response.approved)
      throw new BridgeError('user_rejected', 'The user did not allow using this credential.');
    if (touchIdReason !== undefined && !(await deps.biometric.prompt(touchIdReason)))
      throw new BridgeError('user_rejected', 'The user did not confirm with Touch ID.');
    approvals.set(cacheKey, Date.now() + (deps.approvalTtlMs ?? 120_000));
  }

  async function fillCredential(
    ctx: BridgeContext,
    params: { ref: string; credentialId: string; field: 'username' | 'password'; submit: boolean },
  ): Promise<BrowserObservation> {
    const pid = ctx.procedureId;
    const vault = deps.vault();
    const credential = requireCredential(params.credentialId);
    if (credential.kind === 'certificate')
      throw new BridgeError(
        'bad_request',
        'Certificates are not typed into pages: use browser_use_certificate.',
      );
    if (credential.kind === 'dnie')
      throw new BridgeError(
        'bad_request',
        "The DNIe and its PIN are never typed into pages: the DNIe works through the paired phone. To log in, call browser_use_certificate with this credential, then click the site's certificate (or DNIe) login button; the user approves on their phone and holds the card to it. To sign, nothing is needed: when the site asks for an AutoFirma signature, the app offers the DNIe and the user approves on their phone.",
      );
    if (credential.kind !== 'clave_permanente')
      throw new BridgeError(
        'bad_request',
        'Cl@ve Móvil has no stored secret: the user approves on their phone (use request_user_action).',
      );
    const check = async () => {
      const info = await browserCall((b) => b.describeRef(pid, params.ref));
      if (!info)
        throw new BridgeError(
          'not_found',
          'Element not found: take a new snapshot and use a fresh ref.',
        );
      if (!credentialAllowedOn(credential.kind, info.frameUrl))
        throw new BridgeError(
          'policy_denied',
          `Cl@ve credentials can only be typed on official Cl@ve login pages over https. This field is on ${hostOf(info.frameUrl)}, which is not allowed.`,
        );
      if (params.field === 'password' && info.inputType !== 'password')
        throw new BridgeError(
          'policy_denied',
          'A password can only be typed into a password field.',
        );
      return info;
    };
    const info = await check();
    if (credential.policy === 'ask') {
      const host = hostOf(info.frameUrl);
      await approveCredentialUse(
        ctx,
        `${pid}:${credential.id}:${host}`,
        {
          title: t(lang(), 'credentialTitle'),
          message: t(lang(), 'credentialMessage', {
            field: t(lang(), params.field === 'password' ? 'fieldPassword' : 'fieldUsername'),
            host,
          }),
          details: [
            { label: t(lang(), 'detailCredential'), value: credential.label },
            { label: t(lang(), 'detailWebsite'), value: host },
          ],
        },
        t(lang(), 'touchIdClave'),
      );
      await check(); // the page may have changed while the user was deciding
    }
    const secret = await vault.getCredentialSecret(credential.id);
    if (secret.kind !== 'clave_permanente')
      throw new BridgeError('internal', 'Unexpected credential type.');
    const value = params.field === 'password' ? secret.password : secret.username;
    deps.logger.addSecret(value);
    const observation = await observe(pid, (b) =>
      b.type(pid, params.ref, value, {
        submit: params.submit,
        secret: true,
        expect: {
          frameOrigin: new URL(info.frameUrl).origin,
          inputType: params.field === 'password' ? 'password' : info.inputType,
        },
      }),
    );
    await vault.markCredentialUsed(credential.id);
    vaultChanged();
    deps.logger.info('credential typed', { procedureId: pid, field: params.field });
    return observation;
  }

  return {
    // --- procedure ---------------------------------------------------------------------------
    'procedure.get': async (_params, ctx) =>
      structuredClone(deps.procedures.require(ctx.procedureId)),
    'procedure.update': async (params, ctx) =>
      structuredClone(deps.procedures.applyUpdate(ctx.procedureId, params)),

    // --- procedures (assistant) --------------------------------------------------------------
    'procedures.list': async (params) => ({
      procedures: deps.procedures.briefs(params.includeArchived),
    }),
    'procedures.read': async (params) => structuredClone(requireProcedure(params.procedureId)),
    'procedures.start': async (params) => {
      const procedure = await deps.coordinator.start(params.title, params.brief);
      return { procedureId: procedure.id, title: procedure.title };
    },
    'procedures.message': async (params) => {
      requireProcedure(params.procedureId);
      return { delivered: await deps.coordinator.message(params.procedureId, params.message) };
    },
    'procedures.respond': async (params) => {
      requireProcedure(params.procedureId);
      await deps.prompts.respondForProcedure(params.procedureId, params.promptId, params.values);
      return { answered: params.values !== undefined, dismissed: params.values === undefined };
    },
    'procedures.resume': async (params) => ({
      delivered: await deps.coordinator.resume(params.procedureId, params.message),
    }),
    'procedures.stop': async (params) => {
      requireProcedure(params.procedureId);
      await deps.coordinator.stop(params.procedureId);
      return { stopped: true };
    },
    'procedures.cancel': async (params) => {
      requireProcedure(params.procedureId);
      return { cancelled: await deps.coordinator.cancel(params.procedureId, params.reason) };
    },

    // --- prompts -----------------------------------------------------------------------------
    'prompt.form': async (params, ctx) => {
      for (const field of params.fields) {
        refuseHiddenKey(field.key);
        refuseHiddenKey(field.vaultKey);
      }
      const prompt: FormPrompt = { kind: 'form', ...params };
      const retry = retryPlaces.get(ctx.procedureId);
      retryPlaces.delete(ctx.procedureId);
      const places: PlaceResults = retry && retry.until > Date.now() ? retry.places : new Map();
      let mapPins: Awaited<ReturnType<typeof locateMapForm>>;
      try {
        mapPins = await locateMapForm(prompt, deps.placeLookup, ctx.signal, places);
      } catch (err) {
        if (places.size && !ctx.signal.aborted)
          retryPlaces.set(ctx.procedureId, { until: Date.now() + RETRY_PLACES_MS, places });
        throw err;
      }
      if ([...mapPins.values()].includes(null))
        deps.logger.info('map form shown without a map: lookups used up', {
          procedureId: ctx.procedureId,
        });
      const response = await deps.prompts.ask(ctx.procedureId, prompt, {
        signal: ctx.signal,
        mapPins,
      });
      if (response.kind !== 'form') throw new BridgeError('internal', 'Unexpected response.');
      const errors = await saveFormAnswers(deps, ctx.procedureId, prompt, response);
      return redactResponse(prompt, withVaultErrors(prompt, response, errors)) as typeof response;
    },

    'prompt.confirm': async (params, ctx) => {
      const prompt: ConfirmPrompt = { kind: 'confirm', ...params };
      const response = await deps.prompts.ask(ctx.procedureId, prompt, { signal: ctx.signal });
      if (response.kind !== 'confirm') throw new BridgeError('internal', 'Unexpected response.');
      return response;
    },

    'prompt.userAction': async (params, ctx) => {
      const pid = ctx.procedureId;
      const { attachScreenshot, ...rest } = params;
      const browser = deps.browser.current();
      let imageId: string | undefined;
      if (attachScreenshot && browser?.isOpen(pid)) {
        try {
          const shot = await browser.screenshot(pid);
          imageId = await deps.media.save(pid, shot.data, shot.mimeType);
        } catch (err) {
          deps.logger.warn('screenshot for user action failed', { error: errorMessage(err) });
        }
      }
      const prompt: UserActionPrompt = {
        kind: 'user_action',
        ...rest,
        showBrowser: rest.showBrowser && rest.actionKind !== 'offline' && !!browser?.isOpen(pid),
        ...(imageId ? { imageId } : {}),
      };
      const pending = deps.prompts.ask(pid, prompt, { signal: ctx.signal });
      try {
        const response = await pending;
        if (response.kind !== 'user_action')
          throw new BridgeError('internal', 'Unexpected response.');
        return response;
      } finally {
        await deps.browser
          .hideAfterHelp(pid)
          .catch((err) =>
            deps.logger.warn('could not hide the browser', { error: errorMessage(err) }),
          );
      }
    },

    'prompt.credential': async (params, ctx) => {
      if (params.credential === 'dnie' && !deps.dniePhone)
        throw new BridgeError('bad_request', 'The DNIe with the phone is not available.');
      const prompt: CredentialPrompt = { kind: 'credential', ...params };
      const response = await deps.prompts.ask(ctx.procedureId, prompt, { signal: ctx.signal });
      if (response.kind !== 'credential') throw new BridgeError('internal', 'Unexpected response.');
      const credential = response.credentialId
        ? deps.vault().getCredential(response.credentialId)
        : undefined;
      return credential?.kind === params.credential
        ? { kind: 'credential', credentialId: credential.id }
        : { kind: 'credential' };
    },

    'prompt.phoneCall': async (params, ctx) => {
      const prompt: PhoneCallPrompt = { kind: 'phone_call', ...params };
      const response = await deps.prompts.ask(ctx.procedureId, prompt, { signal: ctx.signal });
      if (response.kind !== 'phone_call') throw new BridgeError('internal', 'Unexpected response.');
      return response;
    },

    // --- vault -------------------------------------------------------------------------------
    'vault.read': async (params) => {
      const vault = deps.vault();
      const keys = params.keys ? new Set(params.keys) : undefined;
      return {
        personal: vault
          .listPersonal()
          .filter((p) => (!keys || keys.has(p.key)) && !hiddenFromAgents(p.key))
          .map((p) => ({ key: p.key, label: p.label, value: p.value })),
        documents: vault.listDocuments().map((d) => ({
          id: d.id,
          name: d.name,
          mimeType: d.mimeType,
          createdAt: d.createdAt,
        })),
        credentials: vault
          .listCredentials()
          .filter((c) => deps.dniePhone || c.kind !== 'dnie')
          .map((c) => ({
            id: c.id,
            kind: c.kind,
            label: c.label,
            policy: c.policy,
            ...(c.usernameHint ? { usernameHint: c.usernameHint } : {}),
            ...(c.certificate
              ? {
                  certificate: {
                    ...(c.certificate.holderName ? { holderName: c.certificate.holderName } : {}),
                    issuer: c.certificate.issuer,
                    validTo: c.certificate.validTo,
                  },
                }
              : {}),
          })),
      };
    },

    'vault.save': async (params, ctx) => {
      for (const item of params.items) refuseHiddenKey(item.key);
      const items = params.items.map((i) => ({
        ...i,
        ...(i.key.startsWith('custom.') && !i.label ? { label: i.key.slice(7) } : {}),
      }));
      try {
        await deps.vault().setPersonal(items, 'agent');
      } catch (err) {
        throw new BridgeError('bad_request', truncate(errorMessage(err), 300));
      }
      vaultChanged();
      savedNotice(ctx.procedureId, items);
      return { saved: items.map((i) => i.key) };
    },

    'vault.document': async (params) => {
      const vault = deps.vault();
      const meta = vault.getDocument(params.documentId);
      if (!meta) throw new BridgeError('not_found', `No document with id "${params.documentId}".`);
      if (meta.size > MAX_READ_DOCUMENT_BYTES)
        throw new BridgeError('bad_request', 'The document is too large to read (max 25 MB).');
      const bytes = await vault.readDocument(meta.id);
      return {
        id: meta.id,
        name: meta.name,
        mimeType: meta.mimeType,
        dataBase64: Buffer.from(bytes).toString('base64'),
      };
    },

    // --- downloads ---------------------------------------------------------------------------
    'downloads.save': async (params, ctx) => {
      let saved: { id: string; name: string } | undefined;
      try {
        saved = await deps.browser.saveDownload(ctx.procedureId, params.downloadId, params.name);
      } catch (err) {
        throw new BridgeError('bad_request', truncate(errorMessage(err), 300));
      }
      if (!saved)
        throw new BridgeError(
          'not_found',
          'No such download in this procedure (it may be saved already). Use a downloadId from a browser result.',
        );
      return { documentId: saved.id, name: saved.name };
    },

    // --- browser -----------------------------------------------------------------------------
    'browser.open': async (params, ctx) => {
      const protocol = new URL(params.url).protocol;
      if (protocol !== 'https:' && protocol !== 'http:')
        throw new BridgeError('policy_denied', 'Only http(s) pages can be opened.');
      return observe(ctx.procedureId, (b) =>
        b.open(ctx.procedureId, params.url, { newTab: params.newTab }),
      );
    },
    'browser.snapshot': async (_params, ctx) =>
      observe(ctx.procedureId, (b) => b.snapshot(ctx.procedureId)),
    'browser.click': async (params, ctx) =>
      observe(ctx.procedureId, (b) => b.click(ctx.procedureId, params.ref)),
    'browser.type': async (params, ctx) =>
      observe(ctx.procedureId, (b) =>
        b.type(ctx.procedureId, params.ref, params.text, { submit: params.submit }),
      ),
    'browser.fillFromVault': async (params, ctx) => {
      const { value } = params;
      if (value.source === 'personal') {
        refuseHiddenKey(value.key);
        const item = deps.vault().getPersonal(value.key);
        if (!item)
          throw new BridgeError('not_found', `No personal data saved under "${value.key}".`);
        return observe(ctx.procedureId, (b) =>
          b.type(ctx.procedureId, params.ref, item.value, { submit: params.submit }),
        );
      }
      return fillCredential(ctx, {
        ref: params.ref,
        credentialId: value.credentialId,
        field: value.field,
        submit: params.submit,
      });
    },
    'browser.fillFromUser': async (params, ctx) => {
      const pid = ctx.procedureId;
      const info = await browserCall((b) => b.describeRef(pid, params.ref));
      if (!info)
        throw new BridgeError(
          'not_found',
          'Element not found: take a new snapshot and use a fresh ref.',
        );
      const host = hostOf(info.frameUrl);
      const note = t(lang(), 'fillFromUserNote', { host });
      const message = params.message ? `${params.message}\n\n${note}` : note;
      const response = await deps.prompts.ask(
        pid,
        {
          kind: 'form',
          title: params.title,
          message: message.slice(0, 2000),
          fields: [{ key: 'value', label: params.label, type: 'secret', required: true }],
          allowDismiss: false,
        },
        { signal: ctx.signal },
      );
      // The transcript stores this response redacted (secret field); the value only goes to
      // the page.
      const value =
        response.kind === 'form' && !response.dismissed ? response.values?.value : undefined;
      if (typeof value !== 'string' || value.length === 0)
        throw new BridgeError('user_rejected', 'The user did not provide the value.');
      deps.logger.addSecret(value);
      return observe(pid, (b) =>
        b.type(pid, params.ref, value, {
          submit: params.submit,
          secret: true,
          expect: { frameOrigin: new URL(info.frameUrl).origin, inputType: info.inputType },
        }),
      );
    },
    'browser.select': async (params, ctx) =>
      observe(ctx.procedureId, (b) => b.select(ctx.procedureId, params.ref, params.values)),
    'browser.check': async (params, ctx) =>
      observe(ctx.procedureId, (b) => b.check(ctx.procedureId, params.ref, params.checked)),
    'browser.press': async (params, ctx) =>
      observe(ctx.procedureId, (b) => b.press(ctx.procedureId, params.key)),
    'browser.wait': async (params, ctx) =>
      observe(ctx.procedureId, (b) =>
        b.wait(ctx.procedureId, {
          ...(params.text !== undefined ? { text: params.text } : {}),
          ...(params.textGone !== undefined ? { textGone: params.textGone } : {}),
          ...(params.seconds !== undefined ? { seconds: params.seconds } : {}),
        }),
      ),
    'browser.back': async (_params, ctx) =>
      observe(ctx.procedureId, (b) => b.back(ctx.procedureId)),
    'browser.tabs': async (params, ctx) => ({
      tabs: await browserCall((b) => b.tabs(ctx.procedureId, params.action, params.index)),
    }),
    'browser.screenshot': async (params, ctx) => {
      const shot = await browserCall((b) =>
        b.screenshot(ctx.procedureId, { fullPage: params.fullPage }),
      );
      return { mimeType: shot.mimeType, dataBase64: shot.data.toString('base64') };
    },
    'browser.upload': async (params, ctx) => {
      const vault = deps.vault();
      const files: { name: string; mimeType: string; buffer: Buffer }[] = [];
      for (const id of params.documentIds) {
        const meta = vault.getDocument(id);
        if (!meta) throw new BridgeError('not_found', `No document with id "${id}".`);
        files.push({
          name: meta.name,
          mimeType: meta.mimeType,
          buffer: Buffer.from(await vault.readDocument(id)),
        });
      }
      return observe(ctx.procedureId, (b) => b.upload(ctx.procedureId, params.ref, files));
    },
    'browser.useCertificate': async (params, ctx) => {
      if (!deps.browser.certificateLoginsAvailable())
        throw new BridgeError(
          'browser_error',
          'Certificate logins are unavailable: sa-sidecar is missing or could not start. Use another login method or install the bundled helper.',
        );
      const pid = ctx.procedureId;
      const vault = deps.vault();
      const credential = requireCredential(params.credentialId);
      if (credential.kind !== 'certificate' && credential.kind !== 'dnie')
        throw new BridgeError('bad_request', 'This credential is not a digital certificate.');
      if (credential.kind === 'certificate' && isExpired(credential))
        throw new BridgeError(
          'bad_request',
          'This certificate has expired. Tell the user to renew it.',
        );
      const requested: string[] = [];
      for (const raw of params.origins ?? []) {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || !credentialAllowedOn('certificate', url.origin))
          throw new BridgeError(
            'policy_denied',
            `The certificate can only be presented to official sites over https (not ${url.host}).`,
          );
        requested.push(url.origin);
      }
      const origins = [...new Set([...deps.certificateOrigins, ...requested])];
      if (origins.length === 0)
        throw new BridgeError(
          'bad_request',
          'Pass the origin of the site that asks for the certificate.',
        );
      if (credential.policy === 'ask') {
        const websites = requested.length
          ? requested.map(hostOf).join(', ')
          : origins.map(hostOf).join(', ');
        await approveCredentialUse(
          ctx,
          `${pid}:${credential.id}:${origins.join(',')}`,
          {
            title: t(lang(), 'certificateTitle'),
            message: t(lang(), 'certificateMessage'),
            details: [
              {
                label: t(lang(), 'detailCertificate'),
                value: (credential.certificate?.holderName ?? credential.label).slice(0, 500),
              },
              { label: t(lang(), 'detailWebsites'), value: websites.slice(0, 500) },
            ],
          },
          credential.kind === 'dnie' ? undefined : t(lang(), 'touchIdCertificate'),
        );
      }
      await browserCall(async (b) => {
        const identity = await deps.browser.certificateIdentity(
          pid,
          credential,
          requested[0] ?? origins[0]!,
        );
        await b.useClientCertificate(pid, { origins, identity });
      });
      await vault.markCredentialUsed(credential.id);
      vaultChanged();
      return {
        enabled: true,
        origins,
        message:
          'Certificate enabled for these official sites. If a login was in progress, start it again from the site (e.g. its "Acceder" button).',
      };
    },
    'browser.close': async (_params, ctx) => {
      try {
        await deps.browser.close(ctx.procedureId);
      } catch (err) {
        throw new BridgeError('browser_error', truncate(errorMessage(err), 500));
      }
      return { closed: true };
    },

    // --- feedback --------------------------------------------------------------
    'feedback.search': async (params) => deps.feedback.search(params),
    'feedback.vote': async (params) => deps.feedback.vote(params),
    'feedback.submit': async (params, ctx) => {
      const { result, shared } = await deps.feedback.submit(params);
      if (shared)
        deps.procedures.addNotice(ctx.procedureId, 'info', deps.feedback.describeShared(shared));
      return result;
    },

    // --- agent host internals --------------------------------------------------------------
    'agent.credential': async (params) => ({
      credential: await deps.providers.credentialFor(params.providerId),
    }),
    'agent.refreshCredential': async (params) => {
      try {
        return { credential: await deps.providers.refreshCredential(params.providerId) };
      } catch (err) {
        deps.logger.warn('credential refresh failed', { error: errorMessage(err) });
        throw new BridgeError(
          'unavailable',
          'Could not refresh the sign-in. Ask the user to sign in again in Settings.',
        );
      }
    },
    'agent.exaKey': async () => ({ key: (await deps.providers.exaKey()) ?? null }),
    'agent.voucherSpend': async (params) => {
      deps.providers.voucherSpend(params);
      return {};
    },
  };
}
