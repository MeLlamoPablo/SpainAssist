/**
 * @sa/mock-sede — a fake Spanish "sede electrónica" for development, demos and e2e tests:
 * Cl@ve-like gateway (Permanente + SMS, Móvil, certificate), client-certificate login, a
 * procedure signed with an imitation of AutoFirma's autoscript.js (CAdES verified server-side)
 * and a cita previa flow. See README.md.
 */
export {
  type CadesCheck,
  type CadesVerification,
  type VerifyCadesOptions,
  verifyCadesSignature,
} from './cades';
export { type CertificateHolder, describeCertificate } from './certinfo';
export type { MockSedeConfig } from './context';
export {
  type ClientCa,
  createTestIdentity,
  DEMO_IDENTITY_PASSPHRASE,
  DEMO_PERSON,
  FIXTURE_PATHS,
  loadClientCa,
  loadDemoIdentity,
  type TestIdentity,
  type TestIdentityOptions,
} from './identities';
export { type P12Contents, type P12Encryption, readP12 } from './pki';
export { type MockSede, type MockSedeOptions, startMockSede } from './server';
export {
  type AppointmentRecord,
  type ClaveUser,
  DEMO_USER,
  type SignatureReport,
  type SubmissionRecord,
} from './state';
export type { MockSedeTestApi, MovilInfo, SmsInfo, StateSnapshot } from './test-api';
