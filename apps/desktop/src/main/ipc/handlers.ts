import type { AppInfo, MapPoint } from '@sa/shared';
import type { BrowserHolder } from '../browser/holder';
import type { ChatService } from '../chat/service';
import type { CompanionService } from '../companion/service';
import type { Coordinator } from '../conversation/coordinator';
import { UserError } from '../core/errors';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import { errorMessage } from '../core/util';
import type { MediaStore } from '../media/store';
import type { Maps } from '../places/maps';
import type { ProcedureService } from '../procedures/service';
import type { ProviderManager } from '../providers/manager';
import type { SettingsStore } from '../settings/store';
import type { Updates } from '../updates/updater';
import type { VaultService } from '../vault/service';
import type { IpcRouter } from './router';
import { SA_ARG_SCHEMAS as S } from './schemas';

export interface IpcServices {
  appInfo: AppInfo;
  settings: SettingsStore;
  providers: ProviderManager;
  procedures: ProcedureService;
  coordinator: Pick<Coordinator, 'stop'>;
  chat: ChatService;
  vault: VaultService;
  media: MediaStore;
  browser: BrowserHolder;
  /** DNIe with the phone; absent without the `dnie-phone` feature flag. */
  companion?: Pick<CompanionService, 'status' | 'pair' | 'unpair' | 'unlock'>;
  logger: Logger;
  /** Map lookups (Mapbox, via our maps server): pins only, never stored. */
  places: Pick<Maps, 'home'> & {
    /** Pins of a pending form's map field (kept in memory with the prompt). */
    pins(promptItemId: string, fieldKey: string): Promise<(MapPoint | null)[] | null>;
  };
  /** Call recordings of pending `phone_call` prompts (transcribed by main, never the renderer). */
  phoneCalls: {
    available(): Promise<boolean>;
    transcribe(promptItemId: string, wav: Uint8Array): Promise<string>;
  };
  /** The app's own updates. */
  updates: Pick<Updates, 'status'>;
  openExternal(url: string): Promise<void>;
  revealWindow(): void;
  /** Saves every stored transcript in a zip in Downloads; returns its file name. */
  exportTranscripts(): Promise<string>;
  deleteProcedure(id: string): Promise<void>;
  wipeAll(): Promise<void>;
}

/** Registers every SaMethods handler on the router. */
export function registerIpcHandlers(router: IpcRouter, s: IpcServices): void {
  const lang = () => s.settings.get().language;
  /** The flag is enforced here too, not only by the UI that hides the feature. */
  const companion = () => {
    if (!s.companion) throw new UserError(t(lang(), 'dniePhoneOff'), 'unavailable');
    return s.companion;
  };

  router.register('places.locateHome', S['places.locateHome'], (address) => s.places.home(address));
  router.register('places.pins', S['places.pins'], (itemId, fieldKey) =>
    s.places.pins(itemId, fieldKey),
  );
  router.register('app.info', S['app.info'], () => s.appInfo);
  router.register('app.openExternal', S['app.openExternal'], async (url) => {
    // https pages, and `tel:` links of phone-call prompts (the OS offers to call, e.g. FaceTime).
    if (!url.startsWith('https://') && !/^tel:\+?\d{3,15}$/.test(url))
      throw new UserError(t(lang(), 'onlyHttps'), 'bad_request');
    await s.openExternal(url);
  });
  router.register('app.reveal', S['app.reveal'], () => s.revealWindow());
  router.register('app.exportTranscripts', S['app.exportTranscripts'], () => s.exportTranscripts());
  router.register('updates.status', S['updates.status'], () => s.updates.status());

  router.register('settings.get', S['settings.get'], () => s.settings.get());
  router.register('settings.update', S['settings.update'], (patch) => s.settings.update(patch));

  router.register('providers.status', S['providers.status'], () => s.providers.currentStatus());
  router.register('providers.loginChatGPT', S['providers.loginChatGPT'], () =>
    s.providers.loginChatGPT(),
  );
  router.register('providers.loginCodexDevice', S['providers.loginCodexDevice'], () =>
    s.providers.loginCodexDevice(),
  );
  router.register('providers.cancelLogin', S['providers.cancelLogin'], () =>
    s.providers.cancelLogin(),
  );
  router.register('providers.redeemVoucher', S['providers.redeemVoucher'], (code) =>
    s.providers.redeemVoucher(code),
  );
  router.register('providers.setByok', S['providers.setByok'], (input) =>
    s.providers.setByok(input),
  );
  router.register('providers.setCustom', S['providers.setCustom'], (input) =>
    s.providers.setCustom(input),
  );
  router.register('providers.listByok', S['providers.listByok'], () => s.providers.listByok());
  router.register('providers.listModels', S['providers.listModels'], () =>
    s.providers.listModels(),
  );
  router.register('providers.setModel', S['providers.setModel'], (model) =>
    s.providers.setModel(model),
  );
  router.register('providers.logout', S['providers.logout'], () => s.providers.logout());

  router.register('procedures.list', S['procedures.list'], () => s.procedures.list());
  router.register('procedures.get', S['procedures.get'], (id) => s.procedures.get(id));
  router.register('procedures.log', S['procedures.log'], (id) =>
    structuredClone(s.procedures.transcript(id)),
  );
  router.register('procedures.rename', S['procedures.rename'], (id, title) =>
    s.procedures.rename(id, title),
  );
  router.register('procedures.archive', S['procedures.archive'], (id, archived) =>
    s.procedures.setArchived(id, archived),
  );
  router.register('procedures.stop', S['procedures.stop'], (id) => s.coordinator.stop(id));
  router.register('procedures.delete', S['procedures.delete'], (id) => s.deleteProcedure(id));
  router.register('procedures.markRead', S['procedures.markRead'], (id) =>
    s.procedures.markRead(id),
  );

  router.register('chat.transcript', S['chat.transcript'], () => s.chat.transcript());
  router.register('chat.state', S['chat.state'], () => s.chat.state());
  router.register('chat.send', S['chat.send'], (input) => s.chat.send(input));
  router.register('chat.abort', S['chat.abort'], () => s.chat.abort());
  router.register('chat.respond', S['chat.respond'], (itemId, response) =>
    s.chat.respond(itemId, response),
  );

  router.register('vault.overview', S['vault.overview'], () => s.vault.overview());
  router.register('vault.setPersonal', S['vault.setPersonal'], (items) =>
    s.vault.setPersonal(items),
  );
  router.register('vault.setPersonalPartial', S['vault.setPersonalPartial'], (items) =>
    s.vault.setPersonalPartial(items),
  );
  router.register('vault.deletePersonal', S['vault.deletePersonal'], (keys) =>
    s.vault.deletePersonal(keys),
  );
  router.register('vault.addDocument', S['vault.addDocument'], (input) => {
    if (input.procedureId && !s.procedures.has(input.procedureId)) {
      const { procedureId: _drop, ...rest } = input;
      return s.vault.addDocument(rest);
    }
    return s.vault.addDocument(input);
  });
  router.register('vault.deleteDocument', S['vault.deleteDocument'], (id) =>
    s.vault.deleteDocument(id),
  );
  router.register('vault.openDocument', S['vault.openDocument'], (id) => s.vault.openDocument(id));
  router.register('vault.downloadDocument', S['vault.downloadDocument'], (id) =>
    s.vault.downloadDocument(id),
  );
  router.register('vault.previewDocument', S['vault.previewDocument'], (id) =>
    s.vault.previewDocument(id),
  );
  router.register('vault.addClave', S['vault.addClave'], (input) => s.vault.addClave(input));
  router.register('vault.addClaveMovil', S['vault.addClaveMovil'], () => s.vault.addClaveMovil());
  router.register('vault.addDnie', S['vault.addDnie'], () => s.vault.addDnie());
  router.register('vault.addCertificate', S['vault.addCertificate'], (input) =>
    s.vault.addCertificate(input),
  );
  router.register('vault.setCredentialPolicy', S['vault.setCredentialPolicy'], (id, policy) =>
    s.vault.setCredentialPolicy(id, policy),
  );
  router.register('vault.deleteCredential', S['vault.deleteCredential'], (id) =>
    s.vault.deleteCredential(id),
  );
  router.register('vault.wipeAll', S['vault.wipeAll'], () => s.wipeAll());

  router.register('phoneCall.transcriptionAvailable', S['phoneCall.transcriptionAvailable'], () =>
    s.phoneCalls.available(),
  );
  router.register('phoneCall.transcribe', S['phoneCall.transcribe'], async (itemId, input) => ({
    text: await s.phoneCalls.transcribe(itemId, input.wav),
  }));

  router.register('companion.status', S['companion.status'], () => companion().status());
  router.register('companion.pair', S['companion.pair'], () => companion().pair());
  router.register('companion.unpair', S['companion.unpair'], () => companion().unpair());
  router.register('companion.unlock', S['companion.unlock'], (itemId, values) =>
    companion().unlock(itemId, values),
  );

  router.register('media.get', S['media.get'], (id) => s.media.dataUrl(id));
  router.register('browser.show', S['browser.show'], async (id) => {
    s.procedures.require(id);
    const browser = s.browser.current();
    if (!browser?.isOpen(id)) return;
    try {
      await s.browser.showForHelp(id);
    } catch (err) {
      s.logger.warn('browser.show failed', { error: errorMessage(err) });
    }
  });
}
