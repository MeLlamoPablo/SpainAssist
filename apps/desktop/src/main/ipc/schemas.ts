import {
  Attachment,
  ByokInput,
  CredentialPolicy,
  CustomProviderInput,
  DniAccessNumber,
  DniePin,
  DocumentKind,
  PersonalDataInput,
  PHONE_CALL_MAX_WAV_BYTES,
  PromptResponse,
  RedeemVoucherRequest,
  type SaArgs,
  type SaMethod,
  SettingsPatch,
} from '@sa/shared';
import { z } from 'zod';

const id = z.string().min(1).max(200);
const none = z.tuple([]);
const bytes = (max: number) =>
  z.instanceof(Uint8Array).refine((b) => b.byteLength <= max, { message: 'File too large' });

const attachments = z.array(Attachment).max(20).optional();

/** zod schemas for the arguments of every renderer method (SaMethods). */
export const SA_ARG_SCHEMAS: { [M in SaMethod]: z.ZodType<SaArgs<M>> } = {
  'places.locateHome': z.tuple([
    z.object({
      street: z.string().trim().min(1).max(200),
      postalCode: z.string().trim().max(60).optional(),
      municipality: z.string().trim().min(1).max(60),
    }),
  ]),
  'places.pins': z.tuple([z.string().min(1).max(200), z.string().min(1).max(64)]),
  'app.info': none,
  'app.openExternal': z.tuple([z.string().url().max(2000)]),
  'app.reveal': none,
  'app.exportTranscripts': none,
  'updates.status': none,

  'settings.get': none,
  'settings.update': z.tuple([SettingsPatch]),

  'providers.status': none,
  'providers.loginChatGPT': none,
  'providers.loginCodexDevice': none,
  'providers.cancelLogin': none,
  'providers.redeemVoucher': z.tuple([RedeemVoucherRequest.shape.code]),
  'providers.setByok': z.tuple([ByokInput]),
  'providers.setCustom': z.tuple([CustomProviderInput]),
  'providers.listByok': none,
  'providers.listModels': none,
  'providers.setModel': z.tuple([z.string().trim().min(1).max(200)]),
  'providers.logout': none,

  'procedures.list': none,
  'procedures.get': z.tuple([id]),
  'procedures.log': z.tuple([id]),
  'procedures.rename': z.tuple([id, z.string().trim().min(1).max(160)]),
  'procedures.archive': z.tuple([id, z.boolean()]),
  'procedures.stop': z.tuple([id]),
  'procedures.delete': z.tuple([id]),
  'procedures.markRead': z.tuple([id]),

  'chat.transcript': none,
  'chat.state': none,
  'chat.send': z.tuple([z.object({ text: z.string().max(20_000), attachments })]),
  'chat.abort': none,
  'chat.respond': z.tuple([id, PromptResponse]),

  'vault.overview': none,
  'vault.setPersonal': z.tuple([z.array(PersonalDataInput).min(1).max(100)]),
  'vault.setPersonalPartial': z.tuple([z.array(PersonalDataInput).min(1).max(100)]),
  'vault.deletePersonal': z.tuple([z.array(z.string().min(1).max(100)).min(1).max(100)]),
  'vault.addDocument': z.tuple([
    z.object({
      name: z.string().trim().min(1).max(255),
      mimeType: z.string().min(1).max(200),
      kind: DocumentKind,
      bytes: bytes(50 * 1024 * 1024),
      procedureId: id.optional(),
      source: z.enum(['user', 'scan']).optional(),
    }),
  ]),
  'vault.deleteDocument': z.tuple([id]),
  'vault.openDocument': z.tuple([id]),
  'vault.downloadDocument': z.tuple([id]),
  'vault.previewDocument': z.tuple([id]),
  'vault.addClave': z.tuple([
    z.object({
      username: z.string().trim().min(1).max(64),
      password: z.string().min(1).max(256),
      label: z.string().trim().max(160).optional(),
    }),
  ]),
  'vault.addClaveMovil': none,
  'vault.addDnie': none,
  'vault.addCertificate': z.tuple([
    z.object({
      fileName: z.string().trim().min(1).max(255),
      bytes: bytes(1024 * 1024),
      passphrase: z.string().max(256),
      label: z.string().trim().max(160).optional(),
    }),
  ]),
  'vault.setCredentialPolicy': z.tuple([id, CredentialPolicy]),
  'vault.deleteCredential': z.tuple([id]),
  'vault.wipeAll': none,

  'phoneCall.transcriptionAvailable': none,
  'phoneCall.transcribe': z.tuple([id, z.object({ wav: bytes(PHONE_CALL_MAX_WAV_BYTES) })]),

  'companion.status': none,
  'companion.pair': none,
  'companion.unpair': none,
  'companion.unlock': z.tuple([
    id,
    z.strictObject({ can: DniAccessNumber.optional(), pin: DniePin.optional() }),
  ]),
  'media.get': z.tuple([id]),
  'browser.show': z.tuple([id]),
};
