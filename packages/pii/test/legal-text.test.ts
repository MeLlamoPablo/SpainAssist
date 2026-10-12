import { describe, expect, it } from 'vitest';
import { detectPii } from '../src/index';

/** Excerpts of Spanish legislation (public domain, LPI art. 13) and typical procedure guidance. */
const LEGAL = `Ley 39/2015, de 1 de octubre, del Procedimiento Administrativo Común de las Administraciones Públicas.
«BOE» núm. 236, de 2 de octubre de 2015, páginas 89343 a 89410 (68 págs.). Referencia: BOE-A-2015-10565.
Artículo 16. Registros.
1. Cada Administración dispondrá de un Registro Electrónico General, en el que se hará el correspondiente asiento de todo documento que sea presentado o que se reciba en cualquier órgano administrativo.
4. Los documentos que los interesados dirijan a los órganos de las Administraciones Públicas podrán presentarse: a) En el registro electrónico de la Administración u Organismo al que se dirijan.
Artículo 21. Obligación de resolver.
3. Cuando las normas reguladoras de los procedimientos no fijen el plazo máximo, éste será de tres meses.
4. Las Administraciones Públicas deben publicar y mantener actualizadas en el portal web, a efectos informativos, las relaciones de procedimientos de su competencia, con indicación de los plazos máximos de duración de los mismos (artículo 21.4).
Artículo 66. Solicitudes de iniciación.
1. Las solicitudes que se formulen deberán contener: a) Nombre y apellidos del interesado y, en su caso, de la persona que lo represente. b) Identificación del medio electrónico, o en su defecto, lugar físico en que desea que se practique la notificación.
Artículo 68. Subsanación y mejora de la solicitud.
1. Si la solicitud de iniciación no reúne los requisitos que señala el artículo 66, se requerirá al interesado para que, en un plazo de diez días, subsane la falta o acompañe los documentos preceptivos.
Real Decreto 1553/2005, de 23 de diciembre, por el que se regula la expedición del documento nacional de identidad y sus certificados de firma electrónica.
Orden HAP/1949/2014, de 13 de octubre. Real Decreto 203/2021, de 30 de marzo, por el que se aprueba el Reglamento de actuación y funcionamiento del sector público por medios electrónicos.`;

const GUIDANCE = `Para renovar el DNI pide cita previa en https://www.citapreviadnie.es/ o llama al 060. La tasa es de 12,00 € y se paga en la comisaría (modelo 790 código 012).
Llamar al 012 o al 112 solo en emergencias. Horario: de 9:00 a 14:00h; la oficina abre a las 10:30h. Hoy es 2026-10-03.
Plazo: 10 días hábiles desde el día siguiente a la notificación; tienes hasta el 30/06/2026. El plazo máximo para resolver es de 3 meses (artículo 21.4 de la Ley 39/2015).
Código SIA 110340. Necesitas el DNI, la fecha de nacimiento y el número de soporte. Hay que marcar «renovación» y no «expedición».
El SEPE atiende en el 901 502 050. Presupuesto: 1.234.567,89 € y 12.000.000 euros; subvención del 50%.
La prestación por nacimiento y cuidado de menor se solicita en los 15 días siguientes. La sede caduca la sesión a los 10 minutos.
Se convocan 20 plazas; la plaza de auxiliar administrativo número 3 queda vacante. En la calle había 30 personas esperando.
Firmar con AutoFirma 1.8.3 en el Registro Electrónico General (REC). Usa Cl@ve PIN, Cl@ve permanente o certificado de la FNMT.
Consulta https://www.boe.es/buscar/act.php y https://sede.sepe.gob.es/portalSede/procedimientos-y-servicios.html antes del 15 de octubre de 2026.
El Sr. Director General de Tráfico firmó la resolución; los interesados disponen de un mes. NIPO 630-14-029-3. Expediente de regulación temporal de empleo (ERTE).`;

describe('Spanish legal and administrative text', () => {
  it('has no false positives in legislation', () => {
    expect(detectPii(LEGAL).map((f) => [f.type, f.match])).toEqual([]);
  });

  it('has no false positives in procedure guidance', () => {
    expect(detectPii(GUIDANCE).map((f) => [f.type, f.match])).toEqual([]);
  });

  it('still finds personal data mixed into the same text', () => {
    const mixed = `${GUIDANCE}\nMi DNI es 12345678Z y mi móvil 612 34 56 78.`;
    expect(detectPii(mixed).map((f) => f.type)).toEqual(['dni', 'phone']);
  });
});
