import { describe, expect, it } from 'vitest';
import { detectPii, type PiiType } from '../src/index';

/** Returns [type, matched text] pairs. */
const found = (text: string) => detectPii(text).map((f) => [f.type, f.match] as [PiiType, string]);

/** Asserts exactly one finding of `type` whose text is `match`. */
function expectOne(text: string, type: PiiType, match: string) {
  expect(found(text)).toEqual([[type, match]]);
}

describe('identity documents', () => {
  it.each([
    ['Mi DNI es 12345678Z.', '12345678Z'],
    ['DNI: 12.345.678-Z', '12.345.678-Z'],
    ['con 12 345 678 Z en el formulario', '12 345 678 Z'],
    ['el número 87654321-x', '87654321-x'],
    ['DNI antiguo 1234567L', '1234567L'],
  ])('finds valid DNIs: %s', (text, match) => expectOne(text, 'dni', match));

  it('finds a labelled DNI even without (or with a wrong) control letter', () => {
    expectOne('Mi DNI 12345678 está caducado', 'dni', '12345678');
    expectOne('DNI nº: 12345678A', 'dni', '12345678A');
  });

  it('ignores invalid checksums without a label', () => {
    expect(found('El código 12345678A aparece en la tabla')).toEqual([]);
    expect(found('de 1.234.567 a 2.000.000 habitantes')).toEqual([]);
  });

  it.each([
    ['NIE X1234567L', 'X1234567L'],
    ['tengo el y-1234567-x', 'y-1234567-x'],
    ['Z 1234567 R caducado', 'Z 1234567 R'],
  ])('finds valid NIEs: %s', (text, match) => expectOne(text, 'nie', match));

  it('finds a labelled NIE without its letter, ignores invalid unlabelled ones', () => {
    expectOne('mi TIE: X1234567 ya está', 'nie', 'X1234567');
    expect(found('referencia interna X1234567A del manual')).toEqual([]);
  });

  it('finds NIF K/L/M', () => expectOne('menor con NIF K1234567L', 'dni', 'K1234567L'));

  it('finds CIFs with valid control and ignores invalid ones', () => {
    expectOne('La empresa B12345674 me cobró', 'cif', 'B12345674');
    expectOne('Ayuntamiento P2807900B', 'cif', 'P2807900B');
    expect(found('La empresa B12345675 me cobró')).toEqual([]);
  });

  it('finds passports only next to "pasaporte"', () => {
    expectOne('Pasaporte PAA123456, en vigor', 'passport', 'PAA123456');
    expectOne('nº de pasaporte: 123456789', 'passport', '123456789');
    expect(found('El lote PAA123456 llegó ayer')).toEqual([]);
    expect(found('Pide cita para el pasaporte en la comisaría')).toEqual([]);
  });

  it('finds DNI support numbers next to "soporte"', () => {
    expectOne('número de soporte: BAA123456', 'dni', 'BAA123456');
  });
});

describe('financial data', () => {
  it.each([
    ['IBAN ES91 2100 0418 4502 0005 1332.', 'ES91 2100 0418 4502 0005 1332'],
    ['cuenta ES9121000418450200051332 y nada más', 'ES9121000418450200051332'],
    ['iban es79-2100-0813-6101-2345-6789', 'es79-2100-0813-6101-2345-6789'],
    ['Konto DE89 3704 0044 0532 0130 00', 'DE89 3704 0044 0532 0130 00'],
    ['GB82 WEST 1234 5698 7654 32', 'GB82 WEST 1234 5698 7654 32'],
  ])('finds IBANs: %s', (text, match) => expectOne(text, 'iban', match));

  it('does not let trailing tokens break the IBAN checksum', () => {
    expectOne('ES91 2100 0418 4502 0005 1332 y 2026', 'iban', 'ES91 2100 0418 4502 0005 1332');
  });

  it('ignores IBANs with a wrong checksum', () => {
    expect(found('IBAN ES91 2100 0418 4502 0005 1333')).toEqual([]);
  });

  it('finds CCCs with valid control digits', () => {
    expectOne('c/c 2100 0418 45 0200051332', 'ccc', '2100 0418 45 0200051332');
    expect(found('número 2100 0418 55 0200051332')).toEqual([]);
  });

  it('finds Luhn-valid cards', () => {
    expectOne('Tarjeta 4111 1111 1111 1111.', 'card', '4111 1111 1111 1111');
    expectOne('pagué con 5555555555554444', 'card', '5555555555554444');
    expectOne('amex 3782 822463 10005', 'card', '3782 822463 10005');
    expectOne('Tarjeta 4111 1111 1111 1111 123', 'card', '4111 1111 1111 1111');
    expect(found('Tarjeta 4111 1111 1111 1112')).toEqual([]);
  });

  it('finds NUSS / NAF', () => {
    expectOne('Nº afiliación SS 281234567840', 'nuss', '281234567840');
    expectOne('mi NUSS es 28/12345678/40', 'nuss', '28/12345678/40');
    expectOne('número de la Seguridad Social: 28 1234567 41', 'nuss', '28 1234567 41');
  });
});

describe('contact data', () => {
  it.each([
    ['móvil +34 612 34 56 78;', '+34 612 34 56 78'],
    ['llama al 612345678', '612345678'],
    ['tel. 612 345 678', '612 345 678'],
    ['fijo 91 123 45 67', '91 123 45 67'],
    ['0034 612-345-678', '0034 612-345-678'],
    ['(+34) 912 345 678', '(+34) 912 345 678'],
    ['WhatsApp 712 34 56 78', '712 34 56 78'],
    ['mi número francés +33 6 12 34 56 78', '+33 6 12 34 56 78'],
  ])('finds phones: %s', (text, match) => expectOne(text, 'phone', match));

  it('keeps public service numbers and amounts', () => {
    expect(found('llama al 060, al 012 o al 112')).toEqual([]);
    expect(found('SEPE: 901 502 050 o 900 123 456')).toEqual([]);
    expect(found('un presupuesto de 600.000.000 € y 600 000 000 euros')).toEqual([]);
  });

  it.each([
    ['escribe a pablo.rc@example.es.', 'pablo.rc@example.es'],
    ['nombre+tag@sub.dominio.com', 'nombre+tag@sub.dominio.com'],
    ['correo pablo arroba example punto es', 'pablo arroba example punto es'],
    ['user [at] mail [dot] com', 'user [at] mail [dot] com'],
  ])('finds emails: %s', (text, match) => expectOne(text, 'email', match));

  it('does not treat "arroba" alone as an email', () => {
    expect(found('pulsa la tecla arroba del teclado')).toEqual([]);
  });
});

describe('addresses and places', () => {
  it.each([
    ['Vivo en C/ Mayor 5, 3ºB.', 'C/ Mayor 5, 3ºB'],
    ['en Calle de Alcalá 123, piso 2, puerta 4.', 'Calle de Alcalá 123, piso 2, puerta 4'],
    ['Avda. de la Constitución nº 12, bajo B', 'Avda. de la Constitución nº 12, bajo B'],
    ['Plaza de España 1, bajo', 'Plaza de España 1, bajo'],
    ['Paseo de la Castellana 200, 5º izq.', 'Paseo de la Castellana 200, 5º izq.'],
    ['c/ san bernardo 12, esc. A', 'c/ san bernardo 12, esc. A'],
    ['Carrer de Balmes 150, 2n', 'Carrer de Balmes 150'],
    ['Calle Mayor s/n', 'Calle Mayor s/n'],
  ])('finds street addresses: %s', (text, match) => expectOne(text, 'address', match));

  it('finds labelled addresses', () => {
    expectOne('Domicilio: Mayor 5, Villanueva\nOtra línea', 'address', 'Mayor 5, Villanueva');
  });

  it('does not take ordinary words for streets', () => {
    expect(found('la cola en la calle duró 2 horas')).toEqual([]);
    expect(found('Se convocan 20 plazas; la plaza de auxiliar número 3 sigue libre')).toEqual([]);
    expect(found('El plazo es de 10 días hábiles')).toEqual([]);
  });

  it('finds postal codes only in an address context', () => {
    expect(found('C/ Mayor 5, 3ºB, 28013 Madrid')).toEqual([
      ['address', 'C/ Mayor 5, 3ºB'],
      ['postal_code', '28013'],
    ]);
    expectOne('C.P. 08001 Barcelona', 'postal_code', '08001');
    expectOne('código postal: 41001', 'postal_code', '41001');
    expect(found('Pagué 15000 euros en 2026; el código 28013 del manual')).toEqual([]);
  });

  it('finds plates only in a vehicle context', () => {
    expectOne('matrícula del coche 1234 BCD', 'plate', '1234 BCD');
    expectOne('transferencia del vehículo M-1234-AB', 'plate', 'M-1234-AB');
    expect(found('El lote 1234 BCD llegó')).toEqual([]);
    expect(found('En 2026 DGT cambió las normas')).toEqual([]);
  });

  it('finds cadastral references', () => {
    expectOne('Ref. catastral 9872023VH5797S0001WX', 'cadastral_ref', '9872023VH5797S0001WX');
    expectOne('ref 9872023 VH5797S 0001 WX', 'cadastral_ref', '9872023 VH5797S 0001 WX');
    expectOne('parcela catastral 9872023VH5797S', 'cadastral_ref', '9872023VH5797S');
  });
});

describe('dates of birth', () => {
  it.each([
    ['nacido el 03/04/1985 en Soria', '03/04/1985'],
    ['Fecha de nacimiento: 3 de abril de 1985', '3 de abril de 1985'],
    ['F. nac.: 03-04-1985', '03-04-1985'],
    ['nací en 1985', '1985'],
    ['DOB 1985-04-03', '1985-04-03'],
  ])('finds birth dates in context: %s', (text, match) => expectOne(text, 'date_of_birth', match));

  it('keeps deadlines and other dates', () => {
    expect(found('Plazo: 10 días hábiles desde el 30/06/2026')).toEqual([]);
    expect(found('La cita es el 15/10/2026 a las 9:30')).toEqual([]);
    expect(found('Pedí el certificado de nacimiento el 15/09/2026')).toEqual([]);
    expect(found('La prestación por nacimiento se pide desde el 01/09/2026')).toEqual([]);
  });
});

describe('number abbreviations ("n.º", "nº", "núm.")', () => {
  it.each([
    ['DNI n.º 12345678', 'dni', '12345678'],
    ['NIE n.º: X1234567', 'nie', 'X1234567'],
    ['pasaporte n.º PAA123456', 'passport', 'PAA123456'],
    ['expediente n.º 2026/000123', 'case_number', '2026/000123'],
    ['n.º de expediente: 2026/000124', 'case_number', '2026/000124'],
    ['expediente núm. 4567/2026', 'case_number', '4567/2026'],
  ] as const)('%s', (text, type, match) => expectOne(text, type, match));

  it('does not read the word "no" as "número"', () => {
    expect(found('El pasaporte no caduca hasta 2030')).toEqual([]);
  });
});

describe('case numbers, names, IPs and URLs', () => {
  it.each([
    ['expediente 2026/000123;', '2026/000123'],
    ['nº de registro: REGAGE26e00012345678', 'REGAGE26e00012345678'],
    ['localizador ABC12345', 'ABC12345'],
    ['justificante de pago 7901234567890', '7901234567890'],
    ['CSV: GEN-1a2b-3c4d-5e6f', 'GEN-1a2b-3c4d-5e6f'],
    ['número de solicitud 4567/2026', '4567/2026'],
  ])('finds case numbers: %s', (text, match) => expectOne(text, 'case_number', match));

  it('does not take words after case keywords for ids', () => {
    expect(found('Guarda el justificante de pago y el expediente completo')).toEqual([]);
    expect(found('hace referencia a la Ley 39/2015')).toEqual([]);
  });

  it.each([
    ['Me llamo Juan Pérez García y vivo aquí', 'Juan Pérez García'],
    ['Atendido por la Sra. López', 'López'],
    ['a nombre de María de los Ángeles Ruiz.', 'María de los Ángeles Ruiz'],
    ['Nombre y apellidos: ANA GARCÍA', 'ANA GARCÍA'],
    ['D. Juan Pérez firmó', 'Juan Pérez'],
  ])('finds names in explicit context: %s', (text, match) => expectOne(text, 'name', match));

  it('ignores roles and lower-case words after name triggers', () => {
    expect(found('El Sr. Director General de Tráfico firmó')).toEqual([]);
    expect(found('a nombre de la empresa, con don de gentes')).toEqual([]);
    expect(found('Apartado D. Requisitos')).toEqual([]);
  });

  it('finds IPs but not versions, times or article numbers', () => {
    expectOne('desde la IP 192.168.1.10.', 'ip', '192.168.1.10');
    expectOne('IPv6 2001:db8::1', 'ip', '2001:db8::1');
    expect(found('AutoFirma versión 1.8.2.1, a las 10:30:00, artículo 16.4.2')).toEqual([]);
  });

  it('finds URL parameters, fragments and credentials', () => {
    expect(found('https://sede.x.gob.es/tramite?id=123&token=abc#paso2.')).toEqual([
      ['url_params', '?id=123&token=abc#paso2'],
    ]);
    expect(found('www.x.gob.es/a;jsessionid=ABC123')).toEqual([
      ['url_params', ';jsessionid=ABC123'],
    ]);
    expect(found('sede.x.gob.es/a/b?ref=1')).toEqual([['url_params', '?ref=1']]);
    expect(found('https://user:pw@x.es/a')).toEqual([['url_params', 'user:pw@']]);
    expect(found('https://www.boe.es/eli/es/l/2015/10/01/39/con')).toEqual([]);
  });
});
