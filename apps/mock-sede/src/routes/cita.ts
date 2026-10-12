/** "Cita previa (prueba)": office -> "No soy un robot" -> slot grid -> confirmation -> receipt. */
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  type AppContext,
  type AppEnv,
  type Ctx,
  field,
  PROCEDURES,
  renderSede,
  requireLogin,
} from '../context';
import { APPOINTMENT_SERVICES, labelOf, OFFICES } from '../data';
import { type HtmlValue, html } from '../html';
import { renderReceiptPdf } from '../pdf';
import {
  type AppointmentRecord,
  randomCode,
  randomId,
  type Session,
  type SubmissionRecord,
} from '../state';
import {
  addDays,
  formatIsoDate,
  formatMadridDateTime,
  longSpanishDate,
  madridIsoDate,
  shortSpanishDate,
  weekdayOf,
} from '../time';
import { isValidEmail, normalizeMobile } from '../validation';
import {
  alertBox,
  checkboxField,
  errorSummary,
  selectField,
  stepIndicator,
  summaryList,
  textField,
} from '../views';

const BASE = '/tramites/cita';
export const CITA_PATHS = {
  info: BASE,
  oficina: `${BASE}/solicitud/oficina`,
  horario: `${BASE}/solicitud/horario`,
  confirmar: `${BASE}/solicitud/confirmar`,
  justificante: `${BASE}/justificante`,
} as const;
const C = CITA_PATHS;
const NAME = PROCEDURES.cita.name;
const STEPS = ['Oficina y servicio', 'Día y hora', 'Confirmación'];
const BREADCRUMBS = [
  { label: 'Trámites', href: '/tramites' },
  { label: NAME, href: C.info },
];
export const SLOT_TIMES = [
  '09:00',
  '09:30',
  '10:00',
  '10:30',
  '11:00',
  '11:30',
  '12:00',
  '12:30',
  '13:00',
  '13:30',
];
const WORKING_DAYS = 10;
const OFFICE_OPTIONS = OFFICES.map((o) => ({ value: o.id, label: `${o.name} (${o.address})` }));

/** FNV-1a, to decide deterministically which slots are already taken. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function workingDays(todayIso: string, count = WORKING_DAYS): string[] {
  const out: string[] = [];
  let day = addDays(todayIso, 1);
  while (out.length < count) {
    const wd = weekdayOf(day);
    if (wd !== 0 && wd !== 6) out.push(day);
    day = addDays(day, 1);
  }
  return out;
}

const confirmSchema = z.object({
  telefono: z
    .string()
    .trim()
    .min(1, 'Escribe un teléfono de contacto.')
    .refine(
      (v) => normalizeMobile(v) !== null,
      'El teléfono debe ser un móvil español de 9 cifras.',
    ),
  email: z
    .string()
    .trim()
    .refine((v) => v === '' || isValidEmail(v), 'El correo electrónico no es válido.'),
  privacidad: z.literal('si', {
    error: 'Tienes que aceptar la información sobre protección de datos.',
  }),
});

export function registerCitaRoutes(app: Hono<AppEnv>, ctx: AppContext): void {
  const { state, config } = ctx;
  const session = (c: Ctx) => c.get('session') as Session;

  app.use(`${BASE}/solicitud/*`, requireLogin('cita'));
  app.use(`${C.justificante}/*`, requireLogin('cita'));

  const isTaken = (officeId: string, slot: string) => {
    const [date, time] = slot.split('T');
    return (
      hash(`${officeId}|${date}|${time}`) % 100 < 55 ||
      state.appointments.some((a) => a.officeId === officeId && a.slot === slot)
    );
  };
  const days = () => workingDays(madridIsoDate(new Date(state.now())));

  const stepPage = (c: Ctx, step: number, body: HtmlValue, status: 200 | 400 | 409 = 200) =>
    renderSede(
      c,
      ctx,
      {
        title: `${STEPS[step]} - ${NAME}`,
        breadcrumbs: [...BREADCRUMBS, { label: 'Pedir cita' }],
        body: html`<h1>${NAME}</h1>${stepIndicator(STEPS, step)}<h2>${STEPS[step]}</h2>${body}`,
      },
      status,
    );

  app.get(C.info, (c) =>
    renderSede(c, ctx, {
      title: NAME,
      breadcrumbs: [{ label: 'Trámites', href: '/tramites' }, { label: NAME }],
      body: html`<h1>${NAME}</h1>
        <p class="intro">Reserva día y hora para que te atiendan en una de nuestras oficinas (ficticias).</p>
        <h2>Antes de empezar</h2>
        <ul>
          <li>Tienes que identificarte con Cl@ve o con certificado electrónico.</li>
          <li>Hay pocas citas libres: si no ves huecos esta semana, mira la siguiente.</li>
          <li>Lleva tu DNI o NIE el día de la cita.</li>
        </ul>
        <p><a class="boton" href="${C.oficina}">Pedir cita</a></p>`,
    }),
  );

  // --- Step 1: office and service ----------------------------------------------------------------
  const officePage = (
    c: Ctx,
    values: { oficina?: string; servicio?: string },
    errors: Record<string, string> = {},
  ) =>
    stepPage(
      c,
      0,
      html`${errorSummary(errors)}
        <form method="post" action="${C.oficina}" class="formulario" novalidate>
          ${selectField({ name: 'oficina', label: 'Oficina', options: OFFICE_OPTIONS, value: values.oficina, required: true, placeholder: 'Selecciona una oficina', error: errors.oficina })}
          ${selectField({ name: 'servicio', label: 'Servicio', options: APPOINTMENT_SERVICES, value: values.servicio, required: true, placeholder: 'Selecciona el servicio', error: errors.servicio })}
          <div class="acciones"><button type="submit" class="boton">Continuar</button></div>
        </form>`,
      Object.keys(errors).length ? 400 : 200,
    );

  app.get(C.oficina, (c) => officePage(c, session(c).cita));

  app.post(C.oficina, async (c) => {
    const body = await c.req.parseBody();
    const values = { oficina: field(body, 'oficina'), servicio: field(body, 'servicio') };
    const errors: Record<string, string> = {};
    if (!OFFICES.some((o) => o.id === values.oficina)) errors.oficina = 'Elige una oficina.';
    if (!APPOINTMENT_SERVICES.some((s) => s.value === values.servicio))
      errors.servicio = 'Elige un servicio.';
    if (Object.keys(errors).length) return officePage(c, values, errors);
    const s = session(c);
    s.cita = { oficina: values.oficina, servicio: values.servicio };
    if (config.captchaInCita && !s.captchaPassed) {
      return c.redirect(`/verificacion?continuar=${encodeURIComponent(C.horario)}`, 303);
    }
    return c.redirect(C.horario, 303);
  });

  // --- Step 2: day and time ------------------------------------------------------------------------
  const slotsPage = (c: Ctx, week: number, error?: string) => {
    const s = session(c);
    const office = OFFICES.find((o) => o.id === s.cita.oficina)!;
    const all = days();
    const weekDays = all.slice(week * 5, week * 5 + 5);
    const free = weekDays
      .flatMap((d) => SLOT_TIMES.map((t) => `${d}T${t}`))
      .filter((slot) => !isTaken(office.id, slot));
    return stepPage(
      c,
      1,
      html`<p>Oficina: <strong>${office.name}</strong> (${office.address}). Servicio: <strong>${labelOf(APPOINTMENT_SERVICES, s.cita.servicio)}</strong>.</p>
        ${error ? alertBox('error', error) : ''}
        ${free.length ? '' : alertBox('aviso', 'No quedan huecos libres esta semana. Prueba con la semana siguiente.')}
        <form method="post" action="${C.horario}" class="formulario" novalidate>
          <input type="hidden" name="semana" value="${week}">
          <fieldset class="grupo-huecos">
            <legend>Elige día y hora</legend>
            <table class="huecos">
              <caption>Semana del ${formatIsoDate(weekDays[0]!)} al ${formatIsoDate(weekDays.at(-1)!)}</caption>
              <thead><tr><th scope="col">Hora</th>${weekDays.map((d) => html`<th scope="col">${shortSpanishDate(d)}</th>`)}</tr></thead>
              <tbody>
                ${SLOT_TIMES.map(
                  (t) =>
                    html`<tr><th scope="row">${t}</th>${weekDays.map((d) => {
                      const slot = `${d}T${t}`;
                      return isTaken(office.id, slot)
                        ? html`<td class="completo"><span aria-label="${longSpanishDate(d)} a las ${t}: completo">Completo</span></td>`
                        : html`<td class="libre"><input type="radio" name="hueco" id="hueco-${d}-${t.replace(':', '')}" value="${slot}" aria-label="${longSpanishDate(d)} a las ${t}"${s.cita.hueco === slot ? html` checked` : ''}><label for="hueco-${d}-${t.replace(':', '')}">Libre</label></td>`;
                    })}</tr>`,
                )}
              </tbody>
            </table>
          </fieldset>
          <nav class="semanas" aria-label="Cambiar de semana">
            ${week > 0 ? html`<a href="${C.horario}?semana=${week - 1}">« Semana anterior</a>` : ''}
            ${week < 1 ? html`<a href="${C.horario}?semana=${week + 1}">Semana siguiente »</a>` : ''}
          </nav>
          <div class="acciones">
            <a class="boton secundario" href="${C.oficina}">Anterior</a>
            <button type="submit" class="boton">Continuar</button>
          </div>
        </form>`,
      error ? 409 : 200,
    );
  };

  const slotGuard = (c: Ctx): Response | null => {
    const s = session(c);
    if (!s.cita.oficina || !s.cita.servicio) return c.redirect(C.oficina, 303);
    if (config.captchaInCita && !s.captchaPassed) {
      return c.redirect(`/verificacion?continuar=${encodeURIComponent(C.horario)}`, 303);
    }
    return null;
  };

  app.get(C.horario, (c) => slotGuard(c) ?? slotsPage(c, c.req.query('semana') === '1' ? 1 : 0));

  app.post(C.horario, async (c) => {
    const redirect = slotGuard(c);
    if (redirect) return redirect;
    const body = await c.req.parseBody();
    const week = field(body, 'semana') === '1' ? 1 : 0;
    const slot = field(body, 'hueco');
    const s = session(c);
    const [date, time] = slot.split('T');
    if (!date || !time || !days().includes(date) || !SLOT_TIMES.includes(time)) {
      return slotsPage(c, week, 'Elige un día y una hora libres.');
    }
    if (isTaken(s.cita.oficina!, slot)) {
      return slotsPage(c, week, 'Ese hueco ya no está disponible. Elige otro.');
    }
    s.cita.hueco = slot;
    return c.redirect(C.confirmar, 303);
  });

  // --- Step 3: confirmation -----------------------------------------------------------------------
  const confirmPage = (
    c: Ctx,
    values: { telefono?: string; email?: string; privacidad?: boolean },
    errors: Record<string, string> = {},
  ) => {
    const s = session(c);
    const office = OFFICES.find((o) => o.id === s.cita.oficina)!;
    const [date, time] = s.cita.hueco!.split('T');
    return stepPage(
      c,
      2,
      html`${summaryList([
        ['Oficina', `${office.name}. ${office.address}, ${office.city}`],
        ['Servicio', labelOf(APPOINTMENT_SERVICES, s.cita.servicio)],
        ['Día', longSpanishDate(date!)],
        ['Hora', time],
        ['A nombre de', `${s.identity.fullName} (${s.identity.dni})`],
      ])}
        ${errorSummary(errors)}
        <form method="post" action="${C.confirmar}" class="formulario" novalidate>
          ${textField({ name: 'telefono', label: 'Teléfono de contacto', type: 'tel', value: values.telefono, required: true, inputmode: 'tel', help: 'Te enviaremos un recordatorio por SMS (simulado).', error: errors.telefono })}
          ${textField({ name: 'email', label: 'Correo electrónico', type: 'email', value: values.email, error: errors.email })}
          ${checkboxField({ name: 'privacidad', label: 'He leído la información sobre protección de datos', checked: values.privacidad, required: true, error: errors.privacidad })}
          <div class="acciones">
            <a class="boton secundario" href="${C.horario}">Anterior</a>
            <button type="submit" class="boton">Confirmar cita</button>
          </div>
        </form>`,
      Object.keys(errors).length ? 400 : 200,
    );
  };

  const confirmGuard = (c: Ctx): Response | null =>
    slotGuard(c) ?? (session(c).cita.hueco ? null : c.redirect(C.horario, 303));

  app.get(C.confirmar, (c) => {
    const s = session(c);
    return (
      confirmGuard(c) ??
      confirmPage(c, { telefono: s.identity.phone ?? '', email: s.identity.email ?? '' })
    );
  });

  app.post(C.confirmar, async (c) => {
    const redirect = confirmGuard(c);
    if (redirect) return redirect;
    const s = session(c);
    const body = await c.req.parseBody();
    const values = {
      telefono: field(body, 'telefono'),
      email: field(body, 'email'),
      privacidad: field(body, 'privacidad'),
    };
    const parsed = confirmSchema.safeParse(values);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) errors[String(issue.path[0])] ??= issue.message;
      return confirmPage(c, { ...values, privacidad: values.privacidad === 'si' }, errors);
    }
    const slot = s.cita.hueco!;
    if (isTaken(s.cita.oficina!, slot)) {
      s.cita.hueco = undefined;
      return slotsPage(c, 0, 'Lo sentimos: alguien acaba de reservar ese hueco. Elige otro.');
    }
    const appointment: AppointmentRecord = {
      localizador: `CITA-${randomCode(6)}`,
      officeId: s.cita.oficina!,
      service: s.cita.servicio!,
      slot,
      dni: s.identity.dni,
      fullName: s.identity.fullName,
      phone: normalizeMobile(parsed.data.telefono)!,
      email: parsed.data.email || undefined,
      createdAt: new Date(state.now()).toISOString(),
    };
    state.appointments.push(appointment);
    const record: SubmissionRecord = {
      id: randomId(),
      type: 'cita',
      status: 'registered',
      receivedAt: appointment.createdAt,
      applicant: {
        dni: s.identity.dni,
        fullName: s.identity.fullName,
        authMethod: s.identity.method,
        loa: s.identity.loa,
      },
      appointment,
    };
    state.submissions.push(record);
    s.cita = {};
    ctx.log(
      `[Cita] ${appointment.localizador}: ${appointment.fullName} el ${slot} en ${appointment.officeId}`,
    );
    return c.redirect(`${C.justificante}/${appointment.localizador}`, 303);
  });

  // --- Receipt -----------------------------------------------------------------------------------
  const ownAppointment = (c: Ctx) =>
    state.appointments.find(
      (a) => a.localizador === c.req.param('localizador') && a.dni === session(c).identity.dni,
    );

  app.get(`${C.justificante}/:localizador`, (c) => {
    const a = ownAppointment(c);
    if (!a) return c.notFound();
    const office = OFFICES.find((o) => o.id === a.officeId)!;
    const [date, time] = a.slot.split('T');
    return renderSede(c, ctx, {
      title: `Cita confirmada ${a.localizador}`,
      breadcrumbs: [...BREADCRUMBS, { label: 'Cita confirmada' }],
      body: html`<h1>Cita confirmada</h1>
        ${alertBox('exito', 'Tu cita está reservada. Te esperamos.', { title: 'Reserva completada' })}
        ${summaryList([
          ['Localizador', html`<strong id="localizador">${a.localizador}</strong>`],
          ['Oficina', office.name],
          ['Dirección', `${office.address}, ${office.city}`],
          ['Servicio', labelOf(APPOINTMENT_SERVICES, a.service)],
          ['Día', longSpanishDate(date!)],
          ['Hora', time],
          ['A nombre de', `${a.fullName} (${a.dni})`],
        ])}
        <p>Lleva tu DNI o NIE el día de la cita. Llega con 10 minutos de antelación.</p>
        <ul class="descargas">
          <li><a class="boton" href="${C.justificante}/${a.localizador}/pdf?descarga=1" download="cita-${a.localizador}.pdf">Descargar justificante de la cita (PDF)</a></li>
        </ul>
        <p><a href="/">Volver al inicio</a></p>`,
    });
  });

  app.get(`${C.justificante}/:localizador/pdf`, async (c) => {
    const a = ownAppointment(c);
    if (!a) return c.notFound();
    const office = OFFICES.find((o) => o.id === a.officeId)!;
    const [date, time] = a.slot.split('T');
    const pdf = await renderReceiptPdf({
      title: 'Justificante de cita previa',
      reference: { label: 'Localizador', value: a.localizador },
      sections: [
        {
          heading: 'Cita',
          rows: [
            ['Oficina', office.name],
            ['Dirección', `${office.address}, ${office.city}`],
            ['Servicio', labelOf(APPOINTMENT_SERVICES, a.service)],
            ['Día', longSpanishDate(date!)],
            ['Hora', time!],
          ],
        },
        {
          heading: 'Persona citada',
          rows: [
            ['Nombre', a.fullName],
            ['DNI/NIE', a.dni],
            ['Teléfono', a.phone],
            ['Reservada el', formatMadridDateTime(new Date(a.createdAt))],
          ],
        },
      ],
      notes: ['Lleva tu DNI o NIE el día de la cita.'],
      metadata: { title: `Cita previa ${a.localizador}`, subject: NAME, keywords: [a.localizador] },
      createdAt: new Date(a.createdAt),
    });
    const disposition = c.req.query('descarga') ? 'attachment' : 'inline';
    return c.body(pdf, 200, {
      'content-type': 'application/pdf',
      'content-disposition': `${disposition}; filename="cita-${a.localizador}.pdf"`,
    });
  });
}
