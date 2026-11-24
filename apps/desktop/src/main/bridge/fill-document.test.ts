/** Filling in a PDF of Mis documentos where the agent pointed, as api.documents.fill does. */
import { extractText, getDocumentProxy } from 'unpdf';
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

beforeEach(async () => {
  app = await createTestApp({ signer: signerLib(silentLogger) });
  ({ procedureId, token } = await app.procedureWithToken());
});
afterEach(async () => {
  await app.close();
});

const values = (text: string) => [{ page: 1, x: 0.5, y: 0.5, text }];

it('fills a blank into a new document, then that copy again from the blank, in place', async () => {
  const blank = await app.vault.addDocument({
    name: 'EX-15.pdf',
    mimeType: 'application/pdf',
    source: 'user',
    bytes: onePagePdf(),
  });

  const first = await app.rpc(
    'vault.fillDocument',
    { document: 'EX-15', values: values('Primera') },
    token,
  );
  expect(first.body.result).toEqual({
    name: 'EX-15 (rellenado).pdf',
    pages: [1],
    warnings: [],
  });
  const copyId = app.vault.listDocuments().find((d) => d.id !== blank.id)?.id ?? '';
  expect(app.vault.getDocument(copyId)).toMatchObject({
    source: 'agent',
    procedureId,
    filledFrom: blank.id,
  });
  // The blank stays blank.
  expect(await app.vault.readDocument(blank.id)).toEqual(onePagePdf());

  const again = await app.rpc(
    'vault.fillDocument',
    { document: 'EX-15 (rellenado).pdf', values: values('Segunda'), name: 'Solicitud NIE' },
    token,
  );
  expect(again.body.result).toMatchObject({ name: 'Solicitud NIE.pdf' });
  expect(app.vault.getDocument(copyId)?.name).toBe('Solicitud NIE.pdf');
  expect(app.vault.listDocuments()).toHaveLength(2);
  // Filled again from the blank: the first value is gone.
  const { text } = await extractText(
    await getDocumentProxy(new Uint8Array(await app.vault.readDocument(copyId))),
    { mergePages: true },
  );
  expect(text).not.toContain('Primera');
  expect(text).toContain('Segunda');
});

it('refuses what is not a PDF it can fill', async () => {
  const photo = await app.vault.addDocument({
    name: 'DNI.jpg',
    mimeType: 'image/jpeg',
    source: 'user',
    bytes: Buffer.from('foto'),
  });
  const notPdf = await app.rpc(
    'vault.fillDocument',
    { document: photo.name, values: values('x') },
    token,
  );
  expect(notPdf.body.error).toMatchObject({
    code: 'bad_request',
    message: 'Only PDF documents can be filled in.',
  });

  const broken = await app.vault.addDocument({
    name: 'Roto.pdf',
    mimeType: 'application/pdf',
    source: 'user',
    bytes: Buffer.from('not a pdf'),
  });
  const unreadable = await app.rpc(
    'vault.fillDocument',
    { document: broken.name, values: values('x') },
    token,
  );
  expect(unreadable.body.error).toMatchObject({
    code: 'bad_request',
    message: 'This file is not a PDF that can be read.',
  });

  const missing = await app.rpc(
    'vault.fillDocument',
    { document: 'nope', values: values('x') },
    token,
  );
  expect(missing.body.error?.code).toBe('not_found');
});
