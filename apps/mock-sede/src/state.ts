/** In-memory state of one mock sede instance (reset with the test API). */
import { randomBytes, randomInt } from 'node:crypto';
import type { CadesCheck } from './cades';
import { DEMO_PERSON } from './identities';

export type Loa = 'low' | 'substantial' | 'high';
export type AuthMethod = 'clave-permanente' | 'clave-movil' | 'certificado';
export type ProcedureId = 'residencia' | 'cita';

export const LOA_RANK: Record<Loa, number> = { low: 1, substantial: 2, high: 3 };

export interface ClaveUser {
  /** DNI/NIE (normalized, e.g. "99999999R"). */
  dni: string;
  password: string;
  givenName: string;
  surname1: string;
  surname2?: string;
  /** Mobile phone that receives the SMS codes. */
  phone: string;
  email?: string;
  /** "avanzado" (default) allows nivel sustancial with SMS; "basico" does not. */
  level?: 'basico' | 'avanzado';
}

/** Default Cl@ve Permanente user. */
export const DEMO_USER: ClaveUser = {
  dni: DEMO_PERSON.dni,
  password: 'clave-demo-1234',
  givenName: DEMO_PERSON.givenName,
  surname1: DEMO_PERSON.surname1,
  surname2: DEMO_PERSON.surname2,
  phone: '600000045',
  email: 'carmen.espanola@example.com',
  level: 'avanzado',
};

export interface SedeIdentity {
  dni: string;
  givenName: string;
  surname1: string;
  surname2?: string;
  fullName: string;
  method: AuthMethod;
  loa: Loa;
  email?: string;
  phone?: string;
  /** SHA-256 of the TLS client certificate (certificate login only). */
  certificateSha256?: string;
}

export interface GatewayRequest {
  id: string;
  procedure: ProcedureId | 'general';
  loa: Loa;
  /** Sede path to return to after login. */
  returnTo: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
  /** Cl@ve Permanente progress (after a correct password). */
  permanente?: { dni: string; codeAttempts: number; resends: number; smsId?: string };
}

export interface SmsRecord {
  id: string;
  requestId: string;
  dni: string;
  phone: string;
  code: string;
  sentAt: number;
  expiresAt: number;
  used: boolean;
}

export type MovilStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface MovilRequest {
  id: string;
  requestId: string;
  /** 3-character code shown on the page and in the app. */
  verificationCode: string;
  status: MovilStatus;
  createdAt: number;
  expiresAt: number;
  /** User that approved it on the "phone". */
  dni?: string;
}

export interface Assertion {
  id: string;
  requestId: string;
  identity: SedeIdentity;
  createdAt: number;
  used: boolean;
}

export type CaptchaTile = 'semaforo' | 'coche' | 'arbol' | 'casa' | 'bicicleta';

export interface CaptchaChallenge {
  id: string;
  createdAt: number;
  solved: boolean;
  solvedBy?: 'casilla' | 'imagenes' | 'test-api';
  /** Set once the page was left with "Continuar" after solving it. */
  used: boolean;
  attempts: number;
  image?: { target: CaptchaTile; tiles: CaptchaTile[]; correct: number[] };
}

export interface PersonalData {
  dni: string;
  nombre: string;
  apellido1: string;
  apellido2: string;
  fechaNacimiento: string;
  sexo: 'M' | 'H';
  paisNacimiento: string;
  nacionalidad: string;
}

export interface AddressData {
  tipoVia: string;
  via: string;
  numero: string;
  pisoPuerta: string;
  codigoPostal: string;
  municipio: string;
  provincia: string;
  email: string;
  telefono: string;
}

export interface UploadedDocument {
  name: string;
  size: number;
  mimeType: string;
  sha256: string;
}

export interface DocumentationData {
  motivo: string;
  motivoOtro: string;
  documento: UploadedDocument;
  declaracion: true;
  avisos: boolean;
}

export interface ResidenciaDraft {
  personal?: PersonalData;
  domicilio?: AddressData;
  documentacion?: DocumentationData;
  /** A valid upload kept while the rest of step 3 still has errors. */
  pendingDocument?: UploadedDocument;
  /** Exact bytes (UTF-8 XML) handed to AutoScript.sign on the review page. */
  toSign?: { reference: string; xml: string; preparedAt: number };
}

export interface CitaDraft {
  oficina?: string;
  servicio?: string;
  /** "YYYY-MM-DDTHH:MM" */
  hueco?: string;
}

export interface Session {
  id: string;
  identity: SedeIdentity;
  createdAt: number;
  lastSeen: number;
  residencia: ResidenciaDraft;
  cita: CitaDraft;
  /** Passed the "No soy un robot" check (cita previa). */
  captchaPassed: boolean;
}

export interface SignatureReport {
  valid: boolean;
  error?: string;
  checks: CadesCheck[];
  mode?: 'implicit' | 'explicit';
  signingTime?: string;
  signer?: { dni?: string; commonName?: string; issuer?: string; serial: string; sha256: string };
  signerMatchesApplicant: boolean;
  signatureBytes: number;
}

export interface SubmissionRecord {
  id: string;
  type: 'residencia' | 'cita';
  status: 'registered' | 'rejected';
  receivedAt: string;
  applicant: { dni: string; fullName: string; authMethod: AuthMethod; loa: Loa };
  /** Residencia: registration number and verification code. */
  registrationNumber?: string;
  csv?: string;
  form?: {
    personal: PersonalData;
    domicilio: AddressData;
    documentacion: DocumentationData;
  };
  signedXml?: string;
  signature?: SignatureReport;
  /** Cita previa. */
  appointment?: AppointmentRecord;
}

export interface AppointmentRecord {
  localizador: string;
  officeId: string;
  service: string;
  /** "YYYY-MM-DDTHH:MM" (Europe/Madrid). */
  slot: string;
  dni: string;
  fullName: string;
  phone: string;
  email?: string;
  createdAt: string;
}

export function randomId(bytes = 12): string {
  return randomBytes(bytes).toString('base64url');
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function randomCode(length: number, alphabet = CODE_ALPHABET): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export function fullNameOf(p: { givenName: string; surname1: string; surname2?: string }): string {
  return [p.givenName, p.surname1, p.surname2].filter(Boolean).join(' ');
}

export class MockSedeState {
  /** Added to Date.now() (see test API "advance-time"). */
  offsetMs = 0;
  users = new Map<string, ClaveUser>();
  /** Consecutive wrong passwords per DNI. */
  failedLogins = new Map<string, { failures: number; lockedUntil?: number }>();
  sessions = new Map<string, Session>();
  gatewayRequests = new Map<string, GatewayRequest>();
  sms: SmsRecord[] = [];
  movil = new Map<string, MovilRequest>();
  assertions = new Map<string, Assertion>();
  captchas = new Map<string, CaptchaChallenge>();
  /** AutoFirma intermediate-server storage (StorageService/RetrieveService). */
  afirmaStorage = new Map<string, string>();
  submissions: SubmissionRecord[] = [];
  appointments: AppointmentRecord[] = [];
  private registrationSeq = 0;

  constructor(private readonly initialUsers: ClaveUser[]) {
    this.reset();
  }

  now(): number {
    return Date.now() + this.offsetMs;
  }

  reset(): void {
    this.offsetMs = 0;
    this.users = new Map(this.initialUsers.map((u) => [u.dni, { level: 'avanzado', ...u }]));
    this.failedLogins.clear();
    this.sessions.clear();
    this.gatewayRequests.clear();
    this.sms = [];
    this.movil.clear();
    this.assertions.clear();
    this.captchas.clear();
    this.afirmaStorage.clear();
    this.submissions = [];
    this.appointments = [];
    this.registrationSeq = 0;
  }

  addUser(user: ClaveUser): void {
    this.users.set(user.dni, { level: 'avanzado', ...user });
  }

  nextRegistrationNumber(): string {
    this.registrationSeq += 1;
    const yy = String(new Date(this.now()).getUTCFullYear()).slice(-2);
    return `REGMOCK${yy}e${String(this.registrationSeq).padStart(8, '0')}`;
  }

  latestSms(dni?: string): SmsRecord | undefined {
    return this.sms.filter((s) => !dni || s.dni === dni).at(-1);
  }

  /** Pending Cl@ve Móvil requests, newest first. */
  pendingMovil(): MovilRequest[] {
    const now = this.now();
    for (const m of this.movil.values()) {
      if (m.status === 'pending' && m.expiresAt <= now) m.status = 'expired';
    }
    return [...this.movil.values()].filter((m) => m.status === 'pending').reverse();
  }
}
