import { describe, expect, it } from 'vitest';
import { issuerName } from '../src/certificate-issuer';

// Issuer DNs of real CAs (Spain's trusted list, the FNMT and DNIe CA certificates the app ships),
// as the vault's and the signer's `formatDn` write them: RFC 4514, backslash escapes.
describe('issuerName', () => {
  it.each([
    'CN=AC FNMT Usuarios, OU=Ceres, O=FNMT-RCM, C=ES',
    'CN=AC Representación, OU=CERES, O=FNMT-RCM, C=ES',
    'CN=AC Sector Público, ORGANIZATIONIDENTIFIER=VATES-Q2826004J, OU=Ceres, O=FNMT-RCM, C=ES',
    'OU=AC Componentes Informáticos, O=FNMT-RCM, C=ES',
    'CN=AC Administración  Pública, SERIALNUMBER=Q2826004J, OU=CERES, O=FNMT-RCM, C=ES',
    'CN=AC USUARIOS G2, ORGANIZATIONIDENTIFIER=VATES-Q2826004J, O=FNMT-RCM, C=ES',
    'CN=AC REPRESENTACIÓN G2, ORGANIZATIONIDENTIFIER=VATES-Q2826004J, O=FNMT-RCM, C=ES',
    'OU=FNMT Clase 2 CA, O=FNMT, C=ES',
    'OU=AC FIRMA MOVIL, O=FNMT, C=ES',
    'OU=CERES, O=FÁBRICA NACIONAL DE MONEDA Y TIMBRE-REAL CASA DE LA MONEDA, C=ES',
    // The signer's test CA and the mock sede's.
    'CN=AC FNMT Usuarios PRUEBAS, OU=Ceres, O=FNMT-RCM PRUEBAS, C=ES',
    'CN=AC MOCK-FNMT Usuarios, OU=Ceres MOCK, O=MOCK-FNMT (entorno de pruebas), C=ES',
    // Node's X509Certificate.issuer, and a plain name.
    'C=ES\nO=FNMT-RCM\nOU=Ceres\nCN=AC FNMT Usuarios',
    'AC FNMT Usuarios',
  ])('FNMT: %s', (dn) => {
    expect(issuerName(dn)).toBe('FNMT');
  });

  it.each([
    ['CN=AC DNIE 004, OU=DNIE, O=DIRECCION GENERAL DE LA POLICIA, C=ES', 'Policía Nacional (DNI)'],
    [
      'CN=AC RAIZ DNIE 2, OU=DNIE, O=DIRECCION GENERAL DE LA POLICIA, C=ES',
      'Policía Nacional (DNI)',
    ],
    ['AC DNIE 004', 'Policía Nacional (DNI)'],
    [
      'CN=AC DGP 004, ORGANIZATIONIDENTIFIER=VATES-S2816015H, OU=CNP, O=DIRECCION GENERAL DE LA POLICIA, C=ES',
      'Policía Nacional',
    ],
  ])('the Policía: %s', (dn, name) => {
    expect(issuerName(dn)).toBe(name);
  });

  it.each([
    ['CN=ACCVCA-120, OU=PKIACCV, O=ACCV, C=ES', 'ACCV'],
    [
      'CN=ACCV RSA1 CLIENTE, ORGANIZATIONIDENTIFIER=VATES-A40573396, O=ISTEC, L=BURJASSOT, ST=VALENCIA, C=ES',
      'ACCV',
    ],
    ['CN=ACCV-CA2, OU=PKIGVA, O=Generalitat Valenciana, C=ES', 'ACCV'],
    [
      'CN=AC CAMERFIRMA FOR NATURAL PERSONS - 2016, OU=see current address at https://www.camerfirma.com/address, OU=AC CAMERFIRMA FOR NATURAL PERSONS - 2016, SERIALNUMBER=A82743287, ORGANIZATIONIDENTIFIER=VATES-A82743287, O=AC CAMERFIRMA S.A., L=MADRID, ST=MADRID, C=ES',
      'Camerfirma',
    ],
    [
      'CN=AC Camerfirma Certificados Camerales, O=AC Camerfirma SA, SERIALNUMBER=A82743287, L=Madrid (see current address at www.camerfirma.com/address), E=ac_camerfirma_cc@camerfirma.com, C=ES',
      'Camerfirma',
    ],
    [
      'CN=AC Firmaprofesional - CUALIFICADOS, SERIALNUMBER=A62634068, OU=Certificados Cualificados, O=Firmaprofesional S.A., C=ES',
      'Firmaprofesional',
    ],
    ['CN=Autoridad de Certificacion Firmaprofesional CIF A62634068, C=ES', 'Firmaprofesional'],
    [
      'CN=SUBCA QC IZENPE - HERRITARRAK ETA ENPRESA-CIUDADANIA Y EMPRESA, ORGANIZATIONIDENTIFIER=VATES-A01337260, O=IZENPE S.A., C=ES',
      'Izenpe',
    ],
    [
      'CN=ANF AC Qualified Certificates for eSignature, OU=Certificados Cualificados de Firma Electronica, ORGANIZATIONIDENTIFIER=VATES-G63287510, O=ANF Autoridad de Certificacion, C=ES',
      'ANF AC',
    ],
    [
      'SERIALNUMBER=B87341228, CN=ANF Qualified for eSignature CA, OU=Qualified Certificates for electronic signature, ORGANIZATIONIDENTIFIER=VATES-B87341228, O=ANF Certification Authority\\, S.L., C=ES',
      'ANF AC',
    ],
    [
      'CN=EC-Ciutadania, OU=Serveis Públics de Certificació, O=CONSORCI ADMINISTRACIO OBERTA DE CATALUNYA, C=ES',
      'Consorci AOC',
    ],
    [
      'CN=EC-IDCat, OU=Entitat publica de certificacio de ciutadans, OU=Serveis Publics de Certificacio ECV-2, L=Passatge de la Concepcio 11 08008 Barcelona, O=Agencia Catalana de Certificacio (NIF Q-0801176-I), C=ES',
      'Consorci AOC',
    ],
    [
      'CN=ANCERT Certificados Notariales Personales V2, O=Agencia Notarial de Certificacion S.L.U. - CIF B83395988, L=Paseo del General Martinez Campos 46 6a planta 28010 Madrid, C=ES',
      'ANCERT',
    ],
    [
      'CN=Centro Tecnológico del Notariado CA-QC No Corporativos, ORGANIZATIONIDENTIFIER=VATES-B83395988, O=Agencia Notarial de Certificación S.L. Unipersonal, C=ES',
      'ANCERT',
    ],
    [
      'CN=Registradores de España - CA Externa, OU=Certificado Propio, O=Colegio de Registradores de la Propiedad y Mercantiles de España, C=ES',
      'Colegio de Registradores',
    ],
    [
      'CN=ACA - Certificados Corporativos - 2014, SERIALNUMBER=Q2863006I, OU=Autoridad de Certificacion de la Abogacia, O=Consejo General de la Abogacia, C=ES',
      'Abogacía Española',
    ],
    [
      'CN=UANATACA CA2 2021, ORGANIZATIONIDENTIFIER=VATES-A66721499, OU=TSP-UANATACA, O=UANATACA S.A., L=Barcelona, C=ES',
      'Uanataca',
    ],
    [
      'CN=EADTrust RSA 4096 SubCA For Qualified Web DV/OV Cert 2019, O=European Agency of Digital Trust\\, S.L., C=ES',
      'EADTrust',
    ],
    [
      'CN=ESFIRMA AC AAPP 2, SERIALNUMBER=A50878842, OU=AUTORIDAD DE CERTIFICACION ESFIRMA - AAPP, O=ESPUBLICO SERVICIOS PARA LA ADMINISTRACION SA, L=ZARAGOZA, C=ES',
      'esFIRMA',
    ],
  ])('other Spanish issuers: %s', (dn, name) => {
    expect(issuerName(dn)).toBe(name);
  });

  it.each([
    // The organization, without its tax ID or legal form.
    [
      'CN=Validated ID Subordinate CA 01, ORGANIZATIONIDENTIFIER=VATES-B65750721, OU=TSP - Validated ID, O=Validated ID SL, L=Barcelona, C=ES',
      'Validated ID',
    ],
    [
      'CN=Logalty Qualified CA G2, OU=Logalty Trust Services, ORGANIZATIONIDENTIFIER=VATES-B84492891, O=Logalty Servicios de Tercero de Confianza SL, L=Alcobendas, ST=Madrid, C=ES',
      'Logalty Servicios de Tercero de Confianza',
    ],
    [
      'CN=SIGNATURIT SOLUTIONS\\, S.L.\\, QUALIFIED TRUST SERVICES PROVIDER, ORGANIZATIONIDENTIFIER=VATES-B66024167, OU=LEGAL, O=SIGNATURIT SOLUTIONS\\, SL, C=ES',
      'SIGNATURIT SOLUTIONS',
    ],
    ['CN=SESCAM CA Entidades Finales, O=SESCAM (NIF Q-4500146H), O=JCCM, C=ES', 'SESCAM'],
    ['CN=Sectigo Qualified Natural Person CA E35, O=Sectigo (Europe) SL, C=ES', 'Sectigo (Europe)'],
    ['CN=BANCO DE ESPAÑA-AC CORPORATIVA V2, O=BANCO DE ESPAÑA, C=ES', 'BANCO DE ESPAÑA'],
    // RFC 2253 quoted values, as Java and the trusted list write them.
    [
      'CN=WG10 Qualified Identification Root CA, OU=Direccion de Universidades, O="Banco Santander Central Hispano, S.A. CIF: A-39000013", L="Paseo de Pereda, 9-12", ST=Santander - Spain',
      'Banco Santander Central Hispano',
    ],
    // Attribute types as OIDs.
    ['CN=Una CA, OID.2.5.4.10=Una Empresa S.A.U., C=ES', 'Una Empresa'],
    ['2.5.4.3=Una CA, 2.5.4.6=ES', 'Una CA'],
    // Without an organization: the common name, else the unit, else the string itself.
    ['CN=Test CA, C=ES', 'Test CA'],
    ['CN=Una CA+SERIALNUMBER=A12345678, C=ES', 'Una CA'],
    ['OU=Una Unidad, C=ES', 'Una Unidad'],
    ['C=ES', 'C=ES'],
    ['Test CA', 'Test CA'],
    ['', ''],
    // An FNMT address doesn't make an FNMT CA.
    ['CN=Otra CA, O=Otra Empresa, L=Calle FNMT 1, C=ES', 'Otra Empresa'],
  ])('others: %s', (dn, name) => {
    expect(issuerName(dn)).toBe(name);
  });

  it.each([
    ['O=Empresa\\, Uno\\, Dos, C=ES', 'Empresa, Uno, Dos'],
    ['O=\\"Comillas\\" \\+ \\<más\\> \\; a\\=b \\\\ fin, C=ES', '"Comillas" + <más> ; a=b \\ fin'],
    ['O=\\#almohadilla, C=ES', '#almohadilla'],
    ['O=\\ espacios \\ , C=ES', 'espacios'],
    ['O=Caf\\C3\\A9 \\C3\\B1, C=ES', 'Café ñ'],
    ['O=Malo \\FF, C=ES', 'Malo FF'],
    // Not escaped: the comma stays in the value.
    ['CN=Una CA, O=Empresa Uno, Dos, C=ES', 'Empresa Uno, Dos'],
  ])('reads escaped values: %s', (dn, name) => {
    expect(issuerName(dn)).toBe(name);
  });
});
