import { describe, expect, it } from 'vitest';
import {
  BindingGate,
  classifyAction,
  isBindingLabel,
  isReviewText,
  parseSnapshot,
} from '../src/tools/binding';

const URL = 'https://sede.example.gob.es/tramite';

const FORM = [
  '- generic [ref=e1]:',
  '  - heading "Solicitud" [level=1] [ref=e2]',
  '  - textbox "Confirmar correo" [ref=e3]: ana@example.com',
  '  - checkbox "Confirmo que los datos son ciertos" [ref=e4]',
  '  - button "Volver" [ref=e5] [cursor=pointer]',
  '  - button "Enviar solicitud" [ref=e6] [cursor=pointer]',
  '  - button [ref=e7]:',
  '    - img [ref=e8]',
  '    - text: Pagar tasa',
  '  - link "Solicitar cita previa" [ref=e9] [cursor=pointer]:',
  '    - /url: https://sede.example.gob.es/cita',
  '  - link "Presentar" [ref=e10] [cursor=pointer]:',
  '    - /url: https://sede.example.gob.es/tramite#',
  '  - link "Firmar" [ref=e11] [cursor=pointer]:',
  '    - /url: javascript:firmar()',
  `  - 'button "Paso 2: Firmar" [ref=e12]'`,
  '  - text: \'button "Siguiente" [ref=e13]\'',
  '  - button "Siguiente [ref=e14]" [ref=e13]',
].join('\n');

const LOGIN = [
  '- generic [ref=e1]:',
  '  - textbox "Usuario" [active] [ref=e2]: ana',
  '  - textbox "Contraseña" [ref=e3]: ••••',
  '  - button "Acceder" [ref=e4]',
  '  - link "Sign in with Cl@ve" [ref=e5]',
].join('\n');

describe('isBindingLabel', () => {
  it.each([
    'Enviar',
    'Enviar solicitud',
    'Envía',
    'PRESENTAR',
    'Firmar y enviar',
    'Pagar 12 €',
    'Realizar el pago',
    'Confirmar cita',
    'Registrar solicitud',
    'Solicitar',
    'Reservar',
    'Cancelar cita',
    'Anular la reserva',
    'Submit',
    'Pay now',
    'Sign',
    'Sign document',
    'Book appointment',
    'Cancel my appointment',
  ])('"%s" is binding', (label) => {
    expect(isBindingLabel(label)).toBe(true);
  });

  it.each([
    'Acceder',
    'Entrar',
    'Iniciar sesión',
    'Sign in',
    'Sign-in',
    'Sign up',
    'Siguiente',
    'Volver',
    'Cancelar',
    'Cancel',
    'Aceptar cookies',
    'Firma electrónica',
    'Descargar justificante',
    'Registrarse',
  ])('"%s" is not binding', (label) => {
    expect(isBindingLabel(label)).toBe(false);
  });
});

describe('parseSnapshot', () => {
  it('reads roles, names, values, text children, URLs and nesting', () => {
    const page = parseSnapshot(FORM, URL);
    const byRef = (ref: string) => page.nodes.find((n) => n.ref === ref);
    expect(byRef('e3')).toMatchObject({
      role: 'textbox',
      label: 'Confirmar correo ana@example.com',
    });
    expect(byRef('e7')).toMatchObject({ role: 'button', label: ' Pagar tasa' });
    expect(byRef('e9')?.url).toBe('https://sede.example.gob.es/cita');
    expect(byRef('e12')).toMatchObject({ role: 'button', label: 'Paso 2: Firmar' });
    expect(byRef('e1')?.end).toBe(page.nodes.length);
    expect(page.nodes.filter((n) => n.ref === 'e13')).toHaveLength(1);
  });
});

describe('classifyAction', () => {
  const page = parseSnapshot(FORM, URL);
  const click = (ref: string) => classifyAction(page, { kind: 'click', ref });

  it('flags clicks on binding buttons, by name or by text inside', () => {
    expect(click('e6')).toEqual({ binding: true, label: 'Enviar solicitud' });
    expect(click('e7')).toEqual({ binding: true, label: 'Pagar tasa' });
    expect(click('e12')).toMatchObject({ binding: true });
  });

  it('flags a container that holds a binding control', () => {
    expect(click('e1')).toEqual({ binding: true, label: 'Enviar solicitud' });
  });

  it('lets fields, checkboxes, other buttons and navigation links through', () => {
    for (const ref of ['e3', 'e4', 'e5', 'e9']) expect(click(ref)).toEqual({ binding: false });
  });

  it('treats script links and links to the same page as actions', () => {
    expect(click('e10')).toMatchObject({ binding: true });
    expect(click('e11')).toMatchObject({ binding: true });
  });

  it('is not fooled by page text or names that imitate refs', () => {
    expect(click('e13')).toEqual({ binding: false });
    expect(click('e14')).toEqual({ binding: true, unknown: true });
  });

  it('treats unknown pages and refs as binding', () => {
    expect(click('e99')).toEqual({ binding: true, unknown: true });
    expect(classifyAction(undefined, { kind: 'click', ref: 'e1' })).toEqual({
      binding: true,
      unknown: true,
    });
  });

  it('flags Enter in a field when the page has a binding control', () => {
    expect(classifyAction(page, { kind: 'submit' })).toMatchObject({ binding: true });
    expect(classifyAction(page, { kind: 'key', key: 'Enter' })).toMatchObject({ binding: true });
    const login = parseSnapshot(LOGIN, URL);
    expect(classifyAction(login, { kind: 'submit' })).toEqual({ binding: false });
    expect(classifyAction(login, { kind: 'key', key: 'Enter' })).toEqual({ binding: false });
  });

  it('classifies Enter and Space on the focused control', () => {
    const focused = parseSnapshot(
      ['- button "Volver" [ref=e1]', '- button "Pagar" [active] [ref=e2]'].join('\n'),
      URL,
    );
    expect(classifyAction(focused, { kind: 'key', key: 'Enter' })).toMatchObject({
      binding: true,
    });
    expect(classifyAction(focused, { kind: 'key', key: ' ' })).toMatchObject({ binding: true });
    expect(classifyAction(focused, { kind: 'key', key: 'Tab' })).toEqual({ binding: false });
    const body = parseSnapshot(
      ['- generic [active] [ref=e1]:', '  - button "Pagar" [ref=e2]'].join('\n'),
    );
    expect(classifyAction(body, { kind: 'key', key: 'Enter' })).toEqual({ binding: false });
  });
});

describe('review steps', () => {
  const REVIEW = [
    '- heading "Resumen de tu solicitud" [level=1] [ref=e1]',
    '- paragraph [ref=e2]: Revisa los datos antes de continuar.',
    '- checkbox "Declaro que los datos son ciertos" [ref=e3]',
    '- button "Volver" [ref=e4]',
    '- button "Continuar" [ref=e5]',
    '- button [ref=e6]:',
    '  - img [ref=e7]',
    '- link "Siguiente" [ref=e8]:',
    '  - /url: https://sede.example.gob.es/otra',
  ].join('\n');

  it('spots review pages from their text, not from button labels', () => {
    expect(isReviewText('Importe a pagar: 12 €')).toBe(true);
    expect(isReviewText('Acepto las condiciones de uso')).toBe(true);
    expect(isReviewText('Paso 2 de 4: datos personales')).toBe(false);
    expect(parseSnapshot(REVIEW, URL).review).toBe(true);
    expect(parseSnapshot('- button "Revisar" [ref=e1]', URL).review).toBe(false);
    expect(parseSnapshot('- textbox "Nombre" [ref=e1]: Resumen', URL).review).toBe(false);
  });

  it('gates "Continuar" and unlabelled buttons only on review pages', () => {
    const page = parseSnapshot(REVIEW, URL);
    const click = (ref: string) => classifyAction(page, { kind: 'click', ref });
    expect(click('e5')).toEqual({ binding: true, label: 'Continuar' });
    expect(click('e6')).toEqual({ binding: true, label: '(unlabelled button)' });
    expect(click('e4')).toEqual({ binding: false });
    // A link to another page is still a navigation.
    expect(click('e8')).toEqual({ binding: false });
    const plain = parseSnapshot(
      [
        '- heading "Datos personales" [ref=e1]',
        '- button "Continuar" [ref=e2]',
        '- button [ref=e3]',
      ].join('\n'),
      URL,
    );
    expect(classifyAction(plain, { kind: 'click', ref: 'e2' })).toEqual({ binding: false });
    expect(classifyAction(plain, { kind: 'click', ref: 'e3' })).toEqual({ binding: false });
  });
});

describe('BindingGate', () => {
  const gateOn = (snapshot = FORM, url = URL) => {
    const gate = new BindingGate();
    gate.setPage(snapshot, url);
    return gate;
  };
  const grant = (gate: BindingGate, ref?: string) => {
    const approval = gate.approvalFor(ref);
    if (typeof approval === 'string') throw new Error(approval);
    gate.grant(approval);
  };

  it('needs one approval per binding action', () => {
    const gate = gateOn();
    expect(gate.check({ kind: 'click', ref: 'e5' })).toBeUndefined();
    expect(gate.check({ kind: 'click', ref: 'e6' })).toContain('confirm_action');
    grant(gate);
    expect(gate.check({ kind: 'click', ref: 'e6' })).toBeUndefined();
    expect(gate.check({ kind: 'click', ref: 'e6' })).toContain('confirm_action');
  });

  it('forgets an approval when a later request is asked', () => {
    const gate = gateOn();
    grant(gate);
    gate.revoke();
    expect(gate.check({ kind: 'click', ref: 'e6' })).toContain('looks binding');
  });

  it('ties an approval to the site it was given on', () => {
    const gate = gateOn();
    grant(gate);
    gate.setPage(FORM, 'https://pagos.example.com/tpv');
    expect(gate.check({ kind: 'click', ref: 'e6' })).toContain(
      'approval was for https://sede.example.gob.es',
    );
    // Same site, another page: still fine.
    gate.setPage(FORM, 'https://sede.example.gob.es/otro-paso');
    expect(gate.check({ kind: 'click', ref: 'e6' })).toBeUndefined();
  });

  it('ties an approval to the named element', () => {
    const gate = gateOn();
    grant(gate, 'e7');
    expect(gate.check({ kind: 'click', ref: 'e6' })).toContain('the user approved "Pagar tasa"');
    expect(gate.check({ kind: 'submit' })).toContain('not submitting this form');
    // Refs may change between snapshots: the label is what counts.
    gate.setPage(FORM.replace('[ref=e7]', '[ref=e70]'), URL);
    expect(gate.check({ kind: 'click', ref: 'e70' })).toBeUndefined();
    expect(gate.approvalFor('e99')).toContain('not in the latest page snapshot');
  });

  it('asks for a fresh snapshot when it cannot see the target', () => {
    const gate = new BindingGate();
    expect(gate.check({ kind: 'click', ref: 'e1' })).toContain('browser_snapshot');
    grant(gate);
    expect(gate.check({ kind: 'click', ref: 'e1' })).toBeUndefined();
    const named = gateOn();
    grant(named, 'e6');
    expect(named.check({ kind: 'click', ref: 'e99' })).toContain('browser_snapshot');
  });

  it('knows the page and its link targets', () => {
    const gate = gateOn();
    expect(gate.pageUrl()).toBe(URL);
    expect(gate.linkUrl('e9')).toBe('https://sede.example.gob.es/cita');
    expect(gate.linkUrl('e6')).toBeUndefined();
    gate.setPage(undefined);
    expect(gate.pageUrl()).toBeUndefined();
  });
});
