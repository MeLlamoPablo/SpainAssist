/** Writing a new PDF in Mis documentos from Markdown, as api.documents.create does. */
import { getDocumentProxy } from 'unpdf';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { signerLib } from '../app/libs';
import { silentLogger } from '../core/logger';
import { createTestApp, type TestApp } from '../testing/harness';

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

it('saves the written PDF in the documents, with its fields, for the procedure', async () => {
  const reply = await app.rpc(
    'vault.createDocument',
    { name: 'Contrato de préstamo', markdown: '# Contrato\n\nDomicilio: ______[Domicilio]' },
    token,
  );
  expect(reply.body.result).toEqual({ name: 'Contrato de préstamo.pdf', pages: 1 });
  const [{ id: documentId }] = app.vault.listDocuments();
  expect(app.vault.getDocument(documentId)).toMatchObject({
    mimeType: 'application/pdf',
    source: 'agent',
    procedureId,
  });
  const pdf = await getDocumentProxy(new Uint8Array(await app.vault.readDocument(documentId)));
  expect((await pdf.getMetadata()).info).toMatchObject({ Title: 'Contrato de préstamo' });
  const annotations = await (await pdf.getPage(1)).getAnnotations();
  expect(annotations.map((a: { fieldName?: string }) => a.fieldName)).toEqual(['Domicilio']);
});

it('refuses a document with nothing to write', async () => {
  const reply = await app.rpc('vault.createDocument', { name: 'Vacío', markdown: '\n\n' }, token);
  expect(reply.body).toMatchObject({ ok: false, error: { code: 'bad_request' } });
  expect(app.vault.listDocuments()).toEqual([]);
});
