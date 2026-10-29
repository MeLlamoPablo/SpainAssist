import type {
  DocumentParty,
  DocumentVehicle,
  FixtureDocument,
  Modelo621Spec,
  Tasa791Spec,
} from '../documents';

/**
 * The world of the vehicle transfer fixtures, shared with SpainBench's DGT mock (`dgt-es`): the two
 * buyers (the mock's Cl@ve Permanente accounts), the sellers, the vehicles of its registry and the
 * fee numbers it knows. Every value is made up; the DNIs and the CIF have valid check characters so
 * the product's PII detectors treat them like real ones. Never replace them with real data.
 */

export interface Buyer {
  givenName: string;
  surname1: string;
  surname2: string;
  /** YYYY-MM-DD. */
  birthDate: string;
  dni: string;
  /** The mock's Cl@ve Permanente password. Never in a text a model reads. */
  clavePassword: string;
  phone: string;
  email: string;
  street: string;
  postalCode: string;
  municipality: string;
}

export const DANIEL: Buyer = {
  givenName: 'Daniel',
  surname1: 'Navarro',
  surname2: 'Vidal',
  birthDate: '1993-07-14',
  dni: '31285746L',
  clavePassword: 'Giralda.Sevilla26',
  phone: '654218937',
  email: 'daniel.navarro.vidal@gmail.com',
  street: 'Calle Feria 112, 3º B',
  postalCode: '41003',
  municipality: 'Sevilla',
};

export const MARTA: Buyer = {
  givenName: 'Marta',
  surname1: 'Jiménez',
  surname2: 'Ortiz',
  birthDate: '1988-02-03',
  dni: '28934170D',
  clavePassword: 'Triana.Puente26',
  phone: '671904352',
  email: 'marta.jimenez.ortiz@hotmail.com',
  street: 'Avenida de la Constitución 18, 2º A',
  postalCode: '41700',
  municipality: 'Dos Hermanas',
};

export function fullName(buyer: Buyer): string {
  return `${buyer.givenName} ${buyer.surname1} ${buyer.surname2}`;
}

/** How a document prints a buyer: "NAVARRO VIDAL, DANIEL". */
function partyOf(buyer: Buyer): DocumentParty {
  return {
    name: `${buyer.surname1} ${buyer.surname2}, ${buyer.givenName}`.toUpperCase(),
    nif: buyer.dni,
    street: buyer.street,
    postalCode: buyer.postalCode,
    municipality: buyer.municipality,
    province: 'Sevilla',
  };
}

/** What the vault holds of a buyer in the fixtures that start with saved data. */
export function personalOf(buyer: Buyer): Record<string, string> {
  return {
    givenName: buyer.givenName,
    surname1: buyer.surname1,
    surname2: buyer.surname2,
    birthDate: buyer.birthDate,
    nationality: 'ESP',
    dniNumber: buyer.dni,
    phone: buyer.phone,
    email: buyer.email,
    addressStreet: buyer.street,
    addressPostalCode: buyer.postalCode,
    addressMunicipality: buyer.municipality,
    addressProvince: 'Sevilla',
  };
}

const ROCIO: DocumentParty = {
  name: 'DELGADO PEÑA, ROCÍO',
  nif: '52617394H',
  street: 'Calle Real de Utrera 41, 1º A',
  postalCode: '41701',
  municipality: 'Dos Hermanas',
  province: 'Sevilla',
};

const ALBERTO: DocumentParty = {
  name: 'RAMOS FUENTES, ALBERTO',
  nif: '44071836H',
  street: 'Calle Asunción 27, 4º C',
  postalCode: '41011',
  municipality: 'Sevilla',
  province: 'Sevilla',
};

const IGNACIO: DocumentParty = {
  name: 'FERRER RUIZ, IGNACIO',
  nif: '77351902G',
  street: 'Calle Nuestra Señora del Águila 9',
  postalCode: '41500',
  municipality: 'Alcalá de Guadaíra',
  province: 'Sevilla',
};

const LUCIA: DocumentParty = {
  name: 'ROMERO GIL, LUCÍA',
  nif: '29563418T',
  street: 'Calle Pagés del Corro 63, bajo',
  postalCode: '41010',
  municipality: 'Sevilla',
  province: 'Sevilla',
};

const SERGIO: DocumentParty = {
  name: 'MOLINA CASTRO, SERGIO',
  nif: '30748125T',
  street: 'Avenida de la Buhaira 15, 6º D',
  postalCode: '41018',
  municipality: 'Sevilla',
  province: 'Sevilla',
};

const GUADAIRA = {
  name: 'AUTOMOVILES GUADAIRA SL',
  nif: 'B41735929',
  street: 'Carretera de Utrera km 2,5',
  postalCode: '41500',
  municipality: 'Alcalá de Guadaíra',
  province: 'Sevilla',
  phone: '955684210',
  email: 'ventas@automovilesguadaira.es',
};

/** A sale: the vehicle, who sold it and the fee the buyer bought for it. */
export interface Sale {
  vehicle: DocumentVehicle;
  seller: DocumentParty;
  /** The DGT form the sale goes through: `FTRAN` (ordinary), `FTRNC` (moped), `FCOMP` (invoice). */
  form: 'FTRAN' | 'FTRNC' | 'FCOMP';
  tasa: Pick<Tasa791Spec, 'number' | 'tasa' | 'amount' | 'paidAt'>;
}

/** 1: an ordinary car between private persons, everything in order. */
export const SALE_IBIZA: Sale = {
  vehicle: {
    plate: '4821KZT',
    category: 'turismo',
    make: 'SEAT',
    model: 'IBIZA',
    version: '1.0 TSI STYLE',
    vin: 'VSSZZZKJZKR048213',
    firstRegistration: '2019-03-12',
    fuel: 'GASOLINA',
    cc: 999,
    kw: 70,
    seats: 5,
    mass: 1580,
    inspections: [
      { date: '2023-03-08', result: 'FAVORABLE', nextDue: '2025-03-08' },
      { date: '2025-02-27', result: 'FAVORABLE', nextDue: '2027-02-27' },
    ],
  },
  seller: ROCIO,
  form: 'FTRAN',
  tasa: { number: '791263048175', tasa: '1.5', amount: 55.7, paidAt: '2026-10-16T12:05' },
};

/** 2: an ordinary car, the contract signed more than 30 days ago. */
export const SALE_YARIS: Sale = {
  vehicle: {
    plate: '2357LHW',
    category: 'turismo',
    make: 'TOYOTA',
    model: 'YARIS',
    version: '1.0 VVT-I CITY',
    vin: 'VNKKG3D3X0A217846',
    firstRegistration: '2020-09-27',
    fuel: 'GASOLINA',
    cc: 998,
    kw: 53,
    seats: 5,
    mass: 1490,
    inspections: [{ date: '2024-09-19', result: 'FAVORABLE', nextDue: '2026-09-19' }],
  },
  seller: ALBERTO,
  form: 'FTRAN',
  tasa: { number: '791263051942', tasa: '1.5', amount: 55.7, paidAt: '2026-10-14T10:40' },
};

/** 3: a financed car whose reserva de dominio was never cancelled. */
export const SALE_PEUGEOT: Sale = {
  vehicle: {
    plate: '6094LBD',
    category: 'turismo',
    make: 'PEUGEOT',
    model: '308',
    version: '1.5 BLUEHDI ALLURE',
    vin: 'VR3FCYHZRMY093518',
    firstRegistration: '2021-05-05',
    fuel: 'DIESEL',
    cc: 1499,
    kw: 96,
    seats: 5,
    mass: 1850,
    inspections: [],
  },
  seller: IGNACIO,
  form: 'FTRAN',
  tasa: { number: '791263057316', tasa: '1.5', amount: 55.7, paidAt: '2026-10-19T09:30' },
};

/** 4: a moped: its own form (FTRNC) and fee (1.2). */
export const SALE_ZIP: Sale = {
  vehicle: {
    plate: 'C8326BTL',
    category: 'ciclomotor',
    make: 'PIAGGIO',
    model: 'ZIP 50',
    version: '4T',
    vin: 'ZAPC25100G0583146',
    firstRegistration: '2016-04-18',
    fuel: 'GASOLINA',
    cc: 49,
    kw: 2,
    seats: 2,
    mass: 205,
    inspections: [{ date: '2025-04-11', result: 'FAVORABLE', nextDue: '2027-04-11' }],
  },
  seller: LUCIA,
  form: 'FTRNC',
  tasa: { number: '791263044609', tasa: '1.2', amount: 27.85, paidAt: '2026-10-13T18:22' },
};

/** 5: an ordinary car whose ITV expired in June; the buyer has not paid the ITP. */
export const SALE_CLIO: Sale = {
  vehicle: {
    plate: '1846KRS',
    category: 'turismo',
    make: 'RENAULT',
    model: 'CLIO',
    version: '0.9 TCE LIMITED',
    vin: 'VF1RJA00360218347',
    firstRegistration: '2018-06-22',
    fuel: 'GASOLINA',
    cc: 898,
    kw: 66,
    seats: 5,
    mass: 1588,
    inspections: [
      { date: '2022-06-15', result: 'FAVORABLE', nextDue: '2024-06-15' },
      { date: '2024-06-10', result: 'FAVORABLE', nextDue: '2026-06-10' },
    ],
  },
  seller: SERGIO,
  form: 'FTRAN',
  tasa: { number: '791263060284', tasa: '1.5', amount: 55.7, paidAt: '2026-10-18T20:14' },
};

/** 6: a dealer's fleet car sold with an invoice (VAT, no ITP). */
export const SALE_SPORTAGE: Sale = {
  vehicle: {
    plate: '2753MJN',
    category: 'turismo',
    make: 'KIA',
    model: 'SPORTAGE',
    version: '1.6 T-GDI DRIVE',
    vin: 'U5YPV81GMPL208457',
    firstRegistration: '2023-01-14',
    fuel: 'GASOLINA',
    cc: 1598,
    kw: 110,
    seats: 5,
    mass: 2130,
    inspections: [],
  },
  seller: GUADAIRA,
  form: 'FCOMP',
  tasa: { number: '791263051942', tasa: '1.5', amount: 55.7, paidAt: '2026-10-16T09:48' },
};

/** Which document fields each kind of document answers (`FixtureDocument.match`). */
const MATCH = {
  contrato: 'contrato|compraventa',
  factura: 'factura',
  permiso: 'permiso|circulaci',
  ficha: 'ficha|tarjeta itv|inspecci|\\bitv\\b',
  itp: '\\bitp\\b|621|620|impuesto|transmisiones|autoliquidaci|tributo',
  tasa: 'tasa|791',
} as const;

/** The photo of the contract of sale between private persons. */
export function contrato(
  sale: Sale,
  buyer: Buyer,
  signed: { place: string; date: string; time: string; price: number; km: number },
  options: { saved: boolean; name: string; seed: number },
): FixtureDocument {
  return {
    key: 'contrato',
    name: options.name,
    saved: options.saved,
    match: MATCH.contrato,
    spec: {
      kind: 'contrato',
      ...signed,
      seller: sale.seller,
      buyer: partyOf(buyer),
      vehicle: sale.vehicle,
      photo: { seed: options.seed, angle: -1.8 },
    },
  };
}

export function permiso(
  sale: Sale,
  issued: string,
  options: { saved: boolean; name: string; seed: number },
): FixtureDocument {
  return {
    key: 'permiso',
    name: options.name,
    saved: options.saved,
    match: MATCH.permiso,
    spec: {
      kind: 'permiso',
      holder: sale.seller,
      vehicle: sale.vehicle,
      issued,
      photo: { seed: options.seed, angle: 1.3 },
    },
  };
}

export function ficha(
  sale: Sale,
  options: { saved: boolean; name: string; seed: number },
): FixtureDocument {
  return {
    key: 'ficha',
    name: options.name,
    saved: options.saved,
    match: MATCH.ficha,
    spec: { kind: 'ficha', vehicle: sale.vehicle, photo: { seed: options.seed, angle: -0.7 } },
  };
}

/** The receipt of the ITP (modelo 621) the buyer paid. */
export function itp(
  sale: Sale,
  buyer: Buyer,
  paid: Pick<Modelo621Spec, 'number' | 'accrual' | 'declaredValue' | 'paidAt' | 'nrc'>,
  options: { saved: boolean },
): FixtureDocument {
  return {
    key: 'itp',
    name: `Justificante_Modelo621_${paid.number}.pdf`,
    saved: options.saved,
    match: MATCH.itp,
    spec: {
      kind: 'modelo621',
      ...paid,
      buyer: partyOf(buyer),
      seller: sale.seller,
      vehicle: sale.vehicle,
      base: paid.declaredValue,
      rate: 4,
    },
  };
}

/** The receipt of the DGT fee the buyer bought. */
export function tasa(sale: Sale, buyer: Buyer, options: { saved: boolean }): FixtureDocument {
  return {
    key: 'tasa',
    name: `Justificante_Tasa_${sale.tasa.number}.pdf`,
    saved: options.saved,
    match: MATCH.tasa,
    spec: { kind: 'tasa791', payer: partyOf(buyer), ...sale.tasa },
  };
}

/** The dealer's invoice of `SALE_SPORTAGE`. */
export function factura(buyer: Buyer, options: { saved: boolean }): FixtureDocument {
  return {
    key: 'factura',
    name: 'Factura VO-2026-0418.pdf',
    saved: options.saved,
    match: MATCH.factura,
    spec: {
      kind: 'factura',
      number: 'VO-2026/0418',
      date: '2026-10-15',
      dealer: GUADAIRA,
      buyer: partyOf(buyer),
      vehicle: SALE_SPORTAGE.vehicle,
      km: 41250,
      total: 22000,
      vatRate: 21,
    },
  };
}
