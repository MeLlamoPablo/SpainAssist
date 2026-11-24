/** Signing a PDF of Mis documentos with a visible signature, as the agent's api.documents.sign does. */
import { loadDemoIdentity } from '@sa/mock-sede';
import type { PdfSignaturePrompt } from '@sa/shared';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { signerLib } from '../app/libs';
import { silentLogger } from '../core/logger';
import { createTestApp, type TestApp } from '../testing/harness';

/** A one-page A4 PDF with a classic cross-reference table. */
function onePagePdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
  ];
  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f\r\n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n\r\n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

let app: TestApp;
let procedureId: string;
let token: string;
let touchIds: number;

beforeEach(async () => {
  touchIds = 0;
  app = await createTestApp({
    signer: signerLib(silentLogger),
    biometric: {
      available: () => true,
      prompt: async () => {
        touchIds++;
        return true;
      },
    },
  });
  ({ procedureId, token } = await app.procedureWithToken());
  const demo = loadDemoIdentity();
  await app.vault.addCertificate({
    fileName: 'demo.p12',
    p12: demo.p12,
    passphrase: demo.passphrase,
  });
});
afterEach(async () => {
  await app.close();
});

async function addPdf() {
  const pdf = onePagePdf();
  const doc = await app.vault.addDocument({
    name: 'Contrato.pdf',
    mimeType: 'application/pdf',
    source: 'user',
    bytes: pdf,
  });
  return { pdf, doc };
}

it('shows the PDF to place the signature, then replaces the document with the signed one', async () => {
  const { pdf, doc } = await addPdf();
  const call = app.rpc('vault.signDocument', { document: doc.name }, token);
  await app.waitFor(() => !!app.pendingPrompt(procedureId));
  const item = app.pendingPrompt(procedureId)!;
  const prompt = item.prompt as PdfSignaturePrompt;
  expect(prompt).toMatchObject({
    kind: 'pdf_signature',
    mode: 'choose',
    approval: 'here',
    biometric: true,
    documentName: 'Contrato.pdf',
    appearance: 'handwritten',
    // The default spot: bottom right of the last page.
    initial: { page: 1, rect: [375, 40, 555, 104] },
  });
  expect(prompt.details).toContainEqual({ label: 'Para', value: 'Mis documentos' });
  expect(Buffer.from((await app.invoke('chat.promptDocument', item.id))!)).toEqual(pdf);

  await app.invoke('chat.respond', item.id, {
    kind: 'pdf_signature',
    approved: true,
    placement: { page: 1, rect: [60, 60, 260, 130] },
  });
  expect((await call).body.result).toEqual({
    name: 'Contrato.pdf',
    signed: true,
  });
  expect(touchIds).toBe(1);
  // Same document, now signed: the original bytes come first, then the signature's update.
  expect(app.vault.listDocuments()).toHaveLength(1);
  const meta = app.vault.getDocument(doc.id);
  expect(meta?.signedAt).toEqual(expect.any(String));
  const signed = await app.vault.readDocument(doc.id);
  expect(signed.subarray(0, pdf.length)).toEqual(pdf);
  const text = signed.toString('latin1');
  expect(text).toContain('/ByteRange');
  expect(text).toMatch(/\/Rect \[ ?60 60 260 130 ?\]/);
  expect(text).toContain('/AP');
  // Answered prompts no longer hand out the document.
  expect(await app.invoke('chat.promptDocument', item.id)).toBeNull();
  // Mis documentos lists who signed it, read from the file.
  const [signature, ...others] = await app.invoke('vault.documentSignatures', doc.id);
  expect(others).toEqual([]);
  // Tests make no network calls, so no timestamp.
  expect(signature).toMatchObject({
    dnie: false,
    issuer: expect.any(String),
    timestamped: false,
  });
  // The demo certificate's holder (the fake vault's summary has a made-up one).
  expect(signature.name).toBe('Carmen Española Española');
  expect(Math.abs(Date.parse(signature.signedAt!) - Date.parse(meta!.signedAt!))).toBeLessThan(
    5000,
  );
});

it('lists no signatures for a PDF nobody signed', async () => {
  const { doc } = await addPdf();
  expect(await app.invoke('vault.documentSignatures', doc.id)).toEqual([]);
});

it('leaves the document as it was when the user does not sign', async () => {
  const { pdf, doc } = await addPdf();
  const call = app.rpc('vault.signDocument', { document: doc.name }, token);
  await app.waitFor(() => !!app.pendingPrompt(procedureId));
  await app.invoke('chat.respond', app.pendingPrompt(procedureId)!.id, {
    kind: 'pdf_signature',
    approved: false,
  });
  expect((await call).body.result).toEqual({
    name: 'Contrato.pdf',
    signed: false,
  });
  expect(await app.vault.readDocument(doc.id)).toEqual(pdf);
  expect(app.vault.getDocument(doc.id)?.signedAt).toBeUndefined();
});

it('withdraws the card when the agent stops waiting, so a retry shows only one', async () => {
  const { pdf, doc } = await addPdf();
  const controller = new AbortController();
  const call = app
    .rpc('vault.signDocument', { document: doc.name }, token, { signal: controller.signal })
    .catch(() => undefined);
  await app.waitFor(() => !!app.pendingPrompt(procedureId));
  controller.abort();
  await call;
  await app.waitFor(() => !app.pendingPrompt(procedureId));
  expect(await app.vault.readDocument(doc.id)).toEqual(pdf);
  expect(touchIds).toBe(0);
});

it('refuses documents that are not PDFs', async () => {
  const doc = await app.vault.addDocument({
    name: 'Foto.jpg',
    mimeType: 'image/jpeg',
    source: 'user',
    bytes: Buffer.from('jpeg'),
  });
  const reply = await app.rpc('vault.signDocument', { document: doc.name }, token);
  expect(reply.body).toMatchObject({ ok: false, error: { code: 'bad_request' } });
});
