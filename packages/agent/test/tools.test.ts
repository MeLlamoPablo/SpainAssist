import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeParams, type BrowserObservation, type Procedure } from '@sa/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pagesToShow } from '../src/tools/documents';
import { TOOL_NAMES } from '../src/tools/names';
import { createFakeBridge, type FakeBridge, FakeBridgeError, hang } from './helpers/fake-bridge';
import { makePdf } from './helpers/pdf';
import { FIXTURES, type ToolHarness, textOf, toolHarness } from './helpers/tools';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** A page with a black bar and no text layer, like a scanned page. */
const SCANNED_PAGE = { drawing: '0 0 0 rg 72 600 300 40 re f' };

function contentTypes(result: { content: { type: string }[] }): string[] {
  return result.content.map((c) => c.type);
}

const observation: BrowserObservation = {
  url: 'https://sede.policia.gob.es/tramite',
  title: 'Sede electrónica',
  snapshot: '- heading "Cita previa" [ref=e1]\n- button "Entrar" [ref=e2]',
  truncated: false,
  tabs: [
    {
      index: 0,
      url: 'https://sede.policia.gob.es/tramite',
      title: 'Sede electrónica',
      active: true,
    },
    { index: 1, url: 'https://example.com/', title: 'Otra', active: false },
  ],
  downloads: [{ downloadId: 'dl_1', name: 'justificante.pdf', mimeType: 'application/pdf' }],
  signatures: [{ status: 'signed', format: 'CAdES', origin: 'https://sede.policia.gob.es' }],
  dialogs: ['alert "Sesión caducada" (accepted)'],
  pageErrors: [],
  notes: ['Client certificate requested by sede.policia.gob.es'],
  imageId: 'img_1',
};

function procedure(patch: Partial<Procedure>): Procedure {
  return {
    id: 'p1',
    title: 'Renovar el DNI',
    status: 'researching',
    steps: [],
    requirements: [],
    facts: [],
    sources: [],
    createdAt: '2026-10-03T00:00:00Z',
    updatedAt: '2026-10-03T00:00:00Z',
    archived: false,
    ...patch,
  };
}

describe('tools', () => {
  let bridge: FakeBridge;
  let h: ToolHarness;

  beforeEach(async () => {
    bridge = await createFakeBridge();
    h = toolHarness(bridge);
  });
  afterEach(async () => {
    await bridge.close();
  });

  it('registers exactly the documented tools with descriptions and object schemas', () => {
    expect(h.tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const tool of h.tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect((tool.parameters as { type?: string }).type).toBe('object');
    }
  });

  describe('procedure_update', () => {
    it('sends complete arrays, defaults requirement status and renders the card', async () => {
      bridge.setHandler('procedure.update', (params) =>
        procedure({
          status: 'researching',
          steps: params.steps as Procedure['steps'],
          requirements: params.requirements as Procedure['requirements'],
          facts: params.facts as Procedure['facts'],
          sources: [{ title: 'Cita previa', url: 'https://www.citapreviadnie.es/' }],
          nextAction: { text: 'Pedir cita', owner: 'user' },
        }),
      );
      const result = await h.run('procedure_update', {
        status: 'researching',
        steps: [{ id: 'cita', title: 'Pedir cita previa', status: 'current', owner: 'user' }],
        requirements: [{ id: 'foto', label: 'Foto reciente' }],
        facts: [{ label: 'Coste', value: '12 €' }],
        sources: [{ title: 'Cita previa', url: 'https://www.citapreviadnie.es/' }],
        nextAction: { text: 'Pedir cita', owner: 'user' },
      });
      const params = bridge.callsTo('procedure.update')[0]?.params;
      expect(params?.requirements).toEqual([
        { id: 'foto', label: 'Foto reciente', status: 'unknown' },
      ]);
      expect(params?.nextAction).toEqual({ text: 'Pedir cita', owner: 'user' });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain('Status: researching');
      expect(text).toContain('Pedir cita previa [current, user]');
      expect(text).toContain('Coste: 12 €');
      expect(text).toContain('Sources: 1');
    });

    it('passes an appointment through and shows it in the result', async () => {
      const nextAction = {
        text: 'Ir a la cita con tu DNI',
        owner: 'user' as const,
        appointment: { address: 'Calle Rafael Calvo 33, Madrid', startsAt: '2026-10-13T11:00' },
      };
      bridge.setHandler('procedure.update', () => procedure({ nextAction }));
      const result = await h.run('procedure_update', { nextAction });
      expect(bridge.callsTo('procedure.update')[0]?.params).toEqual({ nextAction });
      expect(textOf(result)).toContain(
        'Appointment: 2026-10-13T11:00 at Calle Rafael Calvo 33, Madrid',
      );
    });

    it('clears the next action and validates input before calling the app', async () => {
      bridge.setHandler('procedure.update', () => procedure({ status: 'done' }));
      await h.run('procedure_update', { status: 'done', clearNextAction: true });
      expect(bridge.callsTo('procedure.update')[0]?.params).toEqual({
        status: 'done',
        nextAction: null,
      });

      const empty = await h.run('procedure_update', {});
      expect(empty.isError).toBe(true);
      const badUrl = await h.run('procedure_update', {
        sources: [{ title: 'x', url: 'not a url' }],
      });
      expect(badUrl.isError).toBe(true);
      expect(bridge.callsTo('procedure.update')).toHaveLength(1);
    });
  });

  describe('ask_user / confirm_action / request_user_action', () => {
    it('never offers the DNI CAN as a personal-data key', () => {
      const tools = JSON.stringify(h.tools.map((t) => [t.description, t.parameters]));
      expect(tools).toContain('dniIssuingTeam');
      expect(tools).not.toContain('dniAccessNumber');
      expect(tools).not.toMatch(/\bCAN\b/);
    });

    it('offers no way to read, type, save or ask for the DNI PIN', async () => {
      const tools = JSON.stringify(h.tools.map((t) => [t.description, t.parameters]));
      expect(tools).not.toMatch(/dniePin|DNI PIN|PIN del DNI/i);
      // Only the Cl@ve Permanente is typed from a credential: its DNI/NIE and password.
      expect(
        BridgeParams['browser.fillFromVault'].safeParse({ ref: 'e1', credentialId: 'cred_dnie' })
          .success,
      ).toBe(false);
      // The app refuses PIN keys; the agent hears its safety policy, never the value.
      bridge.setHandler('vault.save', () => {
        throw new FakeBridgeError('policy_denied', 'PINs are secrets, not personal data', 403);
      });
      const saved = await h.run('vault_save', {
        items: [{ key: 'custom.pin_dnie', label: 'PIN', value: '12345678' }],
      });
      expect(saved.isError).toBe(true);
      expect(textOf(saved)).toContain("Blocked by the app's safety policy");
      expect(textOf(saved)).not.toContain('12345678');
    });

    it('passes map places through the bridge and rejects options without an address', async () => {
      bridge.setHandler('prompt.form', () => ({
        dismissed: false,
        values: { centre: 'demo' },
        savedToVault: [],
      }));
      const options = [{ value: 'demo', label: 'Demo centre', address: 'Demo street 10' }];
      const result = await h.run('ask_user', {
        title: 'Choose a centre',
        fields: [{ key: 'centre', label: 'Centre', type: 'map-options', options }],
      });
      expect(result.isError).toBeFalsy();
      expect(bridge.callsTo('prompt.form')[0].params.fields).toEqual([
        { key: 'centre', label: 'Centre', type: 'map-options', options, required: true },
      ]);
      const named = await h.run('ask_user', {
        title: 'Choose',
        fields: [
          {
            key: 'centre',
            label: 'Centre',
            type: 'map-options',
            options: [{ value: 'demo', label: 'Demo' }],
          },
        ],
      });
      expect(named.isError).toBe(true);
      expect(bridge.callsTo('prompt.form')).toHaveLength(1);
    });

    it('offers appointment slots in order and relays a request for more', async () => {
      bridge.setHandler('prompt.form', () => ({
        dismissed: false,
        values: { cita: 'more' },
        savedToVault: [],
      }));
      const result = await h.run('ask_user', {
        title: 'Elige tu cita',
        fields: [
          {
            key: 'cita',
            label: 'Cita',
            type: 'appointment',
            slots: ['2026-10-20T19:00', '2026-10-19T09:00', '2026-10-20T19:00'],
          },
        ],
      });
      expect(bridge.callsTo('prompt.form')[0].params.fields).toMatchObject([
        { slots: ['2026-10-19T09:00', '2026-10-20T19:00'] },
      ]);
      expect(textOf(result)).toContain('asked for more options');
      const empty = await h.run('ask_user', {
        title: 'Elige tu cita',
        fields: [{ key: 'cita', label: 'Cita', type: 'appointment' }],
      });
      expect(empty.isError).toBe(true);
      expect(bridge.callsTo('prompt.form')).toHaveLength(1);
    });

    it('asks with a native form and returns the answers', async () => {
      bridge.setHandler('prompt.form', () => ({
        kind: 'form',
        values: { addressProvince: 'Madrid', notify: true, docs: ['a', 'b'] },
        dismissed: false,
        savedToVault: ['addressProvince'],
      }));
      const result = await h.run('ask_user', {
        title: 'Datos para la cita',
        fields: [
          {
            key: 'addressProvince',
            label: '¿Provincia?',
            type: 'text',
            vaultKey: 'addressProvince',
          },
          { key: 'notify', label: '¿Avisarte?', type: 'boolean', required: false },
          {
            key: 'docs',
            label: 'Documentos',
            type: 'multiselect',
            options: [{ value: 'a', label: 'A' }],
          },
        ],
      });
      const params = bridge.callsTo('prompt.form')[0]?.params as {
        fields: { required: boolean; type: string }[];
        allowDismiss: boolean;
      };
      expect(params.fields.map((f) => f.required)).toEqual([true, false, true]);
      // A province asked as free text becomes the native province dropdown.
      expect(params.fields[0]?.type).toBe('province');
      // Questions never block the conversation: there is nothing to skip.
      expect(params.allowDismiss).toBe(false);
      const text = textOf(result);
      expect(text).toContain('¿Provincia? (addressProvince): Madrid');
      expect(text).toContain('¿Avisarte? (notify): yes');
      expect(text).toContain('Documentos (docs): a, b');
      expect(text).toContain('Saved to their data: addressProvince');
    });

    it('tells the agent which answers could not be saved', async () => {
      bridge.setHandler('prompt.form', () => ({
        kind: 'form',
        values: { authority: 'Madrid' },
        dismissed: false,
        savedToVault: [],
        vaultErrors: [{ key: 'custom.passport_issuer', reason: 'label_required' }],
      }));
      const result = await h.run('ask_user', {
        title: 'x',
        fields: [{ key: 'authority', label: 'Autoridad', type: 'text' }],
      });
      expect(textOf(result)).toContain(
        'Could not save to their data (the answers above are still valid): custom.passport_issuer (label_required).',
      );
    });

    it('reports dismissed forms and rejects selects without options', async () => {
      bridge.setHandler('prompt.form', () => ({ kind: 'form', dismissed: true, savedToVault: [] }));
      const dismissed = await h.run('ask_user', {
        title: 'x',
        fields: [{ key: 'a', label: 'A', type: 'text' }],
      });
      expect(textOf(dismissed)).toContain('dismissed');
      const invalid = await h.run('ask_user', {
        title: 'x',
        fields: [{ key: 'a', label: 'A', type: 'select' }],
      });
      expect(invalid.isError).toBe(true);
    });

    it('passes conditional rules to the form and rejects invalid references', async () => {
      bridge.setHandler('prompt.form', () => ({
        kind: 'form',
        values: { access: 'clave' },
        dismissed: false,
        savedToVault: [],
      }));
      const fields = [
        {
          key: 'access',
          label: 'Acceso',
          type: 'select',
          options: [
            { value: 'sms', label: 'SMS' },
            { value: 'clave', label: 'Cl@ve' },
          ],
        },
        {
          key: 'phone',
          label: 'Móvil',
          type: 'phone',
          visibleWhen: { field: 'access', values: ['sms'] },
        },
      ];
      await h.run('ask_user', { title: 'Acceso', fields });
      expect(bridge.callsTo('prompt.form')[0]?.params).toMatchObject({
        fields: [
          { key: 'access' },
          { key: 'phone', required: true, visibleWhen: { field: 'access', values: ['sms'] } },
        ],
      });
      const result = await h.run('ask_user', {
        title: 'Acceso',
        fields: [fields[0], { ...fields[1], visibleWhen: { field: 'missing', values: ['sms'] } }],
      });
      expect(result.isError).toBe(true);
      expect(bridge.callsTo('prompt.form')).toHaveLength(1);
    });

    it('asks for approval before irreversible actions', async () => {
      bridge.setHandler('prompt.confirm', (params) => ({
        kind: 'confirm',
        approved: params.title === 'Enviar',
      }));
      const approved = await h.run('confirm_action', {
        confirmKind: 'submission',
        title: 'Enviar',
        message: 'Voy a enviar la solicitud a la Policía.',
        details: [{ label: 'Oficina', value: 'Madrid' }],
      });
      expect(textOf(approved)).toContain('approved');
      expect(approved.details).toEqual({ approved: true });
      const declined = await h.run('confirm_action', {
        confirmKind: 'payment',
        title: 'Pagar',
        message: 'Pagar 12 €',
      });
      expect(textOf(declined)).toContain('did NOT approve');
    });

    it('maps user_rejected errors to a clear instruction', async () => {
      bridge.setHandler('prompt.confirm', () => {
        throw new FakeBridgeError('user_rejected', 'Cancelled by the user');
      });
      const result = await h.run('confirm_action', {
        confirmKind: 'action',
        title: 'x',
        message: 'y',
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('The user declined');
    });

    it('requests manual actions and defaults showBrowser', async () => {
      bridge.setHandler('prompt.userAction', () => ({
        kind: 'user_action',
        done: true,
        note: 'hecho',
      }));
      const result = await h.run('request_user_action', {
        actionKind: 'captcha',
        title: 'Resuelve el captcha',
        message: 'En la ventana del navegador.',
      });
      expect(bridge.callsTo('prompt.userAction')[0]?.params).toMatchObject({
        showBrowser: true,
        attachScreenshot: false,
      });
      expect(textOf(result)).toContain('done');
      expect(textOf(result)).toContain('hecho');
    });

    it('logs in with Cl@ve Permanente in one call, the app asking for what is missing', async () => {
      bridge.setHandler('browser.loginClave', () => observation);
      await h.run('browser_login_clave', {
        usernameRef: 'e4',
        passwordRef: 'e5',
        message: 'La necesito para entrar en la Seguridad Social.',
      });
      await h.run('browser_login_clave', { usernameRef: 'e4', passwordRef: 'e5', rejected: true });
      expect(bridge.callsTo('browser.loginClave').map((c) => c.params)).toEqual([
        {
          usernameRef: 'e4',
          passwordRef: 'e5',
          rejected: false,
          message: 'La necesito para entrar en la Seguridad Social.',
        },
        { usernameRef: 'e4', passwordRef: 'e5', rejected: true },
      ]);
      const credential = JSON.stringify(
        h.tools.find((t) => t.name === 'request_credential')?.parameters,
      );
      expect(credential).not.toContain('clave_permanente');
    });

    it('asks for the DNI only with the phone app, and logs in with it', async () => {
      const credentialParam = (deps: Parameters<typeof toolHarness>[1]) =>
        JSON.stringify(
          toolHarness(bridge, deps).tools.find((t) => t.name === 'request_credential')?.parameters,
        );
      expect(credentialParam({ dniePhone: true })).toContain('dnie');
      expect(credentialParam({ dniePhone: false })).toBeUndefined();

      bridge.setHandler('prompt.credential', () => ({ kind: 'credential', credentialId: 'd1' }));
      const added = await toolHarness(bridge, { dniePhone: true }).run('request_credential', {
        credential: 'dnie',
        title: 'Añade tu DNI',
        message: 'La sede pide certificado.',
      });
      expect(textOf(added)).toContain('DNI as credential d1');
      expect(textOf(added)).toContain('browser_use_certificate');
    });

    describe('request_phone_call', () => {
      const emasesaCall = {
        title: 'Llama a EMASESA',
        organization: 'EMASESA · Atención al cliente',
        phoneNumber: '900 822 010',
        purpose: 'Saber cómo cambiar el número de personas que viven en la casa.',
        questions: ['¿Puede pedirlo el inquilino si el contrato está a nombre de la casera?'],
        haveAtHand: ['Número de contrato (en la factura)'],
      };

      it('asks the user to call and returns the outcome, transcript and notes', async () => {
        bridge.setHandler('prompt.phoneCall', () => ({
          kind: 'phone_call',
          outcome: 'done',
          transcript: 'Ellos: Necesitamos el padrón de todos.',
          notes: 'Hay que enviarlo por correo.',
        }));
        const result = await h.run('request_phone_call', emasesaCall);
        expect(bridge.callsTo('prompt.phoneCall')[0]?.params).toEqual(emasesaCall);
        expect(textOf(result)).toContain('The user made the call.');
        expect(textOf(result)).toContain('<transcript>\nEllos: Necesitamos el padrón de todos.\n');
        expect(textOf(result)).toContain('Hay que enviarlo por correo.');
      });

      it('says when the call was not recorded or did not happen', async () => {
        bridge.setHandler('prompt.phoneCall', () => ({ kind: 'phone_call', outcome: 'done' }));
        expect(textOf(await h.run('request_phone_call', emasesaCall))).toContain('not recorded');

        bridge.setHandler('prompt.phoneCall', () => ({
          kind: 'phone_call',
          outcome: 'unreachable',
        }));
        const unreachable = textOf(await h.run('request_phone_call', emasesaCall));
        expect(unreachable).toContain('could not reach them');
        expect(unreachable).not.toContain('not recorded');
      });

      it('rejects a phone number with letters without asking the user', async () => {
        const result = await h.run('request_phone_call', {
          ...emasesaCall,
          phoneNumber: 'EMASESA',
        });
        expect(result.isError).toBe(true);
        expect(bridge.callsTo('prompt.phoneCall')).toHaveLength(0);
      });
    });

    it('propagates aborts while waiting for the user', async () => {
      bridge.setHandler('prompt.form', hang);
      const controller = new AbortController();
      const pending = h.run(
        'ask_user',
        { title: 'x', fields: [{ key: 'a', label: 'A', type: 'text' }] },
        controller.signal,
      );
      const call = await bridge.waitForCall('prompt.form');
      controller.abort();
      await expect(pending).rejects.toThrow();
      await bridge.waitForAbort(call);
    });
  });

  describe('vault', () => {
    it('renders saved data without secrets', async () => {
      bridge.setHandler('vault.read', () => ({
        personal: [
          { key: 'givenName', label: 'Nombre', value: 'Ana' },
          { key: 'dniExpiry', label: 'Fecha de validez', value: '2031-05-12' },
          {
            key: 'drivingLicenceCategories',
            label: 'Categorías',
            value: JSON.stringify([
              { category: 'B', issueDate: '2010-03-04', expiry: '2030-03-04' },
            ]),
          },
          { key: 'custom.ref', label: 'Referencia', value: '2024-01-02' },
        ],
        documents: [
          {
            id: 'doc_1',
            name: 'dni.jpg',
            mimeType: 'image/jpeg',
            createdAt: '2026-09-01T10:00:00Z',
          },
        ],
        credentials: [
          {
            id: 'cred_1',
            kind: 'clave_permanente',
            label: 'Mi Cl@ve',
            policy: 'auto',
            usernameHint: '•••••678Z',
          },
          {
            id: 'cred_2',
            kind: 'certificate',
            label: 'FNMT',
            policy: 'ask',
            certificate: {
              holderName: 'ANA',
              issuer: 'AC FNMT Usuarios',
              validTo: '2027-01-01T00:00:00Z',
            },
          },
        ],
      }));
      const text = textOf(await h.run('vault_read', {}));
      expect(text).toContain('givenName (Nombre): Ana');
      expect(text).toContain('dniExpiry (Fecha de validez): 12/05/2031');
      expect(text).toContain('{"category":"B","issueDate":"04/03/2010","expiry":"04/03/2030"}');
      expect(text).toContain('custom.ref (Referencia): 2024-01-02');
      // Times are in Europe/Madrid by default.
      expect(text).toContain('doc_1: dni.jpg (image/jpeg, 01/09/2026 12:00:00)');
      expect(text).toContain('cred_1: clave_permanente "Mi Cl@ve"');
      expect(text).toContain('valid to 01/01/2027 01:00:00');
    });

    it("renders times in the user's time zone", async () => {
      bridge.setHandler('vault.read', () => ({
        personal: [],
        documents: [
          {
            id: 'doc_1',
            name: 'a.pdf',
            mimeType: 'application/pdf',
            createdAt: '2026-09-01T10:05:09Z',
          },
        ],
        credentials: [],
      }));
      const text = textOf(await toolHarness(bridge, { timeZone: 'UTC' }).run('vault_read', {}));
      expect(text).toContain('a.pdf (application/pdf, 01/09/2026 10:05:09)');
    });

    it('saves data and requires labels for custom keys', async () => {
      bridge.setHandler('vault.save', (params) => ({
        saved: (params.items as { key: string }[]).map((i) => i.key),
      }));
      const saved = await h.run('vault_save', { items: [{ key: 'phone', value: '600000000' }] });
      expect(textOf(saved)).toBe('Saved: phone.');
      const invalid = await h.run('vault_save', { items: [{ key: 'custom.colegio', value: 'x' }] });
      expect(invalid.isError).toBe(true);
    });

    it('saves temporary downloads to the vault', async () => {
      bridge.setHandler('downloads.save', (params) => ({
        documentId: 'doc_1',
        name: `${params.name}.pdf`,
      }));
      const result = await h.run('download_save', {
        downloadId: 'dl_1',
        name: 'Justificante de cita - DNI',
      });
      expect(textOf(result)).toBe(
        'Saved to the user\'s documents as "Justificante de cita - DNI.pdf" (id doc_1).',
      );
    });
  });

  describe('document_read', () => {
    function saveDocument(name: string, mimeType: string, bytes: Buffer) {
      bridge.setHandler('vault.document', (params) => ({
        id: params.documentId,
        name,
        mimeType,
        dataBase64: bytes.toString('base64'),
      }));
    }

    it('reads a saved PDF as text and every page as an image', async () => {
      saveDocument(
        'tasas.pdf',
        'application/pdf',
        readFileSync(join(FIXTURES, 'pdf', 'tasas.pdf')),
      );
      const result = await h.run('document_read', { documentId: 'doc_1' });
      const text = textOf(result);
      expect(text).toContain('Document: tasas.pdf (application/pdf, id doc_1)');
      expect(text).toContain('Type: PDF, 2 pages');
      expect(text).toContain('Renovación: 12,00 euros');
      expect(text).toContain('Page 1 as an image');
      expect(text).toContain('Page 2 as an image');
      expect(contentTypes(result).filter((t) => t === 'image')).toHaveLength(2);
      expect(bridge.callsTo('vault.document')[0]?.params).toEqual({ documentId: 'doc_1' });
    });

    it('shows scanned PDF pages as images', async () => {
      saveDocument('padron.pdf', 'application/pdf', Buffer.from(makePdf([SCANNED_PAGE])));
      const result = await h.run('document_read', { documentId: 'doc_1' });
      expect(textOf(result)).toContain('This PDF has no text layer (scanned pages).');
      expect(textOf(result)).toContain('Page 1 as an image');
      expect(contentTypes(result)).toEqual(['text', 'text', 'image']);
    });

    it('shows the PDF pages the agent asks for as images', async () => {
      saveDocument(
        'tasas.pdf',
        'application/pdf',
        readFileSync(join(FIXTURES, 'pdf', 'tasas.pdf')),
      );
      const result = await h.run('document_read', { documentId: 'doc_1', offset: 10, pages: [2] });
      expect(textOf(result)).toContain('Page 2 as an image');
      expect(contentTypes(result).filter((t) => t === 'image')).toHaveLength(1);
    });

    it('says when the model cannot see the PDF pages as images', async () => {
      saveDocument('padron.pdf', 'application/pdf', Buffer.from(makePdf([SCANNED_PAGE])));
      const blind = toolHarness(bridge, { imagesSupported: false });
      const result = await blind.run('document_read', { documentId: 'doc_1' });
      expect(textOf(result)).toContain('This model cannot see images');
      expect(contentTypes(result)).not.toContain('image');
    });

    it('limits page images per call and lists the rest', () => {
      expect(pagesToShow(7, undefined, 0)).toEqual({ show: [1, 2, 3, 4, 5], more: [6, 7] });
      expect(pagesToShow(7, [7], 1000)).toEqual({ show: [7], more: [] });
    });

    it('shows only the requested pages, even at offset 0', () => {
      expect(pagesToShow(8, undefined, 0)).toEqual({ show: [1, 2, 3, 4, 5], more: [6, 7, 8] });
      expect(pagesToShow(8, [8, 6, 7, 6], 0)).toEqual({ show: [6, 7, 8], more: [] });
      expect(pagesToShow(8, [0, 3, 9], 0)).toEqual({ show: [3], more: [] });
      expect(pagesToShow(8, [9], 0)).toEqual({ show: [], more: [] });
      expect(pagesToShow(8, undefined, 1000)).toEqual({ show: [], more: [] });
    });

    it('pages long text files with offset', async () => {
      saveDocument('notas.txt', 'text/plain', Buffer.from('a'.repeat(1500)));
      const first = textOf(await h.run('document_read', { documentId: 'doc_1', maxChars: 1000 }));
      expect(first).toContain('More: call document_read again with offset 1000.');
      const rest = textOf(await h.run('document_read', { documentId: 'doc_1', offset: 1000 }));
      expect(rest).toContain('Characters 1000–1500 of 1500.');
    });

    it('returns photos as an image only when the model can see images', async () => {
      saveDocument('dni.png', 'image/png', ONE_PIXEL_PNG);
      const result = await h.run('document_read', { documentId: 'doc_1' });
      expect(result.content.map((c) => c.type)).toEqual(['text', 'image']);

      const blind = toolHarness(bridge, { imagesSupported: false });
      const refused = await blind.run('document_read', { documentId: 'doc_1' });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain('cannot see images');
    });

    it('refuses file types it cannot read', async () => {
      saveDocument('cert.p12', 'application/x-pkcs12', Buffer.from('binary'));
      const result = await h.run('document_read', { documentId: 'doc_1' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Cannot read application/x-pkcs12 files');
    });
  });

  describe('browser', () => {
    it('renders observations compactly with refs last and no images', async () => {
      bridge.setHandler('browser.open', () => observation);
      const result = await h.run('browser_open', { url: 'https://sede.policia.gob.es/tramite' });
      const text = textOf(result);
      expect(text.split('\n').slice(0, 2)).toEqual([
        'URL: https://sede.policia.gob.es/tramite',
        'Title: Sede electrónica',
      ]);
      expect(text).toContain('[1] Otra — https://example.com/');
      expect(text).toContain('justificante.pdf (application/pdf, downloadId dl_1)');
      expect(text).toContain('download_save');
      expect(text).toContain('signed CAdES');
      expect(text).toContain('Sesión caducada');
      expect(text).toContain('Client certificate requested');
      expect(text.endsWith('- button "Entrar" [ref=e2]')).toBe(true);
      expect(result.content.every((c) => c.type === 'text')).toBe(true);
      expect(result.details).toMatchObject({
        page: true,
        imageId: 'img_1',
        downloads: ['dl_1'],
      });
      expect(bridge.callsTo('browser.open')[0]?.params).toEqual({
        url: 'https://sede.policia.gob.es/tramite',
        newTab: false,
      });
    });

    it('fills vault values by reference only', async () => {
      bridge.setHandler('browser.fillFromVault', () => observation);
      await h.run('browser_fill_from_vault', { ref: 'e6', key: 'dniNumber', submit: true });
      expect(bridge.callsTo('browser.fillFromVault').map((c) => c.params)).toEqual([
        { ref: 'e6', key: 'dniNumber', submit: true },
      ]);
    });

    it('explains policy and browser errors', async () => {
      bridge.setHandler('browser.loginClave', () => {
        throw new FakeBridgeError('policy_denied', 'evil.example is not allowed for Cl@ve', 403);
      });
      bridge.setHandler('browser.click', () => {
        throw new FakeBridgeError('browser_error', 'Ref e9 not found', 400);
      });
      const denied = await h.run('browser_login_clave', { usernameRef: 'e1', passwordRef: 'e2' });
      expect(textOf(denied)).toContain("Blocked by the app's safety policy");
      const clicked = await h.run('browser_click', { ref: 'e9' });
      expect(clicked.isError).toBe(true);
      expect(textOf(clicked)).toContain('browser_snapshot');
    });

    it('asks the user for one-time codes through the app', async () => {
      bridge.setHandler('browser.fillFromUser', () => observation);
      await h.run('browser_fill_from_user', { ref: 'e3', title: 'Código SMS', label: 'Código' });
      expect(bridge.callsTo('browser.fillFromUser')[0]?.params).toEqual({
        ref: 'e3',
        title: 'Código SMS',
        label: 'Código',
        submit: false,
      });
    });

    it('returns screenshots as image blocks, unless the model cannot see images', async () => {
      bridge.setHandler('browser.screenshot', () => ({
        mimeType: 'image/png',
        dataBase64: 'iVBORw0KGgo=',
      }));
      const shot = await h.run('browser_screenshot', {});
      expect(shot.content[1]).toEqual({
        type: 'image',
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
      });
      expect(shot.details).toEqual({ page: true, mimeType: 'image/png' });

      const blind = toolHarness(bridge, { imagesSupported: false });
      const refused = await blind.run('browser_screenshot', {});
      expect(refused.isError).toBe(true);
      expect(bridge.callsTo('browser.screenshot')).toHaveLength(1);
    });

    it('handles tabs, certificates and closing', async () => {
      bridge.setHandler('browser.tabs', () => ({ tabs: observation.tabs }));
      bridge.setHandler('browser.useCertificate', () => ({
        enabled: true,
        origins: ['https://sede.policia.gob.es'],
      }));
      bridge.setHandler('browser.close', () => ({ closed: true }));
      expect(textOf(await h.run('browser_tabs', { action: 'list' }))).toContain('[0] (active)');
      expect((await h.run('browser_tabs', { action: 'select' })).isError).toBe(true);
      expect(textOf(await h.run('browser_use_certificate', { credentialId: 'cred_2' }))).toContain(
        'Certificate login enabled',
      );
      expect(textOf(await h.run('browser_close', {}))).toBe('Browser closed.');
    });
  });

  describe('certificate logins', () => {
    const description = (deps: Parameters<typeof toolHarness>[1]) =>
      toolHarness(bridge, deps).tools.find((t) => t.name === 'browser_use_certificate')
        ?.description;

    it('offers the DNI in the paired phone only with its feature flag', () => {
      expect(description({ dniePhone: true })).toContain('or DNI in the paired phone');
      expect(description({ dniePhone: false })).not.toContain('DNI');
      expect(description({ dniePhone: false })).toContain("the user's digital certificate");
    });
  });

  describe('research over the bridge', () => {
    it('has no feedback tools without a feedback server', () => {
      const names = toolHarness(bridge, { feedback: undefined }).tools.map((t) => t.name);
      expect(names).not.toContain('feedback_search');
      expect(names).not.toContain('feedback_submit');
      expect(names).not.toContain('feedback_vote');
      expect(names).toContain('boe_search');
    });

    it('only searches community learnings when sharing and rating them are off', () => {
      const names = toolHarness(bridge, { feedback: { submit: false, vote: false } }).tools.map(
        (t) => t.name,
      );
      expect(names).toContain('feedback_search');
      expect(names).not.toContain('feedback_submit');
      expect(names).not.toContain('feedback_vote');
    });

    it('rates community learnings when sharing them is off', () => {
      const names = toolHarness(bridge, { feedback: { submit: false, vote: true } }).tools.map(
        (t) => t.name,
      );
      expect(names).toContain('feedback_vote');
      expect(names).not.toContain('feedback_submit');
    });

    it('searches and shares community learnings', async () => {
      bridge.setHandler('feedback.search', () => ({
        results: [
          {
            id: 'f1',
            procedure: 'Renovación del DNI',
            kind: 'gotcha',
            title: 'Las citas salen a las 8:00',
            body: `Conviene mirar temprano.\n\n\`\`\`js\nconst PROVINCIA = 'Sevilla';\n\`\`\`\n${'Detalle. '.repeat(100)}`,
            tags: [],
            urls: [],
            author: 'gpt-6-luna · high',
            createdAt: '2026-09-20T00:00:00Z',
            votes: 3,
          },
        ],
      }));
      bridge.setHandler('feedback.submit', () => ({ submitted: true, id: 'f2', redactions: 1 }));
      const found = textOf(await h.run('feedback_search', { query: 'dni cita' }));
      const [header, ...json] = found.split('\n');
      expect(header).toBe('Community learnings for "dni cita" (unverified hints), verbatim:');
      // Verbatim: long bodies are not clipped and keep their line breaks (code in learnings).
      const [entry] = JSON.parse(json.join('\n'));
      expect(entry).toMatchObject({ id: 'f1', kind: 'gotcha', author: 'gpt-6-luna · high' });
      expect(entry.body).toContain("```js\nconst PROVINCIA = 'Sevilla';\n```");
      expect(entry.body.length).toBeGreaterThan(900);
      const shared = await h.run('feedback_submit', {
        procedure: 'Renovación del DNI',
        kind: 'tip',
        title: 'Mira las citas temprano',
        body: 'Las citas nuevas aparecen a primera hora.',
      });
      expect(textOf(shared)).toContain('1 personal details were removed');
    });

    it('rates community learnings', async () => {
      const votes: unknown[] = [];
      bridge.setHandler('feedback.vote', (params) => {
        votes.push(params);
        return votes.length === 1
          ? { counted: true }
          : { counted: false, reason: 'You already gave this learning the same rating.' };
      });
      expect(textOf(await h.run('feedback_vote', { id: 'f1', vote: 'up' }))).toBe(
        'Vote recorded, thank you.',
      );
      expect(textOf(await h.run('feedback_vote', { id: 'f1', vote: 'down' }))).toContain(
        'Vote not recorded: You already gave this learning the same rating.',
      );
      expect(votes).toEqual([
        { id: 'f1', vote: 'up' },
        { id: 'f1', vote: 'down' },
      ]);
    });

    it('reports unavailable services', async () => {
      bridge.setHandler('feedback.search', () => {
        throw new FakeBridgeError('unavailable', 'feedback server unreachable', 503);
      });
      const result = await h.run('feedback_search', { query: 'dni' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Service unavailable');
    });
  });
});
