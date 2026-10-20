import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestKeyProvider, Vault } from '@sa/vault';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../testing/harness';
import { withPersonalOptions } from './handlers';

let app: TestApp;
let procedureId: string;
let token: string;

beforeEach(async () => {
  app = await createTestApp();
  ({ procedureId, token } = await app.procedureWithToken());
});
afterEach(async () => {
  await app.close();
});

const CLAVE_LOGIN = 'https://clave-dninbrt.seg-social.gob.es/IPUC2/Login';

describe('bridge: transport, auth and validation', () => {
  it('rejects missing/invalid tokens, browser origins, unknown methods and invalid params', async () => {
    expect((await app.rpc('procedure.get', {}, undefined)).status).toBe(401);
    expect((await app.rpc('procedure.get', {}, 'not-a-token')).status).toBe(401);
    const fromPage = await app.rpc('procedure.get', {}, token, {
      headers: { origin: 'https://evil.example' },
    });
    expect(fromPage.status).toBe(401);
    expect((await app.rpc('nope.method', {}, token)).body).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    const invalid = await app.rpc('procedure.update', { status: 'bogus' }, token);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error?.code).toBe('bad_request');
    const ok = await app.rpc('procedure.get', {}, token);
    expect(ok).toMatchObject({ status: 200, body: { ok: true, result: { id: procedureId } } });
  });

  it('invalidates the previous token when a new one is issued, and on deletion', async () => {
    const fresh = app.services.tokens.issue(procedureId);
    expect((await app.rpc('procedure.get', {}, token)).status).toBe(401);
    expect((await app.rpc('procedure.get', {}, fresh)).status).toBe(200);
    await app.invoke('procedures.delete', procedureId);
    expect((await app.rpc('procedure.get', {}, fresh)).status).toBe(401);
  });

  it('procedure.update replaces arrays and pushes the upsert', async () => {
    const res = await app.rpc(
      'procedure.update',
      {
        title: 'Renovación del DNI',
        status: 'planned',
        sources: [
          { title: 'Sede', url: 'https://sede.policia.gob.es/dni' },
          { title: 'Foro', url: 'https://foro.example.com/dni' },
        ],
      },
      token,
    );
    expect(res.body.result.sources).toEqual([
      { title: 'Sede', url: 'https://sede.policia.gob.es/dni' },
      { title: 'Foro', url: 'https://foro.example.com/dni' },
    ]);
    expect(app.events.at(-1)).toMatchObject({
      type: 'procedure.upserted',
      procedure: { id: procedureId, title: 'Renovación del DNI', status: 'planned' },
    });
  });
});

describe('bridge: prompts', () => {
  it('prompt.form waits for chat.respond and saves opted-in answers to the vault', async () => {
    const call = app.rpc(
      'prompt.form',
      {
        title: 'Tus datos',
        fields: [
          { key: 'name', label: 'Nombre', type: 'text', vaultKey: 'givenName' },
          { key: 'phone', label: 'Teléfono', type: 'phone', vaultKey: 'phone' },
          { key: 'ref', label: 'Referencia', type: 'text', vaultKey: 'custom.referencia' },
        ],
      },
      token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    expect(app.services.procedures.get(procedureId)?.runtime.activity).toBe('needs_user');
    const prompt = app.pendingPrompt(procedureId)!;
    await app.invoke('chat.respond', prompt.id, {
      kind: 'form',
      values: { name: 'Lucía', phone: '600111222', ref: 'ABC123' },
      dismissed: false,
      savedToVault: ['name', 'ref'],
    });
    const res = await call;
    expect(res.body).toEqual({
      ok: true,
      result: {
        kind: 'form',
        values: { name: 'Lucía', phone: '600111222', ref: 'ABC123' },
        dismissed: false,
        savedToVault: ['name', 'ref'],
      },
    });
    expect(app.vault.getPersonal('givenName')).toMatchObject({ value: 'Lucía', source: 'form' });
    expect(app.vault.getPersonal('custom.referencia')).toMatchObject({ label: 'Referencia' });
    expect(app.vault.getPersonal('phone')).toBeUndefined();
    const notice = app.services.conversation.transcript().find((i) => i.type === 'notice');
    expect(notice).toMatchObject({
      text: 'Guardado en Mis datos: Nombre, Referencia.',
      procedureId,
    });
    expect(app.events.some((e) => e.type === 'vault.changed')).toBe(true);
  });

  it('prompt.form saves what it can and tells the agent what the vault refused', async () => {
    const realVault = await Vault.open(
      join(app.paths.userData, 'form-vault'),
      createTestKeyProvider('form'),
    );
    vi.spyOn(app.vault, 'setPersonal').mockImplementation((items, source) =>
      realVault.setPersonal(items, source),
    );
    const call = app.rpc(
      'prompt.form',
      {
        title: 'Tus datos',
        fields: [
          { key: 'name', label: 'Nombre', type: 'text', vaultKey: 'givenName' },
          { key: 'born', label: 'Nacimiento', type: 'text', vaultKey: 'birthDate' },
        ],
      },
      token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    await app.invoke('chat.respond', app.pendingPrompt(procedureId)!.id, {
      kind: 'form',
      values: { name: 'Lucía', born: 'ayer' },
      dismissed: false,
      savedToVault: ['name', 'born'],
      // Reported by the form's document scan.
      vaultErrors: [{ key: 'custom.notes', reason: 'label_required' }],
    });
    const res = await call;
    expect(res.body).toMatchObject({
      ok: true,
      result: {
        values: { name: 'Lucía', born: 'ayer' },
        savedToVault: ['name'],
        vaultErrors: [
          { key: 'custom.notes', reason: 'label_required' },
          { key: 'birthDate', reason: 'invalid_date' },
        ],
      },
    });
    expect(realVault.getPersonal('givenName')).toMatchObject({ value: 'Lucía' });
    expect(realVault.getPersonal('birthDate')).toBeUndefined();
    const notice = app.services.conversation.transcript().find((i) => i.type === 'notice');
    expect(notice).toMatchObject({ text: 'Guardado en Mis datos: Nombre.' });
  });

  it('never returns secret form values to the agent', async () => {
    const call = app.rpc(
      'prompt.form',
      {
        title: 'Secret',
        fields: [{ key: 'password', label: 'Password', type: 'secret' }],
      },
      token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    await app.invoke('chat.respond', app.pendingPrompt(procedureId)!.id, {
      kind: 'form',
      values: { password: 'private-password' },
      dismissed: false,
      savedToVault: [],
    });
    const result = await call;
    expect(JSON.stringify(result.body)).not.toContain('private-password');
    expect(JSON.stringify(app.services.conversation.transcript())).not.toContain(
      'private-password',
    );
  });

  describe('prompt.credential', () => {
    /** The agent asks for a credential; the renderer answers with `credentialId`. */
    async function askFor(credential: 'dnie', credentialId: string | undefined) {
      const call = app.rpc(
        'prompt.credential',
        { credential, title: 'Añádelo', message: 'Lo necesito para entrar.' },
        token,
      );
      await app.waitFor(() => !!app.pendingPrompt(procedureId));
      await app.invoke('chat.respond', app.pendingPrompt(procedureId)!.id, {
        kind: 'credential',
        credentialId,
      });
      return (await call).body;
    }
    it('returns the DNIe the user added, and not a credential of another kind', async () => {
      const dnie = await app.vault.addDnie();
      expect((await askFor('dnie', dnie.id)).result).toEqual({
        kind: 'credential',
        credentialId: dnie.id,
      });
      const clave = await app.vault.addClave({ username: '12345678Z', password: 'S3cret!pass' });
      const body = await askFor('dnie', clave.id);
      expect(body.result).toEqual({ kind: 'credential' });
      expect(JSON.stringify(body)).not.toContain('S3cret!pass');
      expect((await askFor('dnie', undefined)).result).toEqual({ kind: 'credential' });
    });

    it('refuses to ask for the DNIe without the phone app', async () => {
      const off = await createTestApp({ features: { dniePhone: false } });
      try {
        const { token: offToken } = await off.procedureWithToken();
        const res = await off.rpc(
          'prompt.credential',
          { credential: 'dnie', title: 'Añade tu DNIe', message: 'Lo necesito.' },
          offToken,
        );
        expect(res.body).toMatchObject({ ok: false, error: { code: 'bad_request' } });
        expect(off.pendingPrompt(procedureId)).toBeUndefined();
      } finally {
        await off.close();
      }
    });
  });

  it('stopping the procedure cancels its pending prompt', async () => {
    const call = app.rpc(
      'prompt.confirm',
      {
        confirmKind: 'submission',
        title: 'Confirm',
        message: 'Proceed?',
      },
      token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    await app.invoke('procedures.stop', procedureId);
    expect((await call).body.ok).toBe(false);
    expect(app.services.prompts.pendingCount(procedureId)).toBe(0);
  });

  it('cancels the prompt when the agent request is aborted', async () => {
    const controller = new AbortController();
    const call = app
      .rpc(
        'prompt.confirm',
        { confirmKind: 'submission', title: 'Enviar', message: 'Voy a enviar la solicitud' },
        token,
        {
          signal: controller.signal,
        },
      )
      .catch((err: Error) => err);
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    controller.abort();
    expect(await call).toBeInstanceOf(Error);
    await app.waitFor(() =>
      app.services.procedures
        .transcript(procedureId)
        .some((i) => i.type === 'prompt' && i.status === 'cancelled'),
    );
    expect(app.services.procedures.get(procedureId)?.runtime.activity).toBe('idle');
  });

  it('procedures.stop cancels pending prompts and the agent gets user_rejected', async () => {
    const call = app.rpc(
      'prompt.userAction',
      { actionKind: 'captcha', title: 'Captcha', message: 'Resuelve el captcha' },
      token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    await app.invoke('procedures.stop', procedureId);
    const res = await call;
    expect(res).toMatchObject({
      status: 409,
      body: { ok: false, error: { code: 'user_rejected' } },
    });
  });

  it('saves the browser capture when a procedure is stopped, in capture mode only', async () => {
    const saved = (a: TestApp, id: string) =>
      a.browser.calls.some((c) => c.method === 'finishCapture' && c.procedureId === id);
    await app.rpc('browser.open', { url: 'https://pasarela.clave.gob.es/' }, token);
    await app.invoke('procedures.stop', procedureId);
    expect(saved(app, procedureId)).toBe(false);

    const capturing = await createTestApp({ env: { browserCapture: true } });
    try {
      const own = await capturing.procedureWithToken();
      await capturing.rpc('browser.open', { url: 'https://pasarela.clave.gob.es/' }, own.token);
      await capturing.invoke('procedures.stop', own.procedureId);
      await capturing.waitFor(() => saved(capturing, own.procedureId));
    } finally {
      await capturing.close();
    }
  });

  it('only exposes the browser after the user clicks during a pending help request', async () => {
    await app.rpc('browser.open', { url: 'https://pasarela.clave.gob.es/' }, token);
    await app.invoke('browser.show', procedureId);
    expect(app.browser.calls.some((c) => c.method === 'show')).toBe(false);
    const call = app.rpc(
      'prompt.userAction',
      {
        actionKind: 'qr_scan',
        title: 'Escanea el QR',
        message: 'Abre la app Cl@ve',
        attachScreenshot: true,
      },
      token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const prompt = app.pendingPrompt(procedureId)!;
    expect(prompt.prompt.kind).toBe('user_action');
    const imageId = prompt.prompt.kind === 'user_action' ? prompt.prompt.imageId : undefined;
    expect(imageId).toBeDefined();
    expect(await app.invoke('media.get', imageId!)).toMatch(/^data:image\/jpeg;base64,/);
    expect(prompt.prompt).toMatchObject({ showBrowser: true });
    expect(app.browser.calls.some((c) => c.method === 'show')).toBe(false);
    await app.invoke('browser.show', procedureId);
    expect(app.browser.calls.filter((c) => c.method === 'show')).toHaveLength(1);
    await app.invoke('chat.respond', prompt.id, { kind: 'user_action', done: true });
    const other = await app.procedureWithToken();
    app.browser.opened.add(other.procedureId);
    await app.invoke('browser.show', other.procedureId);
    expect(app.browser.calls.filter((c) => c.method === 'show')).toHaveLength(1);
    expect((await call).body.result).toEqual({ kind: 'user_action', done: true });
    expect(app.browser.calls.at(-1)).toMatchObject({ method: 'hide', procedureId });
    await app.invoke('browser.show', procedureId);
    expect(app.browser.calls.filter((c) => c.method === 'show')).toHaveLength(1);
  });

  it.each([false, true])('cancels help safely (user opened browser: %s)', async (opened) => {
    await app.rpc('browser.open', { url: 'https://pasarela.clave.gob.es/' }, token);
    const call = app.rpc(
      'prompt.userAction',
      {
        actionKind: 'captcha',
        title: 'Captcha',
        message: 'Resuelve el captcha',
      },
      token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    expect(app.browser.calls.some((c) => c.method === 'show')).toBe(false);
    if (opened) {
      await app.invoke('browser.show', procedureId);
      expect(app.browser.calls.at(-1)?.method).toBe('show');
    }
    await app.invoke('procedures.stop', procedureId);
    expect((await call).body.error?.code).toBe('user_rejected');
    expect(app.browser.calls.at(-1)).toMatchObject({ method: 'hide', procedureId });
    await app.invoke('browser.show', procedureId);
    expect(app.browser.calls.at(-1)?.method).toBe('hide');
  });

  it.each([
    { actionKind: 'offline' as const, showBrowser: true, open: true },
    { actionKind: 'phone_approval' as const, showBrowser: false, open: true },
    { actionKind: 'manual_step' as const, showBrowser: true, open: false },
  ])('does not expose the browser for $actionKind (open: $open)', async (params) => {
    if (params.open)
      await app.rpc('browser.open', { url: 'https://pasarela.clave.gob.es/' }, token);
    const call = app.rpc(
      'prompt.userAction',
      {
        actionKind: params.actionKind,
        showBrowser: params.showBrowser,
        title: 'Necesito tu ayuda',
        message: 'Completa este paso',
      },
      token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const prompt = app.pendingPrompt(procedureId)!;
    expect(prompt.prompt).toMatchObject({ showBrowser: false });
    await app.invoke('browser.show', procedureId);
    expect(app.browser.calls.some((c) => c.method === 'show')).toBe(false);
    await app.invoke('chat.respond', prompt.id, { kind: 'user_action', done: true });
    expect((await call).body.ok).toBe(true);
  });
});

describe('bridge: vault', () => {
  it('vault.read never includes secrets; vault.save stores agent data with a notice', async () => {
    await app.vault.setPersonal([{ key: 'givenName', value: 'Lucía' }], 'manual');
    await app.vault.addClave({ username: '12345678Z', password: 'S3cret!pass' });
    const read = await app.rpc('vault.read', {}, token);
    const json = JSON.stringify(read.body);
    expect(json).toContain('Lucía');
    expect(json).not.toContain('S3cret!pass');
    expect(json).not.toContain('12345678Z');
    expect(read.body.result.credentials[0]).toMatchObject({
      kind: 'clave_permanente',
      policy: 'auto',
    });

    const filtered = await app.rpc('vault.read', { keys: ['email'] }, token);
    expect(filtered.body.result.personal).toEqual([]);

    const saved = await app.rpc(
      'vault.save',
      { items: [{ key: 'email', value: 'lucia@example.com' }] },
      token,
    );
    expect(saved.body.result).toEqual({ saved: ['email'] });
    expect(app.vault.getPersonal('email')).toMatchObject({ source: 'agent' });
    expect(app.services.conversation.transcript().at(-1)).toMatchObject({
      type: 'notice',
      procedureId,
      text: 'Guardado en Mis datos: Correo electrónico.',
    });
  });

  it('keeps the DNI CAN from agents: no reading, saving, typing or asking for it', async () => {
    await app.vault.setPersonal(
      [
        { key: 'dniNumber', value: '12345678Z' },
        { key: 'dniAccessNumber', value: '654321' },
      ],
      'scan',
    );
    for (const params of [{}, { keys: ['dniAccessNumber'] }]) {
      const read = await app.rpc('vault.read', params, token);
      expect(JSON.stringify(read.body)).not.toContain('654321');
      expect(JSON.stringify(read.body)).not.toContain('dniAccessNumber');
    }
    expect(
      (await app.rpc('vault.read', {}, token)).body.result.personal.map(
        (p: { key: string }) => p.key,
      ),
    ).toEqual(['dniNumber']);

    const refused = async (method: string, params: unknown) => {
      const response = await app.rpc(method, params, token);
      expect(response.body.error?.code, method).toBe('policy_denied');
      expect(JSON.stringify(response.body)).not.toContain('654321');
    };
    await refused('vault.save', { items: [{ key: 'dniAccessNumber', value: '111111' }] });
    expect(app.vault.getPersonal('dniAccessNumber')?.value).toBe('654321');
    await refused('browser.fillFromVault', { ref: 'e1', key: 'dniAccessNumber' });
    expect(app.browser.calls.some((c) => c.method === 'type')).toBe(false);
    for (const field of [
      { key: 'can', label: 'CAN', type: 'text', vaultKey: 'dniAccessNumber' },
      { key: 'dniAccessNumber', label: 'CAN', type: 'text' },
    ])
      await refused('prompt.form', { title: 'Tu DNI', fields: [field] });
    expect(app.pendingPrompt(procedureId)).toBeUndefined();
  });

  it('keeps the DNIe PIN from agents: no reading, typing, saving or asking for it', async () => {
    const dnie = await app.invoke('vault.addDnie');
    // A PIN the user wrote down as personal data (Mis datos allows custom fields) is hidden too.
    await app.vault.setPersonal(
      [{ key: 'custom.pin_dnie', label: 'PIN del DNIe', value: 'Abcd1234' }],
      'manual',
    );
    for (const params of [{}, { keys: ['custom.pin_dnie'] }]) {
      const read = await app.rpc('vault.read', params, token);
      expect(read.body.ok).toBe(true);
      expect(JSON.stringify(read.body)).not.toContain('Abcd1234');
      expect(JSON.stringify(read.body)).not.toMatch(/"pin"|pin_dnie/);
    }
    expect((await app.rpc('vault.read', {}, token)).body.result.credentials).toMatchObject([
      { id: dnie.id, kind: 'dnie' },
    ]);

    const refused = async (method: string, params: unknown, code = 'policy_denied') => {
      const response = await app.rpc(method, params, token);
      expect(response.body.error?.code, method).toBe(code);
      expect(JSON.stringify(response.body)).not.toContain('Abcd1234');
    };
    // Typing: neither the credential nor a PIN kept as personal data.
    await refused(
      'browser.fillFromVault',
      { ref: 'e1', value: { source: 'credential', credentialId: dnie.id, field: 'password' } },
      'bad_request',
    );
    await refused('browser.fillFromVault', { ref: 'e1', key: 'custom.pin_dnie' });
    expect(app.browser.calls.some((c) => c.method === 'type')).toBe(false);
    // Saving: PINs are never personal data, and nothing reaches the credential.
    for (const key of ['custom.pin', 'custom.dnie-pin', 'custom.pin_dnie'])
      await refused('vault.save', { items: [{ key, label: 'PIN', value: '87654321' }] });
    expect(await app.vault.getCredentialSecret(dnie.id)).toEqual({ kind: 'dnie' });
    // Asking: no form field for it.
    for (const field of [
      { key: 'pin', label: 'PIN del DNIe', type: 'secret' },
      { key: 'codigo', label: 'PIN', type: 'text', vaultKey: 'custom.pin_dnie' },
    ])
      await refused('prompt.form', { title: 'Tu DNIe', fields: [field] });
    expect(app.pendingPrompt(procedureId)).toBeUndefined();
    // Words that merely contain "pin" are fine.
    const saved = await app.rpc(
      'vault.save',
      { items: [{ key: 'custom.pintor_favorito', label: 'Pintor', value: 'Goya' }] },
      token,
    );
    expect(saved.body.result).toEqual({ saved: ['custom.pintor_favorito'] });
  });

  it('vault.document returns the contents of a saved document', async () => {
    const doc = await app.vault.addDocument({
      name: 'padron.pdf',
      mimeType: 'application/pdf',
      source: 'user',
      bytes: Buffer.from('%PDF-1.7'),
    });
    const read = await app.rpc('vault.document', { documentId: doc.id }, token);
    expect(read.body.result).toEqual({
      id: doc.id,
      name: 'padron.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('%PDF-1.7').toString('base64'),
    });

    const missing = await app.rpc('vault.document', { documentId: 'nope' }, token);
    expect(missing.body.error?.code).toBe('not_found');
  });
});

describe('bridge: research', () => {
  it('research.scrub removes vault values and recognizable personal data, not the municipality', async () => {
    await app.vault.setPersonal(
      [
        { key: 'givenName', value: 'Lucía' },
        { key: 'surname1', value: 'Ferrández' },
        { key: 'addressMunicipality', value: 'Alcorcón' },
      ],
      'manual',
    );
    const res = await app.rpc(
      'research.scrub',
      {
        text: 'Renovar el NIE de Lucía Ferrández (X1234567L), vive en Alcorcón, tel. 612 345 678',
      },
      token,
    );
    expect(res.status).toBe(200);
    const { text, redactions } = res.body.result;
    for (const value of ['Lucía', 'Ferrández', 'X1234567L', '612 345 678']) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain('Renovar el NIE de');
    expect(text).toContain('vive en Alcorcón');
    expect(redactions).toBeGreaterThanOrEqual(4);
  });
});

describe('bridge: downloads', () => {
  async function download(name: string) {
    const path = join(app.dir, name);
    await writeFile(path, '%PDF-1.7');
    return app.services.browser.onDownload(procedureId, {
      path,
      suggestedName: name,
      mimeType: 'application/pdf',
    });
  }

  it('downloads.save moves a temporary download to the vault under a readable name', async () => {
    const { downloadId } = await download('CotejoDocIdSv.pdf');
    expect(app.vault.listDocuments()).toEqual([]);

    const saved = await app.rpc(
      'downloads.save',
      { downloadId, name: 'Justificante de cita / DNI.PDF' },
      token,
    );
    expect(saved.body.result).toEqual({
      documentId: expect.any(String),
      name: 'Justificante de cita - DNI.pdf',
    });
    const doc = app.vault.getDocument(saved.body.result.documentId);
    expect(doc).toMatchObject({ source: 'download', procedureId });
    expect((await app.vault.readDocument(doc!.id)).toString()).toBe('%PDF-1.7');
    expect(app.services.procedures.transcript(procedureId).at(-1)).toMatchObject({
      type: 'notice',
      level: 'success',
      text: 'Descargado y guardado en Mis datos: Justificante de cita - DNI.pdf',
    });

    const again = await app.rpc('downloads.save', { downloadId, name: 'Otra vez' }, token);
    expect(again.body.error?.code).toBe('not_found');
  });

  it("only saves this procedure's downloads and drops them with the procedure", async () => {
    const { downloadId } = await download('recibo.pdf');
    const other = await app.procedureWithToken();
    const denied = await app.rpc('downloads.save', { downloadId, name: 'Recibo' }, other.token);
    expect(denied.body.error?.code).toBe('not_found');

    await app.services.deleteProcedure(procedureId);
    expect(app.services.browser.downloads.get(procedureId, downloadId)).toBeUndefined();
  });
});

describe('bridge: browser and credentials', () => {
  let credentialId: string;

  beforeEach(async () => {
    credentialId = (await app.vault.addClave({ username: '12345678Z', password: 'S3cret!pass' }))
      .id;
    app.browser.refs.set('e1', {
      role: 'textbox',
      name: 'Contraseña',
      inputType: 'password',
      frameUrl: CLAVE_LOGIN,
    });
    app.browser.refs.set('e2', {
      role: 'textbox',
      name: 'DNI',
      inputType: 'text',
      frameUrl: CLAVE_LOGIN,
    });
  });

  const login = (params: { rejected?: boolean; message?: string } = {}, refs = ['e2', 'e1']) =>
    app.rpc('browser.loginClave', { usernameRef: refs[0], passwordRef: refs[1], ...params }, token);

  const typed = () => app.browser.calls.filter((c) => c.method === 'type');
  const expectFor = { frameOrigin: new URL(CLAVE_LOGIN).origin };

  it('logs in on an official Cl@ve page: the DNI, then the password as a secret, and submits', async () => {
    const res = await login();
    expect(res.body.ok).toBe(true);
    expect(res.body.result.url).toBeDefined();
    expect(typed().map((c) => c.args)).toEqual([
      [
        'e2',
        '12345678Z',
        { submit: false, secret: true, expect: { ...expectFor, inputType: 'text' } },
      ],
      [
        'e1',
        'S3cret!pass',
        { submit: true, secret: true, expect: { ...expectFor, inputType: 'password' } },
      ],
    ]);
    expect(app.pendingPrompt(procedureId)).toBeUndefined();
    expect(app.vault.getCredential(credentialId)?.lastUsedAt).toBeDefined();
    expect(app.logLines.join('\n')).not.toContain('S3cret!pass');
    await app.services.procedures.flush();
    const transcript = await readFile(
      app.services.procedures.paths(procedureId).transcriptFile,
      'utf8',
    );
    expect(transcript).not.toContain('S3cret!pass');
    expect(JSON.stringify(app.services.conversation.transcript())).not.toContain('S3cret!pass');
  });

  it('refuses phishing domains, plain http and unknown refs before asking anything', async () => {
    app.browser.refs.set('e3', {
      role: 'textbox',
      name: 'Contraseña',
      inputType: 'password',
      frameUrl: 'https://clave.gob.es.evil-login.com/IPUC2/Login',
    });
    app.browser.refs.set('e4', {
      role: 'textbox',
      name: 'Contraseña',
      inputType: 'password',
      frameUrl: 'http://clave-dninbrt.seg-social.gob.es/IPUC2/Login',
    });
    await app.vault.deleteCredential(credentialId);
    for (const ref of ['e3', 'e4']) {
      const res = await login({}, ['e2', ref]);
      expect(res).toMatchObject({
        status: 403,
        body: { ok: false, error: { code: 'policy_denied' } },
      });
    }
    expect((await login({}, ['e2', 'e99'])).body.error?.code).toBe('not_found');
    expect(app.pendingPrompt(procedureId)).toBeUndefined();
    expect(typed()).toEqual([]);
  });

  it('types the password only into a password field and the DNI only outside one', async () => {
    expect((await login({}, ['e2', 'e2'])).body.error?.code).toBe('policy_denied');
    expect((await login({}, ['e1', 'e1'])).body.error?.code).toBe('policy_denied');
    expect(typed()).toEqual([]);
  });

  it('asks the user to add their Cl@ve Permanente when none is saved, then logs in with it', async () => {
    await app.vault.deleteCredential(credentialId);
    const call = login({ message: 'La necesito para la vida laboral.' });
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const prompt = app.pendingPrompt(procedureId)!;
    expect(prompt.prompt).toEqual({
      kind: 'credential',
      credential: 'clave_permanente',
      title: 'Añade tu Cl@ve Permanente',
      message: 'La necesito para la vida laboral.',
    });
    // The card's own form saves it; the agent never gets the values.
    const added = await app.invoke('vault.addClave', { username: '87654321X', password: 'Otra!1' });
    await app.invoke('chat.respond', prompt.id, { kind: 'credential', credentialId: added.id });
    expect((await call).body.ok).toBe(true);
    expect(typed().map((c) => c.args[1])).toEqual(['87654321X', 'Otra!1']);
  });

  it('says the user has no Cl@ve Permanente when they decline to add it', async () => {
    await app.vault.deleteCredential(credentialId);
    const call = login();
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    await app.invoke('chat.respond', app.pendingPrompt(procedureId)!.id, { kind: 'credential' });
    const res = await call;
    expect(res.body.error?.code).toBe('user_rejected');
    expect(res.body.error?.message).toContain('no Cl@ve Permanente');
    expect(typed()).toEqual([]);
  });

  it('lets the user correct a password the page rejected, keeping the same credential', async () => {
    const call = login({ rejected: true });
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const prompt = app.pendingPrompt(procedureId)!;
    expect(prompt.prompt).toMatchObject({
      kind: 'credential',
      credential: 'clave_permanente',
      title: 'Revisa tu Cl@ve Permanente',
      replaceId: credentialId,
    });
    expect(await app.invoke('vault.claveUsername', credentialId)).toBe('12345678Z');
    await app.invoke('vault.updateClave', credentialId, {
      username: '12345678Z',
      password: 'N3w!pass',
    });
    await app.invoke('chat.respond', prompt.id, { kind: 'credential', credentialId });
    expect((await call).body.ok).toBe(true);
    expect(typed().map((c) => c.args[1])).toEqual(['12345678Z', 'N3w!pass']);
    expect(app.vault.listCredentials()).toHaveLength(1);
  });

  it('asks once before use when the policy is "ask" (decline -> user_rejected)', async () => {
    await app.vault.setCredentialPolicy(credentialId, 'ask');
    const call = login();
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const prompt = app.pendingPrompt(procedureId)!;
    expect(prompt.prompt).toMatchObject({
      kind: 'confirm',
      confirmKind: 'credential',
      biometric: false,
    });
    expect(prompt.prompt.kind === 'confirm' && prompt.prompt.message).toContain(
      'clave-dninbrt.seg-social.gob.es',
    );
    await app.invoke('chat.respond', prompt.id, { kind: 'confirm', approved: false });
    expect((await call).body.error?.code).toBe('user_rejected');
    expect(typed()).toEqual([]);
  });

  it('types after approval, reuses the approval briefly, and re-checks the page after approval', async () => {
    await app.vault.setCredentialPolicy(credentialId, 'ask');
    const call = login();
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    await app.invoke('chat.respond', app.pendingPrompt(procedureId)!.id, {
      kind: 'confirm',
      approved: true,
    });
    // One question covers both fields.
    expect((await call).body.ok).toBe(true);
    expect(typed()).toHaveLength(2);
    // Same credential + site right after: no second question.
    expect((await login()).body.ok).toBe(true);
    expect(typed()).toHaveLength(4);

    // A different site: asked again; the page turns into a phishing page while the user decides.
    const aeat = 'https://www2.agenciatributaria.gob.es/login';
    app.browser.refs.set('e5', { role: 'textbox', name: 'DNI', inputType: 'text', frameUrl: aeat });
    app.browser.refs.set('e6', {
      role: 'textbox',
      name: 'Contraseña',
      inputType: 'password',
      frameUrl: aeat,
    });
    const second = login({}, ['e5', 'e6']);
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    app.browser.refs.set('e5', {
      role: 'textbox',
      name: 'DNI',
      inputType: 'text',
      frameUrl: 'https://agenciatributaria.gob.es.phish.example/login',
    });
    await app.invoke('chat.respond', app.pendingPrompt(procedureId)!.id, {
      kind: 'confirm',
      approved: true,
    });
    expect((await second).body.error?.code).toBe('policy_denied');
    expect(typed()).toHaveLength(4);
  });

  it('types personal data directly, and never a credential', async () => {
    await app.vault.setPersonal([{ key: 'documentNumber', value: '12345678Z' }], 'manual');
    const res = await app.rpc(
      'browser.fillFromVault',
      { ref: 'e2', key: 'documentNumber', submit: true },
      token,
    );
    expect(res.body.ok).toBe(true);
    expect(typed()[0]?.args).toEqual(['e2', '12345678Z', { submit: true }]);
    const missing = await app.rpc('browser.fillFromVault', { ref: 'e2', key: 'iban' }, token);
    expect(missing.body.error?.code).toBe('not_found');
    const credential = await app.rpc(
      'browser.fillFromVault',
      { ref: 'e1', value: { source: 'credential', credentialId, field: 'password' } },
      token,
    );
    expect(credential.body.error?.code).toBe('bad_request');
  });

  it('prompt.credential leaves the Cl@ve Permanente to browser.loginClave', async () => {
    const res = await app.rpc(
      'prompt.credential',
      { credential: 'clave_permanente', title: 'Añade tu Cl@ve', message: 'La necesito.' },
      token,
    );
    expect(res.body.error?.code).toBe('bad_request');
    expect(res.body.error?.message).toContain('browser_login_clave');
  });

  it('fillFromUser types a one-off secret that is never stored in the transcript or logs', async () => {
    app.browser.refs.set('e6', {
      role: 'textbox',
      name: 'Código',
      inputType: 'text',
      frameUrl: 'https://pasarela.clave.gob.es/Proxy2/ServiceRedirect',
    });
    const call = app.rpc(
      'browser.fillFromUser',
      {
        ref: 'e6',
        title: 'Código SMS',
        label: 'Código',
        message: 'Te ha llegado un SMS.',
        submit: true,
      },
      token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const prompt = app.pendingPrompt(procedureId)!;
    expect(prompt.prompt).toMatchObject({
      kind: 'form',
      fields: [{ type: 'secret', label: 'Código' }],
    });
    expect(prompt.prompt.kind === 'form' && prompt.prompt.message).toContain(
      'pasarela.clave.gob.es',
    );
    await app.invoke('chat.respond', prompt.id, {
      kind: 'form',
      values: { value: '739104' },
      dismissed: false,
      savedToVault: ['value'],
    });
    const res = await call;
    expect(res.body.ok).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('739104');
    expect(typed()[0]?.args).toEqual([
      'e6',
      '739104',
      {
        submit: true,
        secret: true,
        expect: { frameOrigin: 'https://pasarela.clave.gob.es', inputType: 'text' },
      },
    ]);
    // The question lives in the procedure's log: masked there, absent from the conversation.
    await app.services.procedures.flush();
    const log = await readFile(`${app.paths.proceduresDir}/${procedureId}/transcript.json`, 'utf8');
    expect(log).not.toContain('739104');
    expect(log).toContain('••••');
    expect(app.services.conversation.transcript()).toEqual([]);
    expect(JSON.stringify(app.events)).not.toContain('739104');
    expect(app.logLines.join('\n')).not.toContain('739104');
    expect(app.vault.listPersonal()).toEqual([]);
  });

  it('fillFromUser never asks for the Cl@ve Permanente password on its own', async () => {
    app.browser.refs.set('e6', {
      role: 'textbox',
      name: 'Contraseña',
      inputType: 'password',
      frameUrl: CLAVE_LOGIN,
    });
    const res = await app.rpc(
      'browser.fillFromUser',
      { ref: 'e6', title: 'Contraseña de Cl@ve Permanente', label: 'Contraseña' },
      token,
    );
    expect(res.body.error?.code).toBe('policy_denied');
    expect(res.body.error?.message).toContain('browser_login_clave');
    expect(app.pendingPrompt(procedureId)).toBeUndefined();
    expect(typed()).toEqual([]);
  });

  it('fillFromUser refuses a secret when the target frame changes while the user answers', async () => {
    app.browser.refs.set('e6', {
      role: 'textbox',
      name: 'Código',
      inputType: 'text',
      frameUrl: CLAVE_LOGIN,
    });
    const call = app.rpc(
      'browser.fillFromUser',
      { ref: 'e6', title: 'Código', label: 'Código' },
      token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    app.browser.refs.set('e6', {
      role: 'textbox',
      name: 'Código',
      inputType: 'text',
      frameUrl: 'https://phish.example/login',
    });
    await app.invoke('chat.respond', app.pendingPrompt(procedureId)!.id, {
      kind: 'form',
      values: { value: '827364' },
      dismissed: false,
      savedToVault: [],
    });
    expect((await call).body.error?.code).toBe('browser_error');
    expect(typed()).toEqual([]);
  });

  it('binds credential approval to the original origin even if another allowed origin replaces it', async () => {
    await app.vault.setCredentialPolicy(credentialId, 'ask');
    const call = login();
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    app.browser.refs.set('e2', {
      role: 'textbox',
      name: 'DNI',
      inputType: 'text',
      frameUrl: 'https://www2.agenciatributaria.gob.es/login',
    });
    await app.invoke('chat.respond', app.pendingPrompt(procedureId)!.id, {
      kind: 'confirm',
      approved: true,
    });
    expect((await call).body.error?.code).toBe('browser_error');
    expect(typed()).toEqual([]);
  });

  it('fillFromUser: dismissing returns user_rejected', async () => {
    app.browser.refs.set('e6', {
      role: 'textbox',
      name: 'Código',
      inputType: 'text',
      frameUrl: CLAVE_LOGIN,
    });
    const call = app.rpc(
      'browser.fillFromUser',
      { ref: 'e6', title: 'Código', label: 'Código' },
      token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    await app.invoke('chat.respond', app.pendingPrompt(procedureId)!.id, {
      kind: 'form',
      dismissed: true,
      savedToVault: [],
    });
    expect((await call).body.error?.code).toBe('user_rejected');
    expect(typed()).toEqual([]);
  });

  it('forwards plain browser actions and maps failures to browser_error', async () => {
    const open = await app.rpc('browser.open', { url: 'https://sede.policia.gob.es/' }, token);
    expect(open.body.result.url).toBe('https://sede.policia.gob.es/');
    expect(
      (await app.rpc('browser.open', { url: 'file:///etc/passwd' }, token)).body.error?.code,
    ).toBe('policy_denied');
    expect((await app.rpc('browser.click', { ref: 'e1' }, token)).body.ok).toBe(true);
    expect(
      (await app.rpc('browser.tabs', { action: 'list' }, token)).body.result.tabs,
    ).toHaveLength(1);
    const shot = await app.rpc('browser.screenshot', {}, token);
    expect(shot.body.result).toEqual({ mimeType: 'image/jpeg', dataBase64: '/9j/2Q==' });
    app.browser.click = async () => {
      throw new Error('Timeout 30000ms exceeded');
    };
    expect((await app.rpc('browser.click', { ref: 'e1' }, token)).body.error).toEqual({
      code: 'browser_error',
      message: 'Timeout 30000ms exceeded',
    });
    expect((await app.rpc('browser.close', {}, token)).body.result).toEqual({ closed: true });
  });

  it('uploads vault documents', async () => {
    const doc = await app.vault.addDocument({
      name: 'dni.pdf',
      mimeType: 'application/pdf',
      source: 'user',
      bytes: Buffer.from('%PDF'),
    });
    const res = await app.rpc('browser.upload', { ref: 'e9', documentIds: [doc.id] }, token);
    expect(res.body.ok).toBe(true);
    const call = app.browser.calls.find((c) => c.method === 'upload');
    expect(call?.args[1]).toEqual([
      { name: 'dni.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') },
    ]);
    expect(
      (await app.rpc('browser.upload', { ref: 'e9', documentIds: ['d_nope'] }, token)).body.error
        ?.code,
    ).toBe('not_found');
  });
});

describe('bridge: client certificates', () => {
  it('keeps the app usable and explains missing sidecar support before asking for approval', async () => {
    await app.close();
    app = await createTestApp({
      startSidecar: async () => {
        throw new Error('missing helper');
      },
    });
    const session = await app.procedureWithToken();
    const dnie = await app.invoke('vault.addDnie');
    const response = await app.rpc(
      'browser.useCertificate',
      { credentialId: dnie.id },
      session.token,
    );
    expect(response.body.error?.message).toContain('sa-sidecar');
    expect(app.pendingPrompt(session.procedureId)).toBeUndefined();
    const opened = await app.rpc('browser.open', { url: 'https://example.gob.es' }, session.token);
    expect(opened.body.error).toBeUndefined();
  });

  let certId: string;
  beforeEach(async () => {
    certId = (
      await app.vault.addCertificate({
        fileName: 'fnmt.p12',
        p12: readFileSync(
          new URL(
            '../../../../../packages/browser/test/fixtures/certs/rsa-legacy.p12',
            import.meta.url,
          ),
        ),
        passphrase: 'test',
      })
    ).id;
  });

  it('asks (default policy) and then enables the certificate for known + requested official origins', async () => {
    const call = app.rpc(
      'browser.useCertificate',
      { credentialId: certId, origins: ['https://www1.agenciatributaria.gob.es/wlpl/OVCT-CXEW/x'] },
      token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const prompt = app.pendingPrompt(procedureId)!;
    expect(prompt.prompt).toMatchObject({ kind: 'confirm', confirmKind: 'credential' });
    await app.invoke('chat.respond', prompt.id, { kind: 'confirm', approved: true });
    const res = await call;
    expect(res.body.result).toMatchObject({
      enabled: true,
      origins: ['https://pasarela-ident.clave.gob.es', 'https://www1.agenciatributaria.gob.es'],
    });
    expect(app.browser.certificates.map((c) => c.origin)).toEqual([
      'https://pasarela-ident.clave.gob.es',
      'https://www1.agenciatributaria.gob.es',
    ]);
    expect(JSON.stringify(res.body)).not.toContain('pw-123');
  });

  it('refuses non-official origins and non-certificate credentials', async () => {
    const res = await app.rpc(
      'browser.useCertificate',
      { credentialId: certId, origins: ['https://agenciatributaria.gob.es.evil.example'] },
      token,
    );
    expect(res.body.error?.code).toBe('policy_denied');
    const clave = await app.vault.addClave({ username: 'u', password: 'p' });
    const wrong = await app.rpc('browser.useCertificate', { credentialId: clave.id }, token);
    expect(wrong.body.error?.code).toBe('bad_request');
    expect(app.browser.certificates).toEqual([]);
  });

  const SEDE = 'https://rocafort.sede.dival.example';
  const SOURCES = [
    'https://www.rocafort.es/sede',
    'https://www.dival.es/sedes',
    'https://administracion.gob.es/rocafort',
  ];

  it('tells the agent how to ask the user about an unlisted site, but never for a host no sede uses', async () => {
    const unlisted = await app.rpc(
      'browser.useCertificate',
      { credentialId: certId, origins: [SEDE] },
      token,
    );
    expect(unlisted.body.error?.code).toBe('policy_denied');
    expect(unlisted.body.error?.message).toContain('certificate_site');
    expect(unlisted.body.error?.message).toContain(SEDE);
    for (const origin of ['https://10.0.0.1', 'https://intranet', 'https://xn--sede-9qa.es']) {
      const blocked = await app.rpc(
        'browser.useCertificate',
        { credentialId: certId, origins: [origin] },
        token,
      );
      expect(blocked.body.error?.code, origin).toBe('policy_denied');
      expect(blocked.body.error?.message, origin).not.toContain('certificate_site');
    }
    const ask = await app.rpc(
      'prompt.confirm',
      {
        confirmKind: 'certificate_site',
        title: 't',
        message: 'm',
        site: 'https://10.0.0.1',
        sources: SOURCES,
      },
      token,
    );
    expect(ask.body.error?.code).toBe('policy_denied');
    const fewSources = await app.rpc(
      'prompt.confirm',
      {
        confirmKind: 'certificate_site',
        title: 't',
        message: 'm',
        site: SEDE,
        sources: SOURCES.slice(1),
      },
      token,
    );
    expect(fewSources.body.error?.code).toBe('bad_request');
    expect(app.pendingPrompt(procedureId)).toBeUndefined();
  });

  it('allows an unlisted site for this procedure only once the user approves it', async () => {
    const ask = app.rpc(
      'prompt.confirm',
      {
        confirmKind: 'certificate_site',
        title: 'Agent title',
        message: 'The town hall website links to it.',
        site: `${SEDE}/login`,
        sources: SOURCES,
      },
      token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const prompt = app.pendingPrompt(procedureId)!;
    expect(prompt.prompt).toMatchObject({ kind: 'confirm', confirmKind: 'certificate_site' });
    if (prompt.prompt.kind !== 'confirm') throw new Error('expected a confirm prompt');
    expect(prompt.prompt.title).toContain('rocafort.sede.dival.example');
    expect(prompt.prompt.title).not.toContain('Agent title');
    expect(prompt.prompt.message).toContain('The town hall website links to it.');
    expect(prompt.prompt.details?.map((d) => d.value)).toEqual([SEDE, ...SOURCES]);
    await app.invoke('chat.respond', prompt.id, { kind: 'confirm', approved: true });
    expect((await ask).body.result).toMatchObject({ approved: true });

    const call = app.rpc(
      'browser.useCertificate',
      { credentialId: certId, origins: [SEDE] },
      token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const credentialPrompt = app.pendingPrompt(procedureId)!;
    expect(credentialPrompt.prompt).toMatchObject({ confirmKind: 'credential' });
    await app.invoke('chat.respond', credentialPrompt.id, { kind: 'confirm', approved: true });
    expect((await call).body.result).toMatchObject({ enabled: true });
    expect(app.browser.certificates.map((c) => c.origin)).toContain(SEDE);

    const other = await app.procedureWithToken();
    const elsewhere = await app.rpc(
      'browser.useCertificate',
      { credentialId: certId, origins: [SEDE] },
      other.token,
    );
    expect(elsewhere.body.error?.code).toBe('policy_denied');
  });

  it('keeps refusing a site the user did not allow', async () => {
    const ask = app.rpc(
      'prompt.confirm',
      { confirmKind: 'certificate_site', title: 't', message: 'm', site: SEDE, sources: SOURCES },
      token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    await app.invoke('chat.respond', app.pendingPrompt(procedureId)!.id, {
      kind: 'confirm',
      approved: false,
    });
    expect((await ask).body.result).toMatchObject({ approved: false });
    const res = await app.rpc(
      'browser.useCertificate',
      { credentialId: certId, origins: [SEDE] },
      token,
    );
    expect(res.body.error?.code).toBe('policy_denied');
  });
});

describe('bridge: Touch ID', () => {
  it('requires biometric confirmation when available', async () => {
    await app.close();
    let prompts = 0;
    app = await createTestApp({
      biometric: {
        available: () => true,
        prompt: async () => {
          prompts++;
          return false;
        },
      },
    });
    ({ procedureId, token } = await app.procedureWithToken());
    const cert = await app.vault.addCertificate({
      fileName: 'a.p12',
      p12: Buffer.from('x'),
      passphrase: 'pw',
    });
    const call = app.rpc('browser.useCertificate', { credentialId: cert.id }, token);
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const prompt = app.pendingPrompt(procedureId)!;
    expect(prompt.prompt).toMatchObject({ biometric: true });
    await app.invoke('chat.respond', prompt.id, { kind: 'confirm', approved: true });
    expect((await call).body.error?.code).toBe('user_rejected');
    expect(prompts).toBe(1);
    expect(app.browser.certificates).toEqual([]);
  });

  it('does not ask for it to log in with the DNIe: the phone and the card are the second factor', async () => {
    await app.close();
    let prompts = 0;
    app = await createTestApp({
      biometric: {
        available: () => true,
        prompt: async () => {
          prompts++;
          return false;
        },
      },
    });
    ({ procedureId, token } = await app.procedureWithToken());
    const dnie = await app.vault.addDnie();
    const call = app.rpc(
      'browser.useCertificate',
      { credentialId: dnie.id, origins: ['https://sede.seg-social.gob.es'] },
      token,
    );
    await app.waitFor(() => !!app.pendingPrompt(procedureId));
    const prompt = app.pendingPrompt(procedureId)!;
    expect(prompt.prompt).toMatchObject({ biometric: false });
    await app.invoke('chat.respond', prompt.id, { kind: 'confirm', approved: true });
    // No paired phone here: the login stops after the consent, never at Touch ID.
    expect((await call).body.error?.code).not.toBe('user_rejected');
    expect(prompts).toBe(0);
  });
});

describe('bridge: personal select fields in forms', () => {
  it('shows marital status as a select of the vault options', () => {
    const [status, since] = withPersonalOptions(
      [
        {
          key: 'estado',
          label: 'Estado civil',
          type: 'text',
          required: true,
          vaultKey: 'maritalStatus',
          defaultValue: 'Casada',
        },
        {
          key: 'boda',
          label: 'Fecha de la boda',
          type: 'date',
          required: true,
          visibleWhen: { field: 'estado', values: ['casado'] },
        },
      ],
      'es',
    );
    expect(status).toMatchObject({ type: 'select', defaultValue: 'married' });
    expect(status?.options?.map((o) => o.value)).toEqual([
      'single',
      'married',
      'separated',
      'divorced',
      'widowed',
    ]);
    expect(status?.options?.[0]?.label).toBe('Soltero/a');
    expect(since?.visibleWhen?.values).toEqual(['married']);
  });
});
