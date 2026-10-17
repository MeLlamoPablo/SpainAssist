import { Type } from 'typebox';
import type { BridgeTransport } from '../bridge/client';
import { callBridge, defineSaTool, textResult } from './common';

const DownloadSaveParams = Type.Object({
  downloadId: Type.String({
    minLength: 1,
    maxLength: 120,
    description: 'Id of a temporary download, from the Downloads line of a browser result',
  }),
  name: Type.String({
    minLength: 1,
    maxLength: 120,
    description:
      'Short name in the user\'s language that says what the document is, without extension: type or purpose, plus a verified year or date when useful (e.g. "Modelo 100 - Renta 2025", "Informe de vida laboral - 2026-10-04"). Never the website\'s file name, internal codes or personal data.',
  }),
});

/** Downloads stay temporary until the agent saves them to the user's documents. */
export function downloadTools(bridge: BridgeTransport) {
  return [
    defineSaTool({
      name: 'download_save',
      label: 'Save a document',
      description:
        "Save a temporary download to the user's documents (the vault) under a readable name, so the user keeps it and can find it later. Only save what the user will need (receipts, certificates, filled forms, official letters); leave the rest. The app keeps the file extension. Returns the document id (for browser_upload).",
      parameters: DownloadSaveParams,
      async execute(_id, params, signal) {
        return callBridge(bridge, 'downloads.save', params, signal, (result) =>
          textResult(
            `Saved to the user's documents as "${result.name}" (id ${result.documentId}).`,
            result,
          ),
        );
      },
    }),
  ];
}
