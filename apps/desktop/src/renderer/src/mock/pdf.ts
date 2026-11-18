/**
 * Mock documents for the web preview: a two-page rental contract (made-up parties) as a real PDF,
 * written by hand, for the visible-signature card.
 */
import type { PdfSignaturePrompt } from '@sa/shared';

const PAGES: string[][] = [
  [
    'CONTRATO DE ARRENDAMIENTO DE VIVIENDA',
    '',
    'En Sevilla, a 18 de noviembre de 2026.',
    '',
    'REUNIDOS',
    '',
    'De una parte, Dña. Lucía Martín Ortega, mayor de edad, con NIF ***1234**,',
    'en adelante la ARRENDADORA.',
    'De otra parte, D. Pablo Ejemplo García, mayor de edad, con NIF ***5678**,',
    'en adelante el ARRENDATARIO.',
    '',
    'EXPONEN',
    '',
    'I. Que la ARRENDADORA es propietaria de la vivienda situada en la calle',
    'Feria, 12, 2.º B, de Sevilla.',
    'II. Que ambas partes acuerdan formalizar el presente contrato con arreglo',
    'a la Ley 29/1994, de 24 de noviembre, de Arrendamientos Urbanos.',
    '',
    'CLÁUSULAS',
    '',
    'Primera. Objeto. La ARRENDADORA arrienda al ARRENDATARIO la vivienda',
    'descrita, que este acepta para su uso como vivienda habitual.',
    'Segunda. Duración. El contrato tendrá una duración de un año desde el 1 de',
    'diciembre de 2026, prorrogable según el artículo 9 de la LAU.',
    'Tercera. Renta. La renta mensual será de 850 euros, pagaderos en los siete',
    'primeros días de cada mes por transferencia bancaria.',
  ],
  [
    'Cuarta. Fianza. El ARRENDATARIO entrega en este acto una mensualidad en',
    'concepto de fianza legal.',
    'Quinta. Gastos. Los suministros de agua, luz e internet serán a cargo del',
    'ARRENDATARIO.',
    'Sexta. Obras. El ARRENDATARIO no podrá realizar obras sin el consentimiento',
    'por escrito de la ARRENDADORA.',
    '',
    'Y en prueba de conformidad, las partes firman el presente contrato.',
    '',
    '',
    'La ARRENDADORA                                        El ARRENDATARIO',
  ],
];

/** WinAnsi literal string for a content stream. */
function literal(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (code < 128) out += ch;
    else out += `\\${code.toString(8).padStart(3, '0')}`;
  }
  return `(${out})`;
}

let cached: Uint8Array | undefined;

export function sampleContractPdf(): Uint8Array {
  if (cached) return cached;
  const objects: string[] = [];
  const pageRefs: number[] = [];
  // 1 catalog, 2 pages, 3 font; then a page and its content per page.
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  let next = 4;
  for (const lines of PAGES) {
    const pageRef = next++;
    const contentRef = next++;
    pageRefs.push(pageRef);
    const ops = ['BT', '/F1 11 Tf', '14 TL', '72 770 Td'];
    for (const [i, line] of lines.entries()) {
      const heading = i === 0 && line === line.toUpperCase() && line.trim();
      ops.push(heading ? `/F1 14 Tf ${literal(line)} Tj /F1 11 Tf T*` : `${literal(line)} '`);
    }
    ops.push('ET');
    const content = ops.join('\n');
    objects[pageRef] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentRef} 0 R >>`;
    objects[contentRef] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  }
  objects[2] = `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`;
  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = body.length;
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f\r\n`;
  for (let n = 1; n < objects.length; n++)
    body += `${String(offsets[n]).padStart(10, '0')} 00000 n\r\n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  cached = Uint8Array.from(body, (c) => c.charCodeAt(0));
  return cached;
}

/**
 * The visible-signature card in its states (`?pdfSign=`): `choose` (the agent's own-document
 * signature, the default), `fixed` (a site chose the box), `optional` (a site lets the user skip
 * it) and `phone` (the DNIe: the card only places the box).
 */
export function pdfSignatureExample(
  state: string | null,
  tr: (es: string, en: string) => string,
): PdfSignaturePrompt {
  const site = state === 'fixed' || state === 'optional';
  const host = 'sede.example.gob.es';
  return {
    kind: 'pdf_signature',
    title: tr('¿Firmar este documento?', 'Sign this document?'),
    message: site
      ? state === 'fixed'
        ? tr(
            `${host} te pide firmar este PDF con tu certificado digital. La firma aparecerá donde ha indicado la web. La firma tiene validez legal: comprueba que es lo que esperas.`,
            `${host} asks you to sign this PDF with your digital certificate. The signature will appear where the website says. A signature is legally binding: check it is what you expect.`,
          )
        : tr(
            `${host} te pide firmar este PDF con tu certificado digital. Arrastra la firma a donde quieras que aparezca. La firma tiene validez legal: comprueba que es lo que esperas.`,
            `${host} asks you to sign this PDF with your digital certificate. Drag the signature to where it should appear. A signature is legally binding: check it is what you expect.`,
          )
      : tr(
          'Vas a firmar este PDF con tu certificado digital. Arrastra la firma a donde quieras que aparezca. La firma tiene validez legal.',
          "You're about to sign this PDF with your digital certificate. Drag the signature to where it should appear. A signature is legally binding.",
        ),
    details: [
      {
        label: tr('Qué', 'What'),
        value: tr('Firmar «Contrato de alquiler.pdf»', 'Sign “Contrato de alquiler.pdf”'),
      },
      { label: tr('Para', 'For'), value: site ? host : tr('Mis documentos', 'My documents') },
      {
        label: tr('Certificado', 'Certificate'),
        value:
          state === 'phone'
            ? tr('Tu DNI con el móvil', 'Your DNI with the phone')
            : 'Pablo Ejemplo García (FNMT)',
      },
    ],
    documentName: 'Contrato de alquiler.pdf',
    mode: state === 'fixed' ? 'fixed' : 'choose',
    ...(state === 'optional' ? { optional: true } : {}),
    initial: { page: 2, rect: state === 'fixed' ? [72, 548, 252, 612] : [343, 548, 523, 612] },
    appearance: 'handwritten',
    signer: { name: 'Pablo Ejemplo García', holderId: '***5678**' },
    approval: state === 'phone' ? 'phone' : 'here',
    ...(state === 'phone' ? {} : { biometric: true }),
    confirmLabel: state === 'phone' ? tr('Continuar', 'Continue') : tr('Firmar', 'Sign'),
    rejectLabel: tr('No firmar', "Don't sign"),
  };
}
