import { AGENT_PERSONAL_FIELD_KEYS, PERSONAL_FIELDS, type VaultReadResult } from '@sa/shared';
import { Type } from 'typebox';
import type { BridgeTransport } from '../bridge/client';
import { callBridge, compact, defineSaTool, errorResult, textResult } from './common';

/** Well-known keys with a short fixed list of values, e.g. "maritalStatus: single | married…". */
export const PERSONAL_CHOICES = PERSONAL_FIELDS.filter(
  (f) =>
    f.input === 'select' &&
    f.options &&
    f.options.length <= 10 &&
    AGENT_PERSONAL_FIELD_KEYS.includes(f.key),
)
  .map((f) => `${f.key}: ${f.options?.map((o) => o.value).join(' | ')}`)
  .join('; ');

const KEY_PATTERN = '^([a-zA-Z][a-zA-Z0-9]*|custom\\.[a-z0-9][a-z0-9_-]{0,48})$';

export const VaultReadParams = Type.Object({
  keys: Type.Optional(
    Type.Array(Type.String({ maxLength: 80 }), {
      maxItems: 50,
      description: 'Only these personal-data keys (default: everything)',
    }),
  ),
});

export const VaultSaveParams = Type.Object({
  items: Type.Array(
    Type.Object({
      key: Type.String({
        pattern: KEY_PATTERN,
        description: 'A well-known key (the same list as ask_user vaultKey) or custom.<slug>',
      }),
      value: Type.String({
        maxLength: 2000,
        description: `These keys take exactly one of their values: ${PERSONAL_CHOICES}`,
      }),
      label: Type.Optional(
        Type.String({ maxLength: 160, description: 'Required for custom.<slug> keys' }),
      ),
    }),
    { minItems: 1, maxItems: 30 },
  ),
});

export function renderVault(result: VaultReadResult): string {
  const lines: string[] = [];
  if (result.personal.length > 0) {
    lines.push(`Personal data (${result.personal.length}):`);
    for (const item of result.personal) lines.push(`- ${item.key} (${item.label}): ${item.value}`);
  } else {
    lines.push('Personal data: none saved.');
  }
  if (result.documents.length > 0) {
    lines.push(`Documents (${result.documents.length}):`);
    for (const doc of result.documents) {
      lines.push(`- ${doc.id}: ${doc.name} (${doc.mimeType}, ${doc.createdAt.slice(0, 10)})`);
    }
  } else {
    lines.push('Documents: none.');
  }
  if (result.credentials.length > 0) {
    lines.push(`Credentials (${result.credentials.length}; secrets are never shown):`);
    for (const cred of result.credentials) {
      const parts = [`- ${cred.id}: ${cred.kind} "${cred.label}"`, `policy ${cred.policy}`];
      if (cred.usernameHint) parts.push(`user ${cred.usernameHint}`);
      if (cred.certificate) {
        const c = cred.certificate;
        parts.push(
          `certificate${c.holderName ? ` of ${c.holderName}` : ''}, issuer ${c.issuer}, valid to ${c.validTo.slice(0, 10)}`,
        );
      }
      lines.push(parts.join(', '));
    }
  } else {
    lines.push('Credentials: none saved.');
  }
  return lines.join('\n');
}

export function vaultTools(bridge: BridgeTransport) {
  return [
    defineSaTool({
      name: 'vault_read',
      label: 'Read my data',
      description:
        "Read the user's saved personal data (with values), their saved documents (ids, names) and credentials (Cl@ve, certificates: summaries only, never secrets). Read current data before constructing a form, including on resumed runs. Reuse saved values; if a filtered read misses needed data, read without keys and inspect relevant labels/custom fields before asking.",
      parameters: VaultReadParams,
      async execute(_id, params, signal) {
        return callBridge(bridge, 'vault.read', compact({ keys: params.keys }), signal, (result) =>
          textResult(renderVault(result), {
            personal: result.personal.length,
            documents: result.documents.length,
            credentials: result.credentials.length,
          }),
        );
      },
    }),

    defineSaTool({
      name: 'vault_save',
      label: 'Save my data',
      description:
        'Save personal data the user gave you (in chat or documents) to their data, for future procedures. Use well-known keys when possible. Identity fields describe the person; document fields use their document prefix (dni*, tie*, passport*, drivingLicence*), e.g. dniNumber, dniIssuingTeam, tieExpiry, passportIssuingAuthority, drivingLicenceExpiry. drivingLicenceCategories is a JSON list of {category, issueDate?, expiry?}. A driving licence number is the DNI/NIE of its holder: save it as dniNumber or tieNumber. Keep documents separate. Never save passwords, PINs or codes.',
      parameters: VaultSaveParams,
      async execute(_id, params, signal) {
        const missingLabel = params.items.find((i) => i.key.startsWith('custom.') && !i.label);
        if (missingLabel) {
          return errorResult(`Give a label for the custom key "${missingLabel.key}".`);
        }
        return callBridge(
          bridge,
          'vault.save',
          { items: params.items.map((item) => compact({ ...item })) },
          signal,
          (result) =>
            textResult(
              result.saved.length > 0 ? `Saved: ${result.saved.join(', ')}.` : 'Nothing was saved.',
              { saved: result.saved },
            ),
        );
      },
    }),
  ];
}
