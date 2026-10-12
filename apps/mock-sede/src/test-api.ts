/**
 * Test controls: the same operations are available in-process (`sede.test.*`) and over HTTP
 * under /__test/* (disable with MOCK_SEDE_TEST_API=0 or `testApi: false`).
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, AppEnv } from './context';
import type { AppointmentRecord, ClaveUser, MovilStatus, SubmissionRecord } from './state';
import { normalizeDocumentId, validateDocumentId } from './validation';

export interface SmsInfo {
  code: string;
  dni: string;
  phone: string;
  sentAt: string;
  expiresAt: string;
  expired: boolean;
  used: boolean;
}

export interface MovilInfo {
  id: string;
  verificationCode: string;
  status: MovilStatus;
  expiresAt: string;
  dni?: string;
}

export interface StateSnapshot {
  now: string;
  users: { dni: string; level: string; phone: string }[];
  sessions: {
    dni: string;
    fullName: string;
    method: string;
    loa: string;
    lastSeen: string;
    captchaPassed: boolean;
  }[];
  gatewayRequests: {
    id: string;
    procedure: string;
    loa: string;
    consumed: boolean;
    expiresAt: string;
  }[];
  sms: SmsInfo[];
  movil: MovilInfo[];
  captchas: { id: string; solved: boolean; solvedBy?: string; used: boolean; attempts: number }[];
  submissions: number;
  appointments: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

export class MockSedeTestApi {
  constructor(private readonly ctx: AppContext) {}

  private get state() {
    return this.ctx.state;
  }

  snapshot(): StateSnapshot {
    const s = this.state;
    const now = s.now();
    s.pendingMovil(); // refreshes expired entries
    return {
      now: iso(now),
      users: [...s.users.values()].map((u) => ({
        dni: u.dni,
        level: u.level ?? 'avanzado',
        phone: u.phone,
      })),
      sessions: [...s.sessions.values()].map((x) => ({
        dni: x.identity.dni,
        fullName: x.identity.fullName,
        method: x.identity.method,
        loa: x.identity.loa,
        lastSeen: iso(x.lastSeen),
        captchaPassed: x.captchaPassed,
      })),
      gatewayRequests: [...s.gatewayRequests.values()].map((r) => ({
        id: r.id,
        procedure: r.procedure,
        loa: r.loa,
        consumed: r.consumed,
        expiresAt: iso(r.expiresAt),
      })),
      sms: s.sms.map((m) => this.smsInfo(m.id)!),
      movil: [...s.movil.values()].map((m) => ({
        id: m.id,
        verificationCode: m.verificationCode,
        status: m.status,
        expiresAt: iso(m.expiresAt),
        dni: m.dni,
      })),
      captchas: [...s.captchas.values()].map((c) => ({
        id: c.id,
        solved: c.solved,
        solvedBy: c.solvedBy,
        used: c.used,
        attempts: c.attempts,
      })),
      submissions: s.submissions.length,
      appointments: s.appointments.length,
    };
  }

  private smsInfo(id: string): SmsInfo | undefined {
    const m = this.state.sms.find((x) => x.id === id);
    if (!m) return undefined;
    return {
      code: m.code,
      dni: m.dni,
      phone: m.phone,
      sentAt: iso(m.sentAt),
      expiresAt: iso(m.expiresAt),
      expired: m.expiresAt < this.state.now(),
      used: m.used,
    };
  }

  /** The last SMS code sent (optionally for one DNI). */
  latestSms(dni?: string): SmsInfo | undefined {
    const m = this.state.latestSms(dni ? normalizeDocumentId(dni) : undefined);
    return m ? this.smsInfo(m.id) : undefined;
  }

  /**
   * Plays the phone: approves (or rejects) the newest pending Cl@ve Móvil request, or the one
   * with `id`. The user defaults to the demo user. Returns undefined if nothing is pending.
   */
  approveMovil(opts: { id?: string; dni?: string; reject?: boolean } = {}): MovilInfo | undefined {
    const dni = opts.dni ? normalizeDocumentId(opts.dni) : undefined;
    if (dni && !this.state.users.has(dni)) throw new Error(`Unknown Cl@ve user ${dni}`);
    const pending = this.state.pendingMovil();
    const movil = opts.id ? pending.find((m) => m.id === opts.id) : pending[0];
    if (!movil) return undefined;
    movil.status = opts.reject ? 'rejected' : 'approved';
    movil.dni = opts.reject ? undefined : (dni ?? [...this.state.users.keys()][0]);
    return {
      id: movil.id,
      verificationCode: movil.verificationCode,
      status: movil.status,
      expiresAt: iso(movil.expiresAt),
      dni: movil.dni,
    };
  }

  /** Marks pending "No soy un robot" challenges (all, or the one with `id`) as solved. */
  solveCaptcha(id?: string): number {
    let solved = 0;
    for (const challenge of this.state.captchas.values()) {
      if ((id && challenge.id !== id) || challenge.solved || challenge.used) continue;
      challenge.solved = true;
      challenge.solvedBy = 'test-api';
      solved++;
    }
    return solved;
  }

  /** Received forms (residencia: data + signature verification; cita: appointment). */
  submissions(): SubmissionRecord[] {
    return structuredClone(this.state.submissions);
  }

  appointments(): AppointmentRecord[] {
    return structuredClone(this.state.appointments);
  }

  /** Clears sessions, codes, submissions... and restores the initial users and clock. */
  reset(): void {
    this.state.reset();
  }

  /** Moves the sede's clock forward (SMS/Cl@ve Móvil/session expiry). Returns the new time. */
  advanceTime(seconds: number): string {
    this.state.offsetMs += seconds * 1000;
    return iso(this.state.now());
  }

  /** Adds or replaces a Cl@ve Permanente user. */
  addUser(user: ClaveUser): void {
    const dni = normalizeDocumentId(user.dni);
    const problem = validateDocumentId(dni);
    if (problem) throw new Error(`Invalid DNI/NIE ${user.dni}: ${problem}`);
    this.state.addUser({ ...user, dni });
  }

  /** Forgets every session (the next request looks like an expired session). */
  expireSessions(): number {
    const n = this.state.sessions.size;
    this.state.sessions.clear();
    return n;
  }
}

const approveBody = z.object({
  id: z.string().max(64).optional(),
  dni: z.string().max(20).optional(),
  reject: z.boolean().optional(),
});
const captchaBody = z.object({ id: z.string().max(64).optional() });
const timeBody = z.object({ seconds: z.number().finite() });
const userBody = z.object({
  dni: z.string().min(1).max(20),
  password: z.string().min(1).max(200),
  givenName: z.string().min(1).max(80),
  surname1: z.string().min(1).max(80),
  surname2: z.string().max(80).optional(),
  phone: z.string().regex(/^[67]\d{8}$/),
  email: z.string().max(200).optional(),
  level: z.enum(['basico', 'avanzado']).optional(),
});

export function registerTestApi(app: Hono<AppEnv>, api: MockSedeTestApi): void {
  const body = async (c: { req: { json(): Promise<unknown> } }) => c.req.json().catch(() => ({}));

  app.get('/__test/state', (c) => c.json(api.snapshot()));

  app.get('/__test/sms', (c) => {
    const sms = api.latestSms(c.req.query('dni'));
    return sms ? c.json(sms) : c.json({ error: 'No SMS has been sent' }, 404);
  });

  app.post('/__test/approve-movil', async (c) => {
    const parsed = approveBody.safeParse(await body(c));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const movil = api.approveMovil(parsed.data);
      return movil ? c.json(movil) : c.json({ error: 'No pending Cl@ve Móvil request' }, 404);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.post('/__test/solve-captcha', async (c) => {
    const parsed = captchaBody.safeParse(await body(c));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json({ solved: api.solveCaptcha(parsed.data.id) });
  });

  app.get('/__test/submissions', (c) => c.json(api.submissions()));

  app.post('/__test/reset', (c) => {
    api.reset();
    return c.json({ ok: true });
  });

  app.post('/__test/advance-time', async (c) => {
    const parsed = timeBody.safeParse(await body(c));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    return c.json({ now: api.advanceTime(parsed.data.seconds) });
  });

  app.post('/__test/users', async (c) => {
    const parsed = userBody.safeParse(await body(c));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      api.addUser(parsed.data);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.post('/__test/expire-sessions', (c) => c.json({ expired: api.expireSessions() }));
}
