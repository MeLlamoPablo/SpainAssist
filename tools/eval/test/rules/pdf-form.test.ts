import { describe, expect, it } from 'vitest';
import { renderDocument } from '../../src/documents';
import { getFixture } from '../../src/fixtures/registry';
import { foldText, formFields, readFilledForm } from '../../src/rules/pdf-form';

/** The blank EX-15s are SpainBench's (`forms/`): these tests need its checkout. */
const bench = process.env.SPAINBENCH_DIR ? describe : describe.skip;

bench('reading a filled-in PDF form', () => {
  const blank = (id: string) => renderDocument(getFixture(id).seed?.documents?.[0] as never);

  it('reads the blank EX-15 as 80 fields with nothing written or ticked, fillable or flat', async () => {
    const fillable = blank('pdf-ex15');
    const fields = await formFields(fillable.bytes);
    expect(fields).toHaveLength(80);
    expect(fields[0]).toMatchObject({ name: 'Texto1', page: 1, checkbox: false });
    for (const file of [fillable, blank('pdf-ex15-plano')]) {
      const form = await readFilledForm(file.bytes, fields, file.bytes);
      expect(fields.filter((f) => form.text(f.name) !== '' || form.ticked(f.name))).toEqual([]);
    }
  });

  it('compares what was written with accents, case and spaces ignored', () => {
    expect(foldText('  WIŚNIEWSKA  ')).toBe('wisniewska');
    expect(foldText('Calle de\nEmbajadores')).toBe('calle de embajadores');
  });
});
