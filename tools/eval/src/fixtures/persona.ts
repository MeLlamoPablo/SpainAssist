import type { FixtureSeed } from '../contracts';

/**
 * The synthetic user of the vida laboral fixtures: the one account of SpainBench's Seguridad
 * Social mock. Every value is made up. The DNI and NUSS have valid check digits so the product's
 * checksum-validating PII detectors treat them like real ones; they were not checked against real
 * people, so never publish them as a real identity. Never replace them with real data.
 */
const PERSONA = {
  givenName: 'Lucía',
  surname1: 'Moreno',
  surname2: 'Castillo',
  /** YYYY-MM-DD, the vault's date format. */
  birthDate: '1991-05-23',
  dni: '53918274H',
  /** Número de afiliación, unformatted (28/31742096/47). */
  nuss: '283174209647',
} as const;

/** The mock's Cl@ve Permanente account: the user is the DNI. */
export const CLAVE_USERNAME: string = PERSONA.dni;

/**
 * The password of the mock's account. It only appears in structured answers and the seed, never
 * in a persona text, an instruction or anything a model reads (see `validateFixture`).
 */
export const CLAVE_PASSWORD = 'SpainBench2026!';

/**
 * Who the answerer model plays. Written for the model, in English; the answers it produces are
 * in Spanish. It holds no secret: the password only travels in structured answers.
 */
export const PERSONA_TEXT = `You are Lucía Moreno Castillo, 35 years old, born on 23 May 1991, and you live in Spain. Your DNI is 53918274H.
You asked your assistant app for your "vida laboral" report (the employment history from the Seguridad Social).
You are registered in Cl@ve Permanente and it is the only way you have to identify yourself online: you do not have Cl@ve Móvil, a digital certificate or an electronic DNI. You know your password, but you never type it in a chat or a form; the app asks for it in a separate protected window.
You are not good with technology. Answer briefly, in plain Spanish. If you are asked something that is not in this description (your address, phone number, email, social security number...), say that you do not know it or leave it out. Do not invent data.`;

/** What the vault holds in the fixtures that start with saved data (fixture 2 and 3). */
export function seedWithData(): FixtureSeed {
  return {
    personal: {
      givenName: PERSONA.givenName,
      surname1: PERSONA.surname1,
      surname2: PERSONA.surname2,
      birthDate: PERSONA.birthDate,
      dniNumber: PERSONA.dni,
      nuss: PERSONA.nuss,
    },
    claves: [{ username: CLAVE_USERNAME, password: CLAVE_PASSWORD, label: 'Cl@ve Permanente' }],
  };
}
