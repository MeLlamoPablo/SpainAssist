import { HUMAN_AUTHOR } from '@sa/shared';
import type { Db } from '../db/types';
import { countFeedback, insertFeedback, type NewFeedback } from './repo';

/**
 * Example learnings for development (DEV_SEED=1). Generic, PII-free, written by a human and
 * tagged "seed" so they can be told apart from real submissions (and deleted with the admin API).
 */
const SEED_TAG = 'seed';

type Seed = Omit<NewFeedback, 'createdAt' | 'author'> & { daysAgo: number };

export const SEED_FEEDBACK: Seed[] = [
  {
    procedure: 'Renovación del DNI',
    administration: 'Policía Nacional',
    kind: 'tip',
    title: 'Cita previa para renovar el DNI: los huecos salen por tandas',
    body: 'Si la web de cita previa no muestra huecos para renovar el DNI, vuelve a mirar a primera hora de la mañana: las citas se liberan por tandas. Prueba también otras oficinas de expedición de tu provincia; a veces hay hueco en días.',
    tags: ['dni', 'cita previa', 'renovación'],
    urls: ['https://www.citapreviadnie.es/'],
    daysAgo: 12,
  },
  {
    procedure: 'Renovación del DNI',
    administration: 'Policía Nacional',
    kind: 'gotcha',
    title: 'La tasa de renovación del DNI se paga en la oficina',
    body: 'Lleva el DNI anterior aunque esté caducado. La tasa (12,00 €) se paga en la propia oficina el día de la cita, normalmente con tarjeta o en efectivo. Si cambias de domicilio, dilo al empezar para que lo actualicen.',
    tags: ['dni', 'tasa', 'renovación'],
    urls: [],
    daysAgo: 40,
  },
  {
    procedure: 'Empadronamiento',
    administration: 'Ayuntamiento de Madrid',
    region: 'Comunidad de Madrid',
    kind: 'tip',
    title: 'Empadronamiento en Madrid: contrato de alquiler completo',
    body: 'Para empadronarte con contrato de alquiler lleva el contrato completo (todas las páginas, firmado) y tu documento de identidad en vigor. Se pide cita previa en Línea Madrid; sin cita es difícil que te atiendan.',
    tags: ['padrón', 'empadronamiento', 'alquiler'],
    urls: ['https://www.madrid.es/'],
    daysAgo: 25,
  },
  {
    procedure: 'Volante de empadronamiento',
    administration: 'Ayuntamiento de Madrid',
    region: 'Comunidad de Madrid',
    kind: 'tip',
    title: 'El volante de empadronamiento se descarga en línea',
    body: 'El volante o certificado de empadronamiento se puede obtener en la sede electrónica con Cl@ve o certificado digital, sin ir a la oficina. Se descarga en PDF al momento.',
    tags: ['padrón', 'volante', 'cl@ve'],
    urls: ['https://sede.madrid.es/'],
    daysAgo: 60,
  },
  {
    procedure: 'Acceso con Cl@ve PIN',
    administration: 'Cl@ve',
    kind: 'friction',
    title: 'El código de Cl@ve PIN caduca en pocos minutos',
    body: 'El código que llega por SMS o a la app Cl@ve caduca a los pocos minutos. Ten el móvil a mano antes de pulsar Acceder y no cambies de pestaña mientras esperas. Si caduca, pide otro: no reutilices el anterior.',
    tags: ['cl@ve', 'sms', 'identificación'],
    urls: ['https://clave.gob.es/'],
    daysAgo: 8,
  },
  {
    procedure: 'Certificado digital de persona física',
    administration: 'FNMT-RCM',
    kind: 'gotcha',
    title: 'Certificado FNMT: hay que acreditar la identidad antes de descargarlo',
    body: 'Tras solicitar el certificado de persona física recibes un código de solicitud. Con él acreditas tu identidad (en una oficina de registro con cita, o por videoidentificación si está disponible). Después descárgalo desde el mismo ordenador y navegador con el que lo pediste: si no, falla la descarga.',
    tags: ['certificado digital', 'fnmt', 'identificación'],
    urls: ['https://www.sede.fnmt.gob.es/certificados/persona-fisica'],
    daysAgo: 30,
  },
  {
    procedure: 'Presentación en el Registro Electrónico General',
    administration: 'Administración General del Estado',
    kind: 'friction',
    title: 'Firmar con AutoFirma en el REC: permite abrir la aplicación',
    body: 'Al firmar el envío en el Registro Electrónico General, el navegador pregunta si abrir AutoFirma. Si se bloquea, la firma no termina y la sesión caduca. Acepta la apertura de enlaces de AutoFirma y no cierres la pestaña hasta ver el justificante.',
    tags: ['autofirma', 'rec', 'firma electrónica'],
    urls: ['https://rec.redsara.es/'],
    daysAgo: 15,
  },
  {
    procedure: 'Prestación por desempleo',
    administration: 'SEPE',
    kind: 'gotcha',
    title: 'Paro: pídelo en los 15 días hábiles siguientes',
    body: 'La prestación por desempleo hay que solicitarla en los 15 días hábiles siguientes a quedarte sin trabajo (tras las vacaciones no disfrutadas, si las hay). Si la pides tarde, pierdes los días de retraso.',
    tags: ['sepe', 'paro', 'plazo'],
    urls: ['https://sede.sepe.gob.es/'],
    daysAgo: 50,
  },
  {
    procedure: 'Toma de huellas para la TIE',
    administration: 'Policía Nacional - Extranjería',
    kind: 'tip',
    title: 'Cita de huellas para la TIE: elige bien provincia y trámite',
    body: 'Las citas de extranjería para huellas se agotan rápido. Elige primero la provincia y después el trámite de toma de huella; si no hay huecos, vuelve a intentarlo a otras horas del día. Lleva la resolución favorable y el justificante de la tasa (modelo 790 código 012).',
    tags: ['tie', 'extranjería', 'cita previa', 'huellas'],
    urls: ['https://icp.administracionelectronica.gob.es/icpplus/index.html'],
    daysAgo: 20,
  },
  {
    procedure: 'Informe de vida laboral',
    administration: 'Seguridad Social',
    kind: 'tip',
    title: 'La vida laboral se descarga al momento con Cl@ve',
    body: 'El informe de vida laboral se descarga al instante en la sede de la Seguridad Social identificándote con Cl@ve o certificado. No hace falta pedir cita ni esperar a que llegue por correo.',
    tags: ['vida laboral', 'seguridad social', 'cl@ve'],
    urls: ['https://sede.seg-social.gob.es/'],
    daysAgo: 70,
  },
  {
    procedure: 'Prestación por nacimiento y cuidado de menor',
    administration: 'INSS',
    kind: 'friction',
    title: 'Prestación por nacimiento: la empresa debe enviar su certificado',
    body: 'La solicitud se puede hacer en línea en la sede de la Seguridad Social, pero queda parada hasta que la empresa envía el certificado de empresa. Avisa a tu empresa al pedirla para que no se retrase.',
    tags: ['nacimiento', 'inss', 'seguridad social'],
    urls: ['https://sede.seg-social.gob.es/'],
    daysAgo: 35,
  },
  {
    procedure: 'Declaración de la renta',
    administration: 'Agencia Tributaria',
    kind: 'tip',
    title: 'Renta: pide cita para el plan "Le Llamamos" con tiempo',
    body: 'Si quieres que la Agencia Tributaria te haga la declaración por teléfono, pide cita en su sede al abrirse el plazo. Necesitas identificarte con Cl@ve, certificado o el número de referencia de la renta.',
    tags: ['renta', 'aeat', 'cita previa'],
    urls: ['https://sede.agenciatributaria.gob.es/'],
    daysAgo: 90,
  },
];

/** Inserts the seed learnings unless they are already there. Returns how many were added. */
export async function seedFeedback(db: Db, now = Date.now()): Promise<number> {
  if ((await countFeedback(db, SEED_TAG)) > 0) return 0;
  for (const { daysAgo, ...entry } of SEED_FEEDBACK) {
    await insertFeedback(db, {
      ...entry,
      tags: [...entry.tags, SEED_TAG],
      author: HUMAN_AUTHOR,
      createdAt: new Date(now - daysAgo * 86_400_000),
    });
  }
  return SEED_FEEDBACK.length;
}
