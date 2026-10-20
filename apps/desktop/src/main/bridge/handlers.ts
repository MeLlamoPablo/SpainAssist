import {
  AGENT_HIDDEN_PERSONAL_KEYS,
  ASSISTANT_AGENT_ID,
  type BrowserObservation,
  type ConfirmPrompt,
  type CredentialPrompt,
  type CredentialSummary,
  credentialAllowedOn,
  type FormField,
  type FormPrompt,
  type Language,
  matchPersonalOption,
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
import type { Biometric, BrowserPort, PiiLib, VaultPort } from '../ports';
import type { ProcedureService } from '../procedures/service';
import type { ProviderManager } from '../providers/manager';
import { type FeedbackService, scrubOutgoing } from '../remote/feedback';
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
  /** Removes personal data from what agents send off the device (`research.scrub`). */
  pii: PiiLib;
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
 * PINs (the DNIe's is typed on the desktop and goes only to the phone).
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
 * Fields saved under a personal `select` key (sex, marital status) become a select with that
 * key's own options, so the answer is always a value the vault accepts. Lists too long for a
 * form (nationality) stay as the agent wrote them; the vault still matches labels on save.
 */
export function withPersonalOptions(fields: FormField[], lang: Language): FormField[] {
  const converted = new Map<string, NonNullable<ReturnType<typeof personalFieldDef>>>();
  const mapped = fields.map((field) => {
    const def = field.vaultKey ? personalFieldDef(field.vaultKey) : undefined;
    if (def?.input !== 'select' || !def.options || def.options.length > 50) return field;
    if (field.type !== 'text' && field.type !== 'select') return field;
    converted.set(field.key, def);
    const defaultValue = field.defaultValue && matchPersonalOption(def, field.defaultValue)?.value;
    const { defaultValue: _, ...rest } = field;
    return {
      ...rest,
      type: 'select' as const,
      options: def.options.map((o) => ({ value: o.value, label: o.label[lang] })),
      ...(defaultValue ? { defaultValue } : {}),
    };
  });
  return mapped.map((field) => {
    const def = field.visibleWhen && converted.get(field.visibleWhen.field);
    if (!def || !field.visibleWhen) return field;
    const values = field.visibleWhen.values.flatMap((v) => {
      const option = matchPersonalOption(def, v);
      return option ? [option.value] : [];
    });
    return values.length ? { ...field, visibleWhen: { ...field.visibleWhen, values } } : field;
  });
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
 * Why `origin` can never be offered as a certificate site, or null when the user may be asked.
 * Real sedes are public https hosts with a domain name.
 */
function certificateSiteBlock(origin: URL): string | null {
  if (origin.protocol !== 'https:') return 'it is not https';
  const host = origin.hostname.toLowerCase();
  if (host.startsWith('[') || /^[\d.]+$/.test(host)) return 'it is an IP address';
  if (
    !host.includes('.') ||
    host === 'localhost' ||
    /\.(localhost|local|internal|test)$/.test(host)
  )
    return 'it is not a public host';
  if (host.startsWith('xn--') || host.includes('.xn--')) return 'it has non-Latin characters';
  return null;
}

/**
 * Implementations of every host-bridge method (see @sa/shared bridge.ts). Each runs for the
 * procedure identified by the caller's token. Secrets never travel back to the agent.
 */
export function createBridgeHandlers(deps: BridgeHandlerDeps): BridgeHandlers {
  const lang = () => deps.lang();
  const approvals = new Map<string, number>();
  /** Per procedure: origins outside the official list where the user allowed certificate logins. */
  const certificateSites = new Map<string, Set<string>>();
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

  /**
   * Asks the user to allow certificate logins on a site outside the official list, for this
   * procedure only. The copy is the app's: the agent's text only appears as its summary.
   */
  async function confirmCertificateSite(
    ctx: BridgeContext,
    params: { message: string; site?: string; sources?: string[] },
  ): Promise<Extract<PromptResponse, { kind: 'confirm' }>> {
    const pid = ctx.procedureId;
    const url = new URL(params.site ?? '');
    const block = certificateSiteBlock(url);
    if (block)
      throw new BridgeError(
        'policy_denied',
        `The certificate can't be presented to ${url.host} (${block})`,
      );
    if (
      credentialAllowedOn('certificate', url.origin) ||
      certificateSites.get(pid)?.has(url.origin)
    )
      return { kind: 'confirm', approved: true };
    const response = await deps.prompts.ask(
      pid,
      {
        kind: 'confirm',
        confirmKind: 'certificate_site',
        title: t(lang(), 'certificateSiteTitle', { host: url.host }).slice(0, 160),
        message: [
          t(lang(), 'certificateSiteMessage', { host: url.host }),
          `**${t(lang(), 'certificateSiteChecked')}** ${params.message}`,
        ]
          .join('\n\n')
          .slice(0, 2000),
        details: [
          { label: t(lang(), 'detailWebsite'), value: url.origin.slice(0, 500) },
          ...(params.sources ?? []).map((source, i) => ({
            label: `${t(lang(), 'detailSource')} ${i + 1}`,
            value: source.slice(0, 500),
          })),
        ],
        confirmLabel: t(lang(), 'allowLabel'),
        rejectLabel: t(lang(), 'dontAllowLabel'),
      },
      { signal: ctx.signal },
    );
    if (response.kind !== 'confirm') throw new BridgeError('internal', 'Unexpected response.');
    if (response.approved) {
      const sites = certificateSites.get(pid) ?? new Set<string>();
      sites.add(url.origin);
      certificateSites.set(pid, sites);
    }
    return response;
  }

  /** A field of an official Cl@ve login page; the password only into a password input. */
  async function checkClaveField(pid: string, ref: string, field: 'username' | 'password') {
    const info = await browserCall((b) => b.describeRef(pid, ref));
    if (!info)
      throw new BridgeError(
        'not_found',
        'Element not found: take a new snapshot and use a fresh ref.',
      );
    if (!credentialAllowedOn('clave_permanente', info.frameUrl))
      throw new BridgeError(
        'policy_denied',
        `Cl@ve credentials can only be typed on official Cl@ve login pages over https. This field is on ${hostOf(info.frameUrl)}, which is not allowed.`,
      );
    if (field === 'password' && info.inputType !== 'password')
      throw new BridgeError('policy_denied', 'A password can only be typed into a password field.');
    if (field === 'username' && info.inputType === 'password')
      throw new BridgeError(
        'policy_denied',
        'The DNI/NIE goes into the username field, not the password field.',
      );
    return info;
  }

  /** The Cl@ve Permanente to log in with: the most recently used one. */
  function savedClave(): CredentialSummary | undefined {
    return deps
      .vault()
      .listCredentials()
      .filter((c) => c.kind === 'clave_permanente')
      .sort((a, b) => (b.lastUsedAt ?? b.createdAt).localeCompare(a.lastUsedAt ?? a.createdAt))[0];
  }

  /** Types one field of a saved Cl@ve Permanente, asking first when its policy says so. */
  async function fillCredential(
    ctx: BridgeContext,
    params: { ref: string; credentialId: string; field: 'username' | 'password'; submit: boolean },
  ): Promise<BrowserObservation> {
    const pid = ctx.procedureId;
    const vault = deps.vault();
    const credential = requireCredential(params.credentialId);
    const check = () => checkClaveField(pid, params.ref, params.field);
    const info = await check();
    if (credential.policy === 'ask') {
      const host = hostOf(info.frameUrl);
      await approveCredentialUse(
        ctx,
        `${pid}:${credential.id}:${host}`,
        {
          title: t(lang(), 'credentialTitle'),
          message: t(lang(), 'credentialMessage', { host }),
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
      const prompt: FormPrompt = {
        kind: 'form',
        ...params,
        fields: withPersonalOptions(params.fields, lang()),
      };
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
      const { site, sources, ...rest } = params;
      if (rest.confirmKind === 'certificate_site') return confirmCertificateSite(ctx, params);
      const prompt: ConfirmPrompt = { kind: 'confirm', ...rest };
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
      if (params.credential === 'clave_permanente')
        throw new BridgeError(
          'bad_request',
          'Log in with browser_login_clave: it asks the user for their Cl@ve Permanente when none is saved.',
        );
      if (!deps.dniePhone)
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
      refuseHiddenKey(params.key);
      const item = deps.vault().getPersonal(params.key);
      if (!item)
        throw new BridgeError('not_found', `No personal data saved under "${params.key}".`);
      return observe(ctx.procedureId, (b) =>
        b.type(ctx.procedureId, params.ref, item.value, { submit: params.submit }),
      );
    },
    'browser.loginClave': async (params, ctx) => {
      const pid = ctx.procedureId;
      // Check the page before asking the user anything.
      for (const [ref, field] of [
        [params.usernameRef, 'username'],
        [params.passwordRef, 'password'],
      ] as const)
        await checkClaveField(pid, ref, field);
      let credentialId = savedClave()?.id;
      if (!credentialId || params.rejected) {
        const replaceId = params.rejected ? credentialId : undefined;
        const prompt: CredentialPrompt = {
          kind: 'credential',
          credential: 'clave_permanente',
          title: t(lang(), replaceId ? 'claveRejectedTitle' : 'claveMissingTitle'),
          message: (
            params.message ?? t(lang(), replaceId ? 'claveRejectedMessage' : 'claveMissingMessage')
          ).slice(0, 2000),
          ...(replaceId ? { replaceId } : {}),
        };
        const response = await deps.prompts.ask(pid, prompt, { signal: ctx.signal });
        const added =
          response.kind === 'credential' && response.credentialId
            ? deps.vault().getCredential(response.credentialId)
            : undefined;
        if (added?.kind !== 'clave_permanente')
          throw new BridgeError(
            'user_rejected',
            replaceId
              ? 'The user did not correct their Cl@ve Permanente. Do not retry it: ask which other supported method they can use.'
              : 'The user has no Cl@ve Permanente. Ask which other supported method they can use.',
          );
        credentialId = added.id;
      }
      await fillCredential(ctx, {
        ref: params.usernameRef,
        credentialId,
        field: 'username',
        submit: false,
      });
      return fillCredential(ctx, {
        ref: params.passwordRef,
        credentialId,
        field: 'password',
        submit: true,
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
      // The Cl@ve Permanente password is never asked on its own: the app's form takes the DNI/NIE
      // and the password together, into the vault.
      if (info.inputType === 'password' && credentialAllowedOn('clave_permanente', info.frameUrl))
        throw new BridgeError(
          'policy_denied',
          "This is the Cl@ve Permanente password: never ask the user for it. Log in with browser_login_clave: it types the saved Cl@ve Permanente, or asks the user for it in the app's own form.",
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
        const allowed =
          credentialAllowedOn('certificate', url.origin) ||
          certificateSites.get(pid)?.has(url.origin);
        if (!allowed) {
          const block = certificateSiteBlock(url);
          throw new BridgeError(
            'policy_denied',
            block
              ? `The certificate can only be presented to official sites over https, and ${url.host} can't be one (${block})`
              : `${url.host} is not on the app's list of official sites. The user can allow it, but first triple-check that it really is the official sede of the administration this procedure needs: with your research tools, find at least 3 independent official sources (e.g. the administration's own website, its diputación or the administration directory at administracion.gob.es) that link to this exact host for this procedure. Watch for look-alike addresses. If it checks out, call confirm_action with confirmKind "certificate_site", site "${url.origin}", sources (those URLs) and a message summarising what you checked, then call browser_use_certificate again. If it doesn't check out, don't ask the user to allow it: tell them what you found`,
          );
        }
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

    // --- research ----------------------------------------------------------------------------
    'research.scrub': async (params, ctx) => {
      // Local rules depend on the municipality: the research tools ask for it instead of the
      // street address, so it stays.
      const result = scrubOutgoing(deps.pii, deps.vault(), params.text, ['addressMunicipality']);
      if (result.redactions > 0)
        deps.logger.info('research query scrubbed', {
          procedureId: ctx.procedureId,
          redactions: result.redactions,
        });
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
