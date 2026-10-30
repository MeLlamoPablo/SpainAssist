import { describe, expect, it } from 'vitest';
import { MAX_FILE_NAME_LENGTH, safeFileName } from '../src/file-name';

describe('safeFileName', () => {
  it.each([
    // The app's own names stay as they are.
    ['Informe de vida laboral - 2026-10-12.pdf', 'Informe de vida laboral - 2026-10-12.pdf'],
    ['Informe de vida laboral - 2026-10-12', 'Informe de vida laboral - 2026-10-12'],
    ['Certificado de empadronamiento.pdf', 'Certificado de empadronamiento.pdf'],
    ['Justificante_registro.pdf', 'Justificante_registro.pdf'],
    ['Modelo 030 (alta, baja) nº 2.pdf', 'Modelo 030 (alta, baja) nº 2.pdf'],
    ['Resolución Muñoz Ibáñez.pdf', 'Resolución Muñoz Ibáñez.pdf'],
    ['SpainAssist-transcripts-2026-10-30.zip', 'SpainAssist-transcripts-2026-10-30.zip'],
    // Only the last part of a path.
    ['../../justificante?.pdf', 'justificante_.pdf'],
    ['C:\\fakepath\\DNI.jpg', 'DNI.jpg'],
    ['carpeta/informe.pdf', 'informe.pdf'],
    // Characters Windows forbids, and control characters: each run becomes one "_".
    ['Cita: DNI?.pdf', 'Cita_ DNI_.pdf'],
    ['a<b>c"d|e*f.pdf', 'a_b_c_d_e_f.pdf'],
    ['tab\there\r\nnew\u0000line\u007f.pdf', 'tab_here_new_line_.pdf'],
    ['<<>>.pdf', '_.pdf'],
    // Leading and trailing dots and spaces.
    ['.bashrc', 'bashrc'],
    ['  informe.pdf  ', 'informe.pdf'],
    ['informe.pdf.', 'informe.pdf'],
    ['informe. . .', 'informe'],
    // Device names, in any case, with or without an extension.
    ['CON', '_CON'],
    ['con.pdf', '_con.pdf'],
    ['Prn.txt', '_Prn.txt'],
    ['AUX.tar.gz', '_AUX.tar.gz'],
    ['nul', '_nul'],
    ['NUL .pdf', '_NUL .pdf'],
    ['COM1.pdf', '_COM1.pdf'],
    ['com9', '_com9'],
    ['LPT1', '_LPT1'],
    ['lpt9.xml', '_lpt9.xml'],
    ['COM¹.pdf', '_COM¹.pdf'],
    ['COM²', '_COM²'],
    ['LPT³.txt', '_LPT³.txt'],
    ['CONIN$', '_CONIN$'],
    ['conout$.log', '_conout$.log'],
    ['con.', '_con'],
    // Names that only look like one.
    ['CONSOLA.pdf', 'CONSOLA.pdf'],
    ['COM10.pdf', 'COM10.pdf'],
    ['LPT.pdf', 'LPT.pdf'],
    ['Auxiliar.pdf', 'Auxiliar.pdf'],
    ['nul-2026.pdf', 'nul-2026.pdf'],
    ['mi CON.pdf', 'mi CON.pdf'],
    // Nothing left: the fallback.
    ['', 'documento'],
    ['...', 'documento'],
    ['   ', 'documento'],
    ['a/', 'documento'],
  ])('%j → %j', (name, expected) => {
    expect(safeFileName(name)).toBe(expected);
  });

  it('takes the fallback it is given', () => {
    expect(safeFileName('..', 'descarga')).toBe('descarga');
  });

  it('composes accents (macOS gives decomposed names)', () => {
    expect(safeFileName('Jose\u0301.pdf')).toBe('José.pdf');
  });

  it('is idempotent', () => {
    for (const name of ['CON.pdf', 'a<b>.pdf', ` ${'x'.repeat(300)}.pdf `, 'informe.pdf.'])
      expect(safeFileName(safeFileName(name))).toBe(safeFileName(name));
  });

  it(`shortens long names to ${MAX_FILE_NAME_LENGTH} characters, keeping the extension`, () => {
    const long = safeFileName(`${'Informe '.repeat(30)}final.pdf`);
    expect(long).toHaveLength(MAX_FILE_NAME_LENGTH - 1); // the cut ends on a space, dropped
    expect(long.endsWith('Informe.pdf')).toBe(true);
    expect(safeFileName(`${'a'.repeat(200)}.tar.gz`)).toBe(`${'a'.repeat(97)}.gz`);
    // An "extension" that long is part of the name.
    const dotted = safeFileName(`a.${'b'.repeat(200)}`);
    expect(dotted).toBe(`a.${'b'.repeat(98)}`);
    // A device name stays escaped when cut.
    expect(safeFileName(`con.${'x'.repeat(200)}`)).toBe(`_con.${'x'.repeat(95)}`);
  });

  it('never cuts a character in half', () => {
    const name = safeFileName(`${'a'.repeat(95)}😀😀😀.pdf`);
    expect(name).toBe(`${'a'.repeat(95)}.pdf`);
    expect(name.isWellFormed()).toBe(true);
  });
});
