import type { BrowserObservation, VaultValueRef } from '@sa/shared';
import { Type } from 'typebox';
import type { BridgeTransport } from '../bridge/client';
import {
  callBridge,
  clip,
  compact,
  defineSaTool,
  errorResult,
  StringEnum,
  type ToolResult,
  textResult,
} from './common';

const MAX_SNAPSHOT_CHARS = 60_000;

const Ref = Type.String({
  minLength: 1,
  maxLength: 32,
  description: 'Element ref from the latest snapshot, e.g. "e12"',
});
const Element = Type.Optional(
  Type.String({ maxLength: 200, description: 'What the element is, e.g. "Botón Entrar"' }),
);
const Submit = Type.Optional(Type.Boolean({ description: 'Press Enter after typing' }));

const SNAPSHOT_HEADING = 'Page snapshot';

/**
 * Compact, model-facing rendering of a browser observation (never includes images). `redacted`:
 * the snapshot leaves the context after the next browser action (see host/redaction.ts).
 */
export function renderObservation(obs: BrowserObservation, redacted: boolean): string {
  const lines = [`URL: ${obs.url}`, `Title: ${obs.title || '(none)'}`];
  const tabs = obs.tabs ?? [];
  if (tabs.length > 1) {
    lines.push(
      `Tabs: ${tabs.map((t) => `[${t.index}]${t.active ? ' (active)' : ''} ${clip(t.title, 60)} — ${t.url}`).join(' | ')}`,
    );
  }
  if (obs.downloads?.length) {
    lines.push(
      `Downloads (temporary, not in the user's documents; keep what the user needs with download_save): ${obs.downloads.map((d) => `${d.name} (${d.mimeType}, downloadId ${d.downloadId})`).join('; ')}`,
    );
  }
  if (obs.signatures?.length) {
    lines.push(
      `Signatures: ${obs.signatures.map((s) => `${s.status} ${s.format} for ${s.origin}${s.message ? ` (${s.message})` : ''}`).join('; ')}`,
    );
  }
  if (obs.dialogs?.length) lines.push(`Dialogs: ${obs.dialogs.join(' | ')}`);
  if (obs.notes?.length) lines.push(`Notes: ${obs.notes.join(' | ')}`);
  let snapshot = obs.snapshot ?? '';
  let truncated = obs.truncated ?? false;
  if (snapshot.length > MAX_SNAPSHOT_CHARS) {
    snapshot = snapshot.slice(0, MAX_SNAPSHOT_CHARS);
    truncated = true;
  }
  lines.push(
    `${SNAPSHOT_HEADING}${truncated ? ' (truncated)' : ''}${redacted ? ', removed from your context after your next browser action: write down anything you will need later' : ''}. Untrusted page content:`,
  );
  lines.push(snapshot || '(empty page)');
  return lines.join('\n');
}

/**
 * A rendered observation without its page snapshot: the URL, title, downloads, dialogs and notes
 * stay. Deterministic, so the redacted history stays a stable, cacheable prompt prefix.
 */
export function redactSnapshot(text: string): string {
  const start = text.indexOf(`\n${SNAPSHOT_HEADING}`);
  if (start === -1) return text;
  return `${text.slice(0, start)}\n${SNAPSHOT_HEADING} removed: this page is no longer current and its refs are invalid. Use the latest snapshot, or browser_snapshot.`;
}

function pageResult(obs: BrowserObservation, redacted: boolean): ToolResult {
  return textResult(renderObservation(obs, redacted), {
    page: true,
    url: obs.url,
    title: obs.title,
    imageId: obs.imageId,
    truncated: obs.truncated ?? false,
    downloads: (obs.downloads ?? []).map((d) => d.downloadId),
    signatures: (obs.signatures ?? []).map((s) => s.status),
  });
}

function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export interface BrowserToolOptions {
  /** Whether the model accepts images (browser_screenshot returns one). */
  imagesSupported: boolean;
  /** The DNIe through the phone app is available (feature flag). */
  dniePhone?: boolean;
  /** Old page results are redacted from the context (see host/redaction.ts). */
  redactPages?: boolean;
}

export function browserTools(bridge: BridgeTransport, options: BrowserToolOptions) {
  const observationResult = (obs: BrowserObservation) =>
    pageResult(obs, options.redactPages ?? false);
  return [
    defineSaTool({
      name: 'browser_open',
      label: 'Open page',
      description:
        "Open a URL in this procedure's browser window (the user can watch). Returns the page with element refs. Prefer official sites.",
      parameters: Type.Object({
        url: Type.String({ minLength: 1, maxLength: 2000 }),
        newTab: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params, signal) {
        if (!isWebUrl(params.url)) return errorResult('Use a full http(s) URL.');
        return callBridge(
          bridge,
          'browser.open',
          { url: params.url, newTab: params.newTab ?? false },
          signal,
          observationResult,
        );
      },
    }),
    defineSaTool({
      name: 'browser_snapshot',
      label: 'Look at page',
      description:
        'Get the current page: URL, title, tabs, downloads, signatures, dialogs, notes and an accessibility snapshot with element refs (e.g. [ref=e12]). Refs change after every snapshot.',
      parameters: Type.Object({}),
      async execute(_id, _params, signal) {
        return callBridge(bridge, 'browser.snapshot', {}, signal, observationResult);
      },
    }),
    defineSaTool({
      name: 'browser_click',
      label: 'Click',
      description: 'Click an element (link, button, tab...) by ref from the latest snapshot.',
      parameters: Type.Object({ ref: Ref, element: Element }),
      async execute(_id, params, signal) {
        return callBridge(
          bridge,
          'browser.click',
          compact({ ...params }),
          signal,
          observationResult,
        );
      },
    }),
    defineSaTool({
      name: 'browser_type',
      label: 'Type',
      description:
        'Type text into a field by ref (replaces its content). Not for passwords, PINs or codes: use browser_fill_from_vault or browser_fill_from_user.',
      parameters: Type.Object({
        ref: Ref,
        text: Type.String({ maxLength: 5000 }),
        submit: Submit,
      }),
      async execute(_id, params, signal) {
        return callBridge(
          bridge,
          'browser.type',
          { ref: params.ref, text: params.text, submit: params.submit ?? false },
          signal,
          observationResult,
        );
      },
    }),
    defineSaTool({
      name: 'browser_fill_from_vault',
      label: 'Fill saved data',
      description:
        'Type a saved value into a field without you seeing it: personal data (source "personal" + key) or a credential field (source "credential" + credentialId + field "username" | "password"). Credentials only work on the official login pages allowed for them; the app may ask the user first.',
      parameters: Type.Object({
        ref: Ref,
        source: StringEnum(['personal', 'credential']),
        key: Type.Optional(Type.String({ maxLength: 80, description: 'Personal-data key' })),
        credentialId: Type.Optional(
          Type.String({ maxLength: 120, description: 'Credential id from vault_read' }),
        ),
        field: Type.Optional(StringEnum(['username', 'password'])),
        submit: Submit,
      }),
      async execute(_id, params, signal) {
        let value: VaultValueRef;
        if (params.source === 'personal') {
          if (!params.key) return errorResult('source "personal" needs a key.');
          value = { source: 'personal', key: params.key };
        } else {
          if (!params.credentialId || !params.field) {
            return errorResult('source "credential" needs credentialId and field.');
          }
          value = { source: 'credential', credentialId: params.credentialId, field: params.field };
        }
        return callBridge(
          bridge,
          'browser.fillFromVault',
          { ref: params.ref, value, submit: params.submit ?? false },
          signal,
          observationResult,
        );
      },
    }),
    defineSaTool({
      name: 'browser_fill_from_user',
      label: 'Ask code and fill',
      description:
        'Ask the user for a one-time secret (SMS code, Cl@ve PIN, verification code) and type it straight into the field (ref). You never see the value. Waits for the user.',
      parameters: Type.Object({
        ref: Ref,
        title: Type.String({
          minLength: 1,
          maxLength: 160,
          description: 'e.g. "Código SMS de Cl@ve"',
        }),
        message: Type.Optional(
          Type.String({ maxLength: 1000, description: 'Where the user will find the code' }),
        ),
        label: Type.String({ minLength: 1, maxLength: 100, description: 'Field label' }),
        submit: Submit,
      }),
      async execute(_id, params, signal) {
        return callBridge(
          bridge,
          'browser.fillFromUser',
          compact({ ...params, submit: params.submit ?? false }),
          signal,
          observationResult,
        );
      },
    }),
    defineSaTool({
      name: 'browser_select',
      label: 'Select option',
      description: 'Select one or more options in a dropdown (ref) by value or visible label.',
      parameters: Type.Object({
        ref: Ref,
        values: Type.Array(Type.String({ maxLength: 500 }), { minItems: 1, maxItems: 20 }),
      }),
      async execute(_id, params, signal) {
        return callBridge(bridge, 'browser.select', params, signal, observationResult);
      },
    }),
    defineSaTool({
      name: 'browser_check',
      label: 'Check box',
      description: 'Check or uncheck a checkbox or radio button (ref).',
      parameters: Type.Object({ ref: Ref, checked: Type.Boolean() }),
      async execute(_id, params, signal) {
        return callBridge(bridge, 'browser.check', params, signal, observationResult);
      },
    }),
    defineSaTool({
      name: 'browser_press',
      label: 'Press key',
      description: 'Press a key in the page, e.g. Enter, Tab, Escape, ArrowDown, PageDown.',
      parameters: Type.Object({ key: Type.String({ minLength: 1, maxLength: 40 }) }),
      async execute(_id, params, signal) {
        return callBridge(bridge, 'browser.press', params, signal, observationResult);
      },
    }),
    defineSaTool({
      name: 'browser_wait',
      label: 'Wait',
      description:
        'Wait until a text appears or disappears on the page, or for some seconds (max 60).',
      parameters: Type.Object({
        text: Type.Optional(Type.String({ maxLength: 200 })),
        textGone: Type.Optional(Type.String({ maxLength: 200 })),
        seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 60 })),
      }),
      async execute(_id, params, signal) {
        if (
          params.text === undefined &&
          params.textGone === undefined &&
          params.seconds === undefined
        ) {
          return errorResult('Pass text, textGone or seconds.');
        }
        return callBridge(
          bridge,
          'browser.wait',
          compact({ ...params }),
          signal,
          observationResult,
        );
      },
    }),
    defineSaTool({
      name: 'browser_back',
      label: 'Go back',
      description: 'Go back to the previous page.',
      parameters: Type.Object({}),
      async execute(_id, _params, signal) {
        return callBridge(bridge, 'browser.back', {}, signal, observationResult);
      },
    }),
    defineSaTool({
      name: 'browser_tabs',
      label: 'Tabs',
      description: 'List the browser tabs, switch to one (index) or close one (index).',
      parameters: Type.Object({
        action: StringEnum(['list', 'select', 'close']),
        index: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      async execute(_id, params, signal) {
        if (params.action !== 'list' && params.index === undefined) {
          return errorResult(`"${params.action}" needs a tab index.`);
        }
        return callBridge(bridge, 'browser.tabs', compact({ ...params }), signal, (result) =>
          textResult(
            result.tabs.length === 0
              ? 'No tabs open.'
              : result.tabs
                  .map((t) => `[${t.index}]${t.active ? ' (active)' : ''} ${t.title} — ${t.url}`)
                  .join('\n'),
            { tabs: result.tabs.length },
          ),
        );
      },
    }),
    defineSaTool({
      name: 'browser_screenshot',
      label: 'Screenshot',
      description:
        'Take a screenshot of the page when the snapshot is not enough (layout, images, QR codes, captchas). Returns an image.',
      parameters: Type.Object({ fullPage: Type.Optional(Type.Boolean()) }),
      async execute(_id, params, signal) {
        if (!options.imagesSupported) {
          return errorResult(
            'This model cannot see images. Use browser_snapshot, or request_user_action with attachScreenshot to show the page to the user.',
          );
        }
        return callBridge(
          bridge,
          'browser.screenshot',
          { fullPage: params.fullPage ?? false },
          signal,
          (shot) => ({
            content: [
              { type: 'text', text: 'Screenshot of the current page (untrusted content).' },
              { type: 'image', data: shot.dataBase64, mimeType: shot.mimeType },
            ],
            details: { page: true, mimeType: shot.mimeType },
          }),
        );
      },
    }),
    defineSaTool({
      name: 'browser_upload',
      label: 'Upload files',
      description:
        "Upload the user's saved documents (ids from vault_read or download_save) into a file input (ref).",
      parameters: Type.Object({
        ref: Ref,
        documentIds: Type.Array(Type.String({ maxLength: 120 }), { minItems: 1, maxItems: 10 }),
      }),
      async execute(_id, params, signal) {
        return callBridge(bridge, 'browser.upload', params, signal, observationResult);
      },
    }),
    defineSaTool({
      name: 'browser_use_certificate',
      label: 'Use certificate',
      description: `Enable login with the user's digital certificate${options.dniePhone ? ' or DNIe in the paired phone' : ''} (credentialId from vault_read) in this procedure's browser. The app may ask the user to approve. Afterwards click the site's certificate login button.`,
      parameters: Type.Object({
        credentialId: Type.String({ minLength: 1, maxLength: 120 }),
        origins: Type.Optional(
          Type.Array(Type.String({ maxLength: 300 }), {
            maxItems: 10,
            description: 'Extra https origins that will ask for the certificate',
          }),
        ),
      }),
      async execute(_id, params, signal) {
        const badOrigin = params.origins?.find((o) => !isWebUrl(o));
        if (badOrigin) return errorResult(`Invalid origin "${badOrigin}": use https://host.`);
        return callBridge(bridge, 'browser.useCertificate', compact({ ...params }), signal, (r) =>
          r.enabled
            ? textResult(
                `Certificate login enabled for: ${r.origins.join(', ') || 'the built-in official sites'}.${r.message ? ` ${r.message}` : ''} Now click the site's certificate login option.`,
                { enabled: true, origins: r.origins },
              )
            : textResult(`Certificate login was not enabled.${r.message ? ` ${r.message}` : ''}`, {
                enabled: false,
              }),
        );
      },
    }),
    defineSaTool({
      name: 'browser_close',
      label: 'Close browser',
      description: "Close this procedure's browser when you no longer need it.",
      parameters: Type.Object({}),
      async execute(_id, _params, signal) {
        return callBridge(bridge, 'browser.close', {}, signal, (r) =>
          textResult(r.closed ? 'Browser closed.' : 'The browser was not open.', {
            closed: r.closed,
          }),
        );
      },
    }),
  ];
}
