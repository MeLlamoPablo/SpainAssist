/**
 * "Solicitud de certificado de residencia (prueba)": multi-step form, review, signature with
 * AutoFirma (CAdES, implicit) and registration receipt with a PDF justificante.
 */
import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { verifyCadesSignature } from '../cades';
import {
  type AppContext,
  type AppEnv,
  type Ctx,
  field,
  PROCEDURES,
  renderSede,
  requireLogin,
} from '../context';
import { COUNTRIES, labelOf, PROVINCES, RESIDENCE_REASONS, STREET_TYPES } from '../data';
import { type HtmlValue, html, type SafeHtml } from '../html';
import { renderReceiptPdf } from '../pdf';
import {
  type AddressData,
  type DocumentationData,
  type PersonalData,
  type ResidenciaDraft,
  randomCode,
  randomId,
  type Session,
  type SignatureReport,
  type SubmissionRecord,
  type UploadedDocument,
} from '../state';
import { formatMadridDateTime } from '../time';
import { isValidEmail, normalizeMobile, parseSpanishDate } from '../validation';
import {
  alertBox,
  checkboxField,
  errorSummary,
  fileField,
  radioGroup,
  selectField,
  stepIndicator,
  summaryList,
  textareaField,
  textField,
} from '../views';

const BASE = '/tramites/residencia';
const RESIDENCIA_PATHS = {
  info: BASE,
  personal: `${BASE}/solicitud/datos-personales`,
  domicilio: `${BASE}/solicitud/domicilio`,
  documentacion: `${BASE}/solicitud/documentacion`,
  revision: `${BASE}/solicitud/revision`,
  enviar: `${BASE}/solicitud/enviar`,
  cancelar: `${BASE}/solicitud/cancelar`,
  justificante: `${BASE}/justificante`,
} as const;
const P = RESIDENCIA_PATHS;
const STEPS = [
  'Datos personales',
  'Domicilio y contacto',
  'Motivo y documentación',
  'Revisión y firma',
];
const STEP_PATHS = [P.personal, P.domicilio, P.documentacion, P.revision];
const NAME = PROCEDURES.residencia.name;
const BREADCRUMBS = [
  { label: 'Trámites', href: '/tramites' },
  { label: NAME, href: P.info },
];

const SEX_OPTIONS = [
  { value: 'M', label: 'Mujer' },
  { value: 'H', label: 'Hombre' },
];

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '_');
    out[key] ??= issue.message;
  }
  return out;
}

const inOptions = (options: { value: string }[]) => (v: string) =>
  options.some((o) => o.value === v);

function personalSchema(now: number) {
  return z.object({
    nombre: z.string().trim().min(1, 'Escribe tu nombre.').max(60, 'El nombre es demasiado largo.'),
    apellido1: z
      .string()
      .trim()
      .min(1, 'Escribe tu primer apellido.')
      .max(60, 'El apellido es demasiado largo.'),
    apellido2: z.string().trim().max(60, 'El apellido es demasiado largo.'),
    fechaNacimiento: z
      .string()
      .trim()
      .min(1, 'Escribe tu fecha de nacimiento.')
      .refine(
        (v) => parseSpanishDate(v) !== null,
        'Escribe la fecha con el formato DD/MM/AAAA, por ejemplo 05/03/1990.',
      )
      .refine((v) => {
        const d = parseSpanishDate(v);
        return !d || (d.getTime() < now && d.getUTCFullYear() >= 1900);
      }, 'La fecha de nacimiento no es válida.'),
    sexo: z.enum(['M', 'H'], { error: 'Indica tu sexo.' }),
    paisNacimiento: z.string().refine(inOptions(COUNTRIES), 'Elige tu país de nacimiento.'),
    nacionalidad: z.string().refine(inOptions(COUNTRIES), 'Elige tu nacionalidad.'),
  });
}

const addressSchema = z
  .object({
    tipoVia: z.string().refine(inOptions(STREET_TYPES), 'Elige el tipo de vía.'),
    via: z
      .string()
      .trim()
      .min(1, 'Escribe el nombre de la vía.')
      .max(100, 'El nombre es demasiado largo.'),
    numero: z
      .string()
      .trim()
      .min(1, 'Escribe el número de la vía (o «s/n» si no tiene).')
      .max(10, 'El número es demasiado largo.'),
    pisoPuerta: z.string().trim().max(20, 'Demasiado largo.'),
    codigoPostal: z
      .string()
      .trim()
      .regex(/^\d{5}$/, 'El código postal debe tener 5 cifras.'),
    municipio: z.string().trim().min(1, 'Escribe el municipio.').max(80, 'Demasiado largo.'),
    provincia: z.string().refine(inOptions(PROVINCES), 'Elige la provincia.'),
    email: z
      .string()
      .trim()
      .min(1, 'Escribe tu correo electrónico.')
      .refine(isValidEmail, 'El correo electrónico no es válido.'),
    emailConfirmacion: z.string().trim(),
    telefono: z
      .string()
      .trim()
      .min(1, 'Escribe tu teléfono móvil.')
      .refine(
        (v) => normalizeMobile(v) !== null,
        'El teléfono debe ser un móvil español de 9 cifras que empiece por 6 o 7.',
      ),
  })
  .superRefine((v, issues) => {
    if (v.email && v.emailConfirmacion.toLowerCase() !== v.email.toLowerCase()) {
      issues.addIssue({
        code: 'custom',
        path: ['emailConfirmacion'],
        message: 'Los dos correos electrónicos no coinciden.',
      });
    }
    if (/^\d{5}$/.test(v.codigoPostal) && v.codigoPostal.slice(0, 2) !== v.provincia) {
      issues.addIssue({
        code: 'custom',
        path: ['codigoPostal'],
        message: 'El código postal no corresponde a la provincia elegida.',
      });
    }
  });

const sendSchema = z.object({
  referencia: z.string().max(40),
  firma: z.string().max(6_000_000),
  certificado: z.string().max(200_000),
});

function firstIncompleteStep(d: ResidenciaDraft): number {
  if (!d.personal) return 0;
  if (!d.domicilio) return 1;
  if (!d.documentacion) return 2;
  return 3;
}

const xmlEscape = (s: string) => s.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The document signed with AutoFirma: a UTF-8 XML rendering of the application. */
function buildSolicitudXml(
  reference: string,
  preparedAt: Date,
  d: { personal: PersonalData; domicilio: AddressData; documentacion: DocumentationData },
): string {
  const { personal: p, domicilio: a, documentacion: doc } = d;
  const e = xmlEscape;
  const docType = /^[XYZ]/.test(p.dni) ? 'NIE' : 'DNI';
  return `<?xml version="1.0" encoding="UTF-8"?>
<SolicitudCertificadoResidencia xmlns="urn:mock-sede:tramites:residencia:1" version="1.0">
  <Referencia>${e(reference)}</Referencia>
  <FechaPreparacion>${preparedAt.toISOString()}</FechaPreparacion>
  <Organismo>Ministerio de Trámites Simulados (ficticio)</Organismo>
  <Solicitante>
    <Documento tipo="${docType}">${e(p.dni)}</Documento>
    <Nombre>${e(p.nombre)}</Nombre>
    <PrimerApellido>${e(p.apellido1)}</PrimerApellido>
    <SegundoApellido>${e(p.apellido2)}</SegundoApellido>
    <FechaNacimiento>${e(p.fechaNacimiento)}</FechaNacimiento>
    <Sexo>${p.sexo}</Sexo>
    <PaisNacimiento codigo="${e(p.paisNacimiento)}">${e(labelOf(COUNTRIES, p.paisNacimiento))}</PaisNacimiento>
    <Nacionalidad codigo="${e(p.nacionalidad)}">${e(labelOf(COUNTRIES, p.nacionalidad))}</Nacionalidad>
  </Solicitante>
  <Domicilio>
    <TipoVia>${e(a.tipoVia)}</TipoVia>
    <Via>${e(a.via)}</Via>
    <Numero>${e(a.numero)}</Numero>
    <PisoPuerta>${e(a.pisoPuerta)}</PisoPuerta>
    <CodigoPostal>${e(a.codigoPostal)}</CodigoPostal>
    <Municipio>${e(a.municipio)}</Municipio>
    <Provincia codigo="${e(a.provincia)}">${e(labelOf(PROVINCES, a.provincia))}</Provincia>
  </Domicilio>
  <Contacto>
    <CorreoElectronico>${e(a.email)}</CorreoElectronico>
    <TelefonoMovil>${e(a.telefono)}</TelefonoMovil>
  </Contacto>
  <Motivo codigo="${e(doc.motivo)}">${e(labelOf(RESIDENCE_REASONS, doc.motivo))}</Motivo>
  <MotivoDetalle>${e(doc.motivoOtro)}</MotivoDetalle>
  <DocumentoAportado nombre="${e(doc.documento.name)}" tipo="${e(doc.documento.mimeType)}" bytes="${doc.documento.size}" sha256="${doc.documento.sha256}"/>
  <Declaracion>El solicitante declara que los datos de esta solicitud son ciertos.</Declaracion>
  <AvisosCorreo>${doc.avisos}</AvisosCorreo>
</SolicitudCertificadoResidencia>
`;
}

function addressLine(a: AddressData): string {
  return `${a.tipoVia} ${a.via}, ${a.numero}${a.pisoPuerta ? `, ${a.pisoPuerta}` : ''}. ${a.codigoPostal} ${a.municipio} (${labelOf(PROVINCES, a.provincia)})`;
}

function sniffDocument(bytes: Uint8Array, name: string): 'application/pdf' | 'image/jpeg' | null {
  const ext = name.toLowerCase().split('.').pop();
  const isPdf =
    bytes.length > 4 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';
  const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (isPdf && ext === 'pdf') return 'application/pdf';
  if (isJpeg && (ext === 'jpg' || ext === 'jpeg')) return 'image/jpeg';
  return null;
}

export function registerResidenciaRoutes(app: Hono<AppEnv>, ctx: AppContext): void {
  const { state, config } = ctx;
  const session = (c: Ctx) => c.get('session') as Session;

  app.use(`${BASE}/solicitud/*`, requireLogin('residencia'));
  app.use(`${P.justificante}/*`, requireLogin('residencia'));

  const cancelForm = html`<form method="post" action="${P.cancelar}" class="cancelar" data-confirm="¿Seguro que quieres cancelar la solicitud? Se perderán los datos que has escrito.">
    <button type="submit" class="enlace">Cancelar solicitud</button>
  </form>`;

  const stepPage = (
    c: Ctx,
    step: number,
    body: HtmlValue,
    opts: { status?: 200 | 400 | 409 | 413 | 422; scripts?: string[] } = {},
  ) =>
    renderSede(
      c,
      ctx,
      {
        title: `${STEPS[step]} - ${NAME}`,
        breadcrumbs: [...BREADCRUMBS, { label: 'Solicitud' }],
        scripts: opts.scripts,
        body: html`<h1>${NAME}</h1>
          ${stepIndicator(STEPS, step)}
          <h2>${STEPS[step]}</h2>
          ${body}`,
      },
      opts.status ?? 200,
    );

  /** Redirects to the first incomplete step when a later one is requested. */
  const guard = (c: Ctx, step: number): Response | null => {
    const first = firstIncompleteStep(session(c).residencia);
    return step > first ? c.redirect(STEP_PATHS[first]!, 303) : null;
  };

  app.get(P.info, (c) =>
    renderSede(c, ctx, {
      title: NAME,
      breadcrumbs: [{ label: 'Trámites', href: '/tramites' }, { label: NAME }],
      body: html`<h1>${NAME}</h1>
        ${c.req.query('cancelada') ? alertBox('info', 'Has cancelado la solicitud. No se ha enviado nada.') : ''}
        <p class="intro">Con este trámite pides un certificado que acredita dónde vives. Es un trámite ficticio: no se envía a ninguna Administración real.</p>
        <h2>Qué necesitas</h2>
        <ul>
          <li>Identificarte con nivel de seguridad sustancial: Cl@ve Móvil, Cl@ve Permanente con código SMS o certificado electrónico.</li>
          <li>Un certificado electrónico y AutoFirma para firmar la solicitud.</li>
          <li>Un documento que acredite tu domicilio (contrato de alquiler, escritura o recibo), en PDF o JPG de hasta 5 MB.</li>
        </ul>
        <h2>Plazo y coste</h2>
        <p>Es gratuito. Al terminar recibirás un justificante de registro en PDF.</p>
        <p><a class="boton" href="${P.personal}">Iniciar solicitud</a></p>`,
    }),
  );

  app.post(P.cancelar, (c) => {
    session(c).residencia = {};
    return c.redirect(`${P.info}?cancelada=1`, 303);
  });

  // --- Step 1: personal data -------------------------------------------------------------------
  const personalPage = (
    c: Ctx,
    values: Partial<Record<keyof PersonalData, string>>,
    errors: Record<string, string> = {},
  ) =>
    stepPage(
      c,
      0,
      html`<p>Los campos marcados con <span class="req">*</span> son obligatorios.</p>
        ${errorSummary(errors)}
        <form method="post" action="${P.personal}" class="formulario" novalidate>
          ${textField({
            name: 'dni',
            label: 'DNI/NIE',
            value: session(c).identity.dni,
            readonly: true,
            required: true,
            help: 'Lo hemos obtenido de tu identificación y no se puede cambiar.',
          })}
          ${textField({ name: 'nombre', label: 'Nombre', value: values.nombre, required: true, autocomplete: 'given-name', error: errors.nombre })}
          ${textField({ name: 'apellido1', label: 'Primer apellido', value: values.apellido1, required: true, autocomplete: 'family-name', error: errors.apellido1 })}
          ${textField({ name: 'apellido2', label: 'Segundo apellido', value: values.apellido2, error: errors.apellido2 })}
          ${textField({
            name: 'fechaNacimiento',
            label: 'Fecha de nacimiento',
            value: values.fechaNacimiento,
            required: true,
            placeholder: 'DD/MM/AAAA',
            inputmode: 'numeric',
            maxlength: 10,
            help: 'Formato DD/MM/AAAA, con barras. Por ejemplo: 05/03/1990.',
            error: errors.fechaNacimiento,
          })}
          ${radioGroup({ name: 'sexo', label: 'Sexo', options: SEX_OPTIONS, value: values.sexo, required: true, error: errors.sexo })}
          ${selectField({ name: 'paisNacimiento', label: 'País de nacimiento', options: COUNTRIES, value: values.paisNacimiento, required: true, error: errors.paisNacimiento })}
          ${selectField({ name: 'nacionalidad', label: 'Nacionalidad', options: COUNTRIES, value: values.nacionalidad, required: true, error: errors.nacionalidad })}
          <div class="acciones"><button type="submit" class="boton">Continuar</button></div>
        </form>
        ${cancelForm}`,
      { status: Object.keys(errors).length ? 400 : 200 },
    );

  app.get(P.personal, (c) => {
    const s = session(c);
    const saved = s.residencia.personal;
    return personalPage(
      c,
      saved ?? {
        nombre: s.identity.givenName,
        apellido1: s.identity.surname1,
        apellido2: s.identity.surname2 ?? '',
      },
    );
  });

  app.post(P.personal, async (c) => {
    const s = session(c);
    const body = await c.req.parseBody();
    const values = Object.fromEntries(
      [
        'nombre',
        'apellido1',
        'apellido2',
        'fechaNacimiento',
        'sexo',
        'paisNacimiento',
        'nacionalidad',
      ].map((k) => [k, field(body, k)]),
    );
    const parsed = personalSchema(state.now()).safeParse(values);
    if (!parsed.success) return personalPage(c, values, fieldErrors(parsed.error));
    s.residencia.personal = { dni: s.identity.dni, ...parsed.data };
    return c.redirect(P.domicilio, 303);
  });

  // --- Step 2: address and contact -------------------------------------------------------------
  const addressPage = (
    c: Ctx,
    values: Partial<Record<keyof AddressData | 'emailConfirmacion', string>>,
    errors: Record<string, string> = {},
  ) =>
    stepPage(
      c,
      1,
      html`<p>Indica el domicilio que quieres que conste en el certificado.</p>
        ${errorSummary(errors)}
        <form method="post" action="${P.domicilio}" class="formulario" novalidate>
          <fieldset class="grupo-campos">
            <legend>Domicilio</legend>
            ${selectField({ name: 'tipoVia', label: 'Tipo de vía', options: STREET_TYPES, value: values.tipoVia, required: true, error: errors.tipoVia })}
            ${textField({ name: 'via', label: 'Nombre de la vía', value: values.via, required: true, autocomplete: 'address-line1', error: errors.via })}
            ${textField({ name: 'numero', label: 'Número', value: values.numero, required: true, help: 'Si la vía no tiene número, escribe «s/n».', error: errors.numero })}
            ${textField({ name: 'pisoPuerta', label: 'Piso y puerta', value: values.pisoPuerta, help: 'Por ejemplo: 2º B', error: errors.pisoPuerta })}
            ${textField({ name: 'codigoPostal', label: 'Código postal', value: values.codigoPostal, required: true, inputmode: 'numeric', maxlength: 5, autocomplete: 'postal-code', error: errors.codigoPostal })}
            ${textField({ name: 'municipio', label: 'Municipio', value: values.municipio, required: true, autocomplete: 'address-level2', error: errors.municipio })}
            ${selectField({ name: 'provincia', label: 'Provincia', options: PROVINCES, value: values.provincia, required: true, placeholder: 'Selecciona la provincia', error: errors.provincia })}
          </fieldset>
          <fieldset class="grupo-campos">
            <legend>Datos de contacto</legend>
            ${textField({ name: 'email', label: 'Correo electrónico', type: 'email', value: values.email, required: true, autocomplete: 'email', error: errors.email })}
            ${textField({ name: 'emailConfirmacion', label: 'Repite el correo electrónico', type: 'email', value: values.emailConfirmacion, required: true, autocomplete: 'off', help: 'Escríbelo de nuevo para comprobar que es correcto.', error: errors.emailConfirmacion })}
            ${textField({ name: 'telefono', label: 'Teléfono móvil', type: 'tel', value: values.telefono, required: true, inputmode: 'tel', autocomplete: 'tel', help: '9 cifras. Por ejemplo: 612345678', error: errors.telefono })}
          </fieldset>
          <div class="acciones">
            <a class="boton secundario" href="${P.personal}">Anterior</a>
            <button type="submit" class="boton">Continuar</button>
          </div>
        </form>
        ${cancelForm}`,
      { status: Object.keys(errors).length ? 400 : 200 },
    );

  app.get(P.domicilio, (c) => {
    const redirect = guard(c, 1);
    if (redirect) return redirect;
    const s = session(c);
    const saved = s.residencia.domicilio;
    return addressPage(
      c,
      saved
        ? { ...saved, emailConfirmacion: saved.email }
        : { email: s.identity.email ?? '', telefono: s.identity.phone ?? '' },
    );
  });

  app.post(P.domicilio, async (c) => {
    const redirect = guard(c, 1);
    if (redirect) return redirect;
    const body = await c.req.parseBody();
    const values = Object.fromEntries(
      [
        'tipoVia',
        'via',
        'numero',
        'pisoPuerta',
        'codigoPostal',
        'municipio',
        'provincia',
        'email',
        'emailConfirmacion',
        'telefono',
      ].map((k) => [k, field(body, k)]),
    );
    const parsed = addressSchema.safeParse(values);
    if (!parsed.success) return addressPage(c, values, fieldErrors(parsed.error));
    const { emailConfirmacion: _confirm, ...address } = parsed.data;
    session(c).residencia.domicilio = {
      ...address,
      email: address.email.toLowerCase(),
      telefono: normalizeMobile(address.telefono)!,
    };
    return c.redirect(P.documentacion, 303);
  });

  // --- Step 3: reason, document upload and declaration -----------------------------------------
  const documentationPage = (
    c: Ctx,
    values: { motivo?: string; motivoOtro?: string; declaracion?: boolean; avisos?: boolean },
    errors: Record<string, string> = {},
    status: 200 | 400 | 413 = 200,
  ) => {
    const d = session(c).residencia;
    const current = d.pendingDocument ?? d.documentacion?.documento;
    return stepPage(
      c,
      2,
      html`${errorSummary(errors)}
        <form method="post" action="${P.documentacion}" class="formulario" enctype="multipart/form-data" novalidate>
          ${selectField({ name: 'motivo', label: 'Motivo de la solicitud', options: RESIDENCE_REASONS, value: values.motivo, required: true, error: errors.motivo })}
          ${textareaField({ name: 'motivoOtro', label: 'Explica el motivo', value: values.motivoOtro, help: 'Solo si has elegido «Otros motivos».', error: errors.motivoOtro })}
          ${fileField({
            name: 'documento',
            label: 'Documento que acredita tu domicilio',
            accept: '.pdf,.jpg,.jpeg,application/pdf,image/jpeg',
            required: true,
            help: 'Contrato de alquiler, escritura o un recibo a tu nombre. Formato PDF o JPG. Tamaño máximo: 5 MB.',
            current: current ? `${current.name} (${Math.ceil(current.size / 1024)} KB)` : undefined,
            error: errors.documento,
          })}
          ${checkboxField({
            name: 'declaracion',
            label: 'Declaro que los datos son ciertos',
            checked: values.declaracion,
            required: true,
            help: 'Dar datos falsos en una solicitud puede tener consecuencias legales.',
            error: errors.declaracion,
          })}
          ${checkboxField({
            name: 'avisos',
            label: 'Quiero recibir avisos por correo electrónico sobre esta solicitud',
            checked: values.avisos,
          })}
          <div class="acciones">
            <a class="boton secundario" href="${P.domicilio}">Anterior</a>
            <button type="submit" class="boton">Continuar</button>
          </div>
        </form>
        ${cancelForm}`,
      { status },
    );
  };

  app.get(P.documentacion, (c) => {
    const redirect = guard(c, 2);
    if (redirect) return redirect;
    const saved = session(c).residencia.documentacion;
    return documentationPage(c, saved ?? {});
  });

  app.post(
    P.documentacion,
    bodyLimit({
      maxSize: config.maxUploadBytes * 2,
      onError: (c) =>
        documentationPage(
          c as Ctx,
          {},
          { documento: 'El documento no puede ocupar más de 5 MB.' },
          413,
        ),
    }),
    async (c) => {
      const redirect = guard(c, 2);
      if (redirect) return redirect;
      const d = session(c).residencia;
      const body = await c.req.parseBody();
      const values = {
        motivo: field(body, 'motivo'),
        motivoOtro: field(body, 'motivoOtro'),
        declaracion: field(body, 'declaracion') === 'si',
        avisos: field(body, 'avisos') === 'si',
      };
      const errors: Record<string, string> = {};
      if (!RESIDENCE_REASONS.some((r) => r.value === values.motivo)) {
        errors.motivo = 'Elige el motivo de la solicitud.';
      }
      if (values.motivo === 'otros' && !values.motivoOtro) {
        errors.motivoOtro = 'Explica el motivo de la solicitud.';
      }
      if (values.motivoOtro.length > 500)
        errors.motivoOtro = 'El texto no puede pasar de 500 caracteres.';

      const file = body.documento;
      if (file instanceof File && file.size > 0) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const name = (file.name.split(/[\\/]/).pop() ?? 'documento').slice(0, 100);
        const mimeType = sniffDocument(bytes, name);
        if (bytes.length > config.maxUploadBytes) {
          errors.documento = 'El documento no puede ocupar más de 5 MB.';
        } else if (!mimeType) {
          errors.documento = 'El documento debe ser un PDF o una imagen JPG.';
        } else {
          const doc: UploadedDocument = {
            name,
            size: bytes.length,
            mimeType,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          };
          d.pendingDocument = doc;
        }
      } else if (!d.pendingDocument && !d.documentacion?.documento) {
        errors.documento = 'Adjunta un documento que acredite tu domicilio.';
      }
      if (!values.declaracion) {
        errors.declaracion = 'Para continuar tienes que declarar que los datos son ciertos.';
      }
      if (Object.keys(errors).length) return documentationPage(c, values, errors, 400);

      const documento = (d.pendingDocument ?? d.documentacion?.documento)!;
      d.documentacion = {
        motivo: values.motivo,
        motivoOtro: values.motivo === 'otros' ? values.motivoOtro : '',
        documento,
        declaracion: true,
        avisos: values.avisos,
      };
      d.pendingDocument = undefined;
      return c.redirect(P.revision, 303);
    },
  );

  // --- Step 4: review and signature ------------------------------------------------------------
  const reviewPage = (c: Ctx, opts: { error?: HtmlValue; status?: 200 | 400 | 409 | 422 } = {}) => {
    const s = session(c);
    const d = s.residencia;
    const personal = d.personal!;
    const address = d.domicilio!;
    const docs = d.documentacion!;
    const reference = `SOL-${randomCode(10)}`;
    const xml = buildSolicitudXml(reference, new Date(state.now()), {
      personal,
      domicilio: address,
      documentacion: docs,
    });
    d.toSign = { reference, xml, preparedAt: state.now() };
    const block = (
      title: string,
      rows: [string, HtmlValue][],
      editHref: string,
      editLabel: string,
    ) =>
      html`<section class="bloque-resumen">
        <h3>${title}</h3>
        ${summaryList(rows)}
        <p><a href="${editHref}">${editLabel}</a></p>
      </section>`;
    return stepPage(
      c,
      3,
      html`<p>Revisa tus datos antes de firmar. Si algo no es correcto, pulsa «Modificar».</p>
        ${block(
          'Datos personales',
          [
            ['DNI/NIE', personal.dni],
            [
              'Nombre y apellidos',
              `${personal.nombre} ${personal.apellido1} ${personal.apellido2}`.trim(),
            ],
            ['Fecha de nacimiento', personal.fechaNacimiento],
            ['Sexo', labelOf(SEX_OPTIONS, personal.sexo)],
            ['País de nacimiento', labelOf(COUNTRIES, personal.paisNacimiento)],
            ['Nacionalidad', labelOf(COUNTRIES, personal.nacionalidad)],
          ],
          P.personal,
          'Modificar datos personales',
        )}
        ${block(
          'Domicilio y contacto',
          [
            ['Domicilio', addressLine(address)],
            ['Correo electrónico', address.email],
            ['Teléfono móvil', address.telefono],
          ],
          P.domicilio,
          'Modificar domicilio y contacto',
        )}
        ${block(
          'Motivo y documentación',
          [
            ['Motivo', labelOf(RESIDENCE_REASONS, docs.motivo)],
            ...(docs.motivoOtro
              ? [['Detalle del motivo', docs.motivoOtro] as [string, string]]
              : []),
            ['Documento', `${docs.documento.name} (${Math.ceil(docs.documento.size / 1024)} KB)`],
            ['Avisos por correo', docs.avisos ? 'Sí' : 'No'],
          ],
          P.documentacion,
          'Modificar motivo y documentación',
        )}
        <section class="bloque-firma" aria-labelledby="firma-titulo">
          <h3 id="firma-titulo">Firma y envío</h3>
          <p>Para presentar la solicitud tienes que firmarla con tu certificado electrónico. Al pulsar «Firmar y enviar» se abrirá AutoFirma para que elijas tu certificado. No cierres esta página mientras firmas.</p>
          ${opts.error ? alertBox('error', opts.error, { id: 'error-servidor', title: 'No se ha podido presentar la solicitud' }) : ''}
          <div id="error-firma" class="alerta alerta-error" role="alert" hidden></div>
          <p id="estado-firma" class="estado-firma" role="status" aria-live="polite"></p>
          <form method="post" action="${P.enviar}" id="form-firma">
            <input type="hidden" name="referencia" value="${reference}">
            <input type="hidden" name="datos" value="${Buffer.from(xml, 'utf8').toString('base64')}">
            <input type="hidden" name="firma" value="">
            <input type="hidden" name="certificado" value="">
            <div class="acciones">
              <a class="boton secundario" href="${P.documentacion}">Anterior</a>
              <button type="button" class="boton" id="boton-firmar">Firmar y enviar</button>
            </div>
          </form>
          <details class="documento-firma">
            <summary>Ver el documento que vas a firmar</summary>
            <pre>${xml}</pre>
          </details>
        </section>
        ${cancelForm}`,
      { status: opts.status, scripts: ['/js/autoscript.js', '/js/tramite-firma.js'] },
    );
  };

  app.get(P.revision, (c) => guard(c, 3) ?? reviewPage(c));

  app.post(P.enviar, bodyLimit({ maxSize: 8 * 1024 * 1024 }), async (c) => {
    const redirect = guard(c, 3);
    if (redirect) return redirect;
    const s = session(c);
    const d = s.residencia;
    const parsed = sendSchema.safeParse(await c.req.parseBody());
    if (!parsed.success || !parsed.data.firma) {
      return reviewPage(c, {
        error: 'No se ha recibido la firma. Pulsa «Firmar y enviar» para firmar de nuevo.',
        status: 400,
      });
    }
    if (!d.toSign || d.toSign.reference !== parsed.data.referencia) {
      return reviewPage(c, {
        error:
          'Los datos de la solicitud han cambiado desde que se preparó la firma. Revísalos y vuelve a firmar.',
        status: 409,
      });
    }
    const signedXml = d.toSign.xml;
    const verification = verifyCadesSignature({
      signature: parsed.data.firma,
      expectedContent: Buffer.from(signedXml, 'utf8'),
      certificateArgument: parsed.data.certificado,
      now: new Date(state.now()),
    });
    const signerMatchesApplicant = verification.signer?.dni === s.identity.dni;
    const report: SignatureReport = {
      valid: verification.valid,
      error: verification.error,
      checks: verification.checks,
      mode: verification.mode,
      signingTime: verification.signingTime?.toISOString(),
      signer: verification.signer && {
        dni: verification.signer.dni,
        commonName: verification.signer.commonName,
        issuer: verification.signer.issuerCommonName,
        serial: verification.signer.serial,
        sha256: verification.signer.sha256,
      },
      signerMatchesApplicant,
      signatureBytes: Math.floor((parsed.data.firma.replace(/\s+/g, '').length * 3) / 4),
    };
    const accepted = verification.valid && signerMatchesApplicant;
    const record: SubmissionRecord = {
      id: randomId(),
      type: 'residencia',
      status: accepted ? 'registered' : 'rejected',
      receivedAt: new Date(state.now()).toISOString(),
      applicant: {
        dni: s.identity.dni,
        fullName: s.identity.fullName,
        authMethod: s.identity.method,
        loa: s.identity.loa,
      },
      form: { personal: d.personal!, domicilio: d.domicilio!, documentacion: d.documentacion! },
      signedXml,
      signature: report,
    };
    if (accepted) {
      record.registrationNumber = state.nextRegistrationNumber();
      record.csv = `MOCK-${randomCode(4)}-${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;
    }
    state.submissions.push(record);
    ctx.log(
      accepted
        ? `[Registro] Solicitud ${record.registrationNumber} registrada (firma de ${verification.signer?.commonName})`
        : `[Registro] Solicitud rechazada: ${verification.error ?? 'el firmante no es el solicitante'}`,
    );
    if (!accepted) {
      const error: SafeHtml | string = !verification.valid
        ? `La firma no es válida: ${verification.error}`
        : html`Has firmado con el certificado de <strong>${verification.signer?.commonName ?? 'otra persona'}</strong>, pero la solicitud es de <strong>${s.identity.fullName} (${s.identity.dni})</strong>. Firma con tu propio certificado.`;
      return reviewPage(c, { error, status: 422 });
    }
    s.residencia = {};
    return c.redirect(`${P.justificante}/${record.registrationNumber}`, 303);
  });

  // --- Receipt -----------------------------------------------------------------------------------
  const ownSubmission = (c: Ctx): SubmissionRecord | undefined => {
    const numero = c.req.param('numero');
    return state.submissions.find(
      (r) =>
        r.type === 'residencia' &&
        r.status === 'registered' &&
        r.registrationNumber === numero &&
        r.applicant.dni === session(c).identity.dni,
    );
  };

  app.get(`${P.justificante}/:numero`, (c) => {
    const record = ownSubmission(c);
    if (!record) return c.notFound();
    const p = record.form!.personal;
    const num = record.registrationNumber!;
    return renderSede(c, ctx, {
      title: `Justificante de registro ${num}`,
      breadcrumbs: [...BREADCRUMBS, { label: 'Justificante' }],
      body: html`<h1>Justificante de registro</h1>
        ${alertBox('exito', 'Hemos recibido tu solicitud. Guarda el justificante: es la prueba de que la has presentado.', { title: 'Solicitud presentada correctamente' })}
        ${summaryList([
          ['Número de registro', html`<strong id="numero-registro">${num}</strong>`],
          ['Fecha y hora de presentación', formatMadridDateTime(new Date(record.receivedAt))],
          ['Trámite', NAME],
          ['Solicitante', `${p.nombre} ${p.apellido1} ${p.apellido2}`.trim()],
          ['DNI/NIE', p.dni],
          ['Código seguro de verificación (CSV)', record.csv],
          ['Firmado por', record.signature?.signer?.commonName],
          ['Documento aportado', record.form!.documentacion.documento.name],
        ])}
        <ul class="descargas">
          <li><a class="boton" href="${P.justificante}/${num}/pdf?descarga=1" download="justificante-${num}.pdf">Descargar justificante (PDF)</a></li>
          <li><a href="${P.justificante}/${num}/pdf" target="_blank" rel="noopener">Ver el justificante en el navegador</a></li>
        </ul>
        <p><a href="/">Volver al inicio</a></p>`,
    });
  });

  app.get(`${P.justificante}/:numero/pdf`, async (c) => {
    const record = ownSubmission(c);
    if (!record) return c.notFound();
    const num = record.registrationNumber!;
    const { personal: p, domicilio: a, documentacion: docs } = record.form!;
    const signer = record.signature?.signer;
    const pdf = await renderReceiptPdf({
      title: 'Justificante de presentación',
      reference: { label: 'Número de registro', value: num },
      sections: [
        {
          heading: 'Presentación',
          rows: [
            ['Fecha y hora', formatMadridDateTime(new Date(record.receivedAt))],
            ['Trámite', NAME],
            ['Órgano destinatario', 'Oficina de Certificados (ficticia)'],
            ['Código seguro de verificación (CSV)', record.csv!],
          ],
        },
        {
          heading: 'Solicitante',
          rows: [
            ['Nombre y apellidos', `${p.nombre} ${p.apellido1} ${p.apellido2}`.trim()],
            ['DNI/NIE', p.dni],
            ['Fecha de nacimiento', p.fechaNacimiento],
            ['Domicilio', addressLine(a)],
            ['Correo electrónico', a.email],
            ['Teléfono móvil', a.telefono],
          ],
        },
        {
          heading: 'Solicitud',
          rows: [
            ['Motivo', labelOf(RESIDENCE_REASONS, docs.motivo)],
            ['Documento aportado', `${docs.documento.name} (${docs.documento.size} bytes)`],
            ['Huella SHA-256 del documento', docs.documento.sha256],
          ],
        },
        {
          heading: 'Firma electrónica',
          rows: [
            ['Formato', 'CAdES-BES implícita, SHA-256 con RSA'],
            ['Firmante', signer?.commonName ?? ''],
            ['Emisor del certificado', signer?.issuer ?? ''],
            ['Número de serie', signer?.serial ?? ''],
            [
              'Momento de la firma',
              record.signature?.signingTime
                ? formatMadridDateTime(new Date(record.signature.signingTime))
                : '',
            ],
          ],
        },
      ],
      notes: [
        'Conserva este justificante. Acredita que has presentado la solicitud en la fecha y hora indicadas.',
      ],
      metadata: {
        title: `Justificante de registro ${num}`,
        subject: NAME,
        keywords: [num, record.csv!],
      },
      createdAt: new Date(record.receivedAt),
    });
    const disposition = c.req.query('descarga') ? 'attachment' : 'inline';
    return c.body(pdf, 200, {
      'content-type': 'application/pdf',
      'content-disposition': `${disposition}; filename="justificante-${num}.pdf"`,
      'cache-control': 'no-store',
    });
  });
}
