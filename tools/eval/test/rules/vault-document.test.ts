import { describe, expect, it } from 'vitest';
import type { Condition, Rule } from '../../src/contracts';
import { RuleEngine } from '../../src/rules/engine';
import { sha256 } from '../../src/rules/pdf';
import { buildPdf, reportPdf } from './support/pdf';
import { benchEvent, download, emptyBench, type FakeDocument, FakeRun } from './support/run';

const CSV = '0123456789ABCDEF';
const OTHER_CSV = 'FEDCBA9876543210';

const completeReport: Condition = {
  type: 'vaultDocument',
  where: {
    mimeType: 'application/pdf',
    source: 'download',
    pdfCsvMatchesBenchDownload: { site: 'seg-social-es', where: { report: 'completa' } },
  },
};

function rule(condition: Condition = completeReport): Rule {
  return { id: 'pdf-saved', description: 'pdf', kind: 'required', condition };
}

function doc(overrides: Partial<FakeDocument> = {}): FakeDocument {
  return {
    id: 'doc-1',
    name: 'Vida laboral.pdf',
    mimeType: 'application/pdf',
    source: 'download',
    bytes: reportPdf({ csv: CSV }),
    ...overrides,
  };
}

async function detailOf(
  run: FakeRun,
  condition?: Condition,
): Promise<{ matched: boolean; detail: string }> {
  const engine = new RuleEngine({ rules: [rule(condition)] });
  await engine.evaluate(run.view());
  const outcome = engine.outcomes()[0]!;
  return { matched: outcome.matched, detail: outcome.detail ?? '' };
}

describe('vaultDocument with a PDF code check', () => {
  it('matches a saved PDF whose code is the code of a complete SpainBench download', async () => {
    const run = new FakeRun();
    const document = doc();
    run.documents = [document];
    run.bench = emptyBench({ downloads: [download(CSV, { sha256: sha256(document.bytes) })] });
    const result = await detailOf(run);
    expect(result.matched).toBe(true);
    expect(result.detail).toContain(CSV);
    expect(result.detail).toContain('download #0');
    expect(result.detail).toContain('bytes identical to the emitted file');
  });

  it('reports when the bytes differ from the emitted file (the code still matches)', async () => {
    const run = new FakeRun();
    run.documents = [doc()];
    run.bench = emptyBench({ downloads: [download(CSV, { sha256: 'a'.repeat(64) })] });
    const result = await detailOf(run);
    expect(result.matched).toBe(true);
    expect(result.detail).toContain('bytes differ from the emitted file');
  });

  it('picks the right download among several', async () => {
    const run = new FakeRun();
    run.documents = [doc()];
    run.bench = emptyBench({
      downloads: [
        download(OTHER_CSV, { record: { report: 'acotada' } }),
        download('AAAAAAAAAAAAAAAA'),
        download(CSV),
      ],
    });
    const result = await detailOf(run);
    expect(result.matched).toBe(true);
    expect(result.detail).toContain('download #2');
  });

  it('fails when the code belongs to a filtered report and says so', async () => {
    const run = new FakeRun();
    run.documents = [doc()];
    run.bench = emptyBench({ downloads: [download(CSV, { record: { report: 'acotada' } })] });
    const result = await detailOf(run);
    expect(result.matched).toBe(false);
    expect(result.detail).toContain(`code ${CSV} is the code of download #0`);
    expect(result.detail).toContain('report is "acotada", expected "completa"');
  });

  it('fails when the code is not the code of any download and lists the known ones', async () => {
    const run = new FakeRun();
    run.documents = [doc()];
    run.bench = emptyBench({ downloads: [download(OTHER_CSV)] });
    const result = await detailOf(run);
    expect(result.matched).toBe(false);
    expect(result.detail).toContain(`PDF code(s) ${CSV}`);
    expect(result.detail).toContain(`known: ${OTHER_CSV}`);
  });

  it('fails when SpainBench never sent a report of that site', async () => {
    const run = new FakeRun();
    run.documents = [doc()];
    run.bench = emptyBench({ downloads: [download(CSV, { site: 'fnmt-es' })] });
    const result = await detailOf(run);
    expect(result.matched).toBe(false);
    expect(result.detail).toContain('no download of site "seg-social-es"');
  });

  it('fails for a PDF without a verification code', async () => {
    const run = new FakeRun();
    run.documents = [doc({ bytes: buildPdf([['Informe sin codigo', CSV]]) })];
    run.bench = emptyBench({ downloads: [download(CSV)] });
    const result = await detailOf(run);
    expect(result.matched).toBe(false);
    expect(result.detail).toContain('no "Código Seguro de Verificación"');
  });

  it('fails for a file that is not a readable PDF', async () => {
    const run = new FakeRun();
    run.documents = [doc({ bytes: new TextEncoder().encode('<html>not a pdf</html>') })];
    run.bench = emptyBench({ downloads: [download(CSV)] });
    const result = await detailOf(run);
    expect(result.matched).toBe(false);
    expect(result.detail).toContain('cannot read the PDF');
    expect(result.detail).toContain('%PDF-');
  });

  it('accepts any of several saved documents', async () => {
    const run = new FakeRun();
    run.documents = [
      doc({ id: 'bad', name: 'Otro.pdf', bytes: reportPdf({ csv: OTHER_CSV }) }),
      doc({ id: 'good' }),
    ];
    run.bench = emptyBench({ downloads: [download(CSV)] });
    expect((await detailOf(run)).matched).toBe(true);
  });

  it('does not trust a code of the right shape without its label', async () => {
    const run = new FakeRun();
    run.documents = [doc({ bytes: buildPdf([[`Referencia ${CSV}`], [`CSV ${CSV}`]]) })];
    run.bench = emptyBench({ downloads: [download(CSV)] });
    expect((await detailOf(run)).matched).toBe(false);
  });
});

describe('vaultDocument basic predicates', () => {
  it('filters by mime type, source and name', async () => {
    const run = new FakeRun();
    run.documents = [
      doc({ id: 'a', mimeType: 'image/png', name: 'foto.png' }),
      doc({ id: 'b', source: 'user', name: 'dni.pdf' }),
    ];
    const none = await detailOf(run, {
      type: 'vaultDocument',
      where: { mimeType: 'application/pdf', source: 'download' },
    });
    expect(none.matched).toBe(false);
    expect(none.detail).toContain(
      'no saved document with mime type application/pdf, source download',
    );
    expect(none.detail).toContain('foto.png');
    expect(none.detail).toContain('dni.pdf');

    run.documents.push(
      doc({ id: 'c', name: 'Vida laboral.pdf', mimeType: 'Application/PDF; x=y' }),
    );
    const found = await detailOf(run, {
      type: 'vaultDocument',
      where: { mimeType: 'application/pdf', source: 'download', nameMatches: /vida laboral/i },
    });
    expect(found.matched).toBe(true);
  });

  it('says so when the vault is empty', async () => {
    const result = await detailOf(new FakeRun(), { type: 'vaultDocument', where: {} });
    expect(result.matched).toBe(false);
    expect(result.detail).toContain('saved: none');
  });

  it('matches any document with an empty predicate', async () => {
    const run = new FakeRun();
    run.documents = [doc()];
    expect((await detailOf(run, { type: 'vaultDocument', where: {} })).matched).toBe(true);
  });
});

describe('vaultDocument in the engine', () => {
  it('is sampled after vault and bench changes and reads each PDF once', async () => {
    const run = new FakeRun();
    const engine = new RuleEngine({ rules: [rule()] });
    await engine.evaluate(run.view());
    expect(engine.outcomes()[0]!.matched).toBe(false);

    // The document is saved but SpainBench has no matching download yet.
    run.documents = [doc()];
    engine.observe(run.push({ type: 'vault_changed' }));
    await engine.evaluate(run.view());
    expect(engine.outcomes()[0]!.matched).toBe(false);
    expect(run.reads).toBe(1);

    // The server's record shows up later: sampled again, without extracting the PDF again.
    run.bench = emptyBench({ downloads: [download(CSV)] });
    engine.observe(run.push(benchEvent('download')));
    const matches = await engine.evaluate(run.view());
    expect(matches).toHaveLength(1);
    expect(matches[0]!.seq).toBe(run.lastSeq);
    expect(run.reads).toBe(1); // the text and the hash come from one read, cached by document id
  });

  it('does not cache a failed read', async () => {
    const run = new FakeRun();
    run.documents = [doc({ failReads: 1 })];
    run.bench = emptyBench({ downloads: [download(CSV)] });
    const engine = new RuleEngine({ rules: [rule()] });
    await engine.evaluate(run.view());
    expect(engine.outcomes()[0]!.detail).toContain('vault is locked');
    engine.observe(run.push({ type: 'vault_changed' }));
    await engine.evaluate(run.view());
    expect(engine.outcomes()[0]!.matched).toBe(true);
  });

  it('is not sampled again by unrelated observations', async () => {
    const run = new FakeRun();
    run.documents = [doc({ bytes: reportPdf({ csv: OTHER_CSV }) })];
    run.bench = emptyBench({ downloads: [download(CSV)] });
    const engine = new RuleEngine({ rules: [rule()] });
    await engine.evaluate(run.view());
    const calls = run.documentCalls;
    engine.observe(run.push({ type: 'assistant_message', agent: 'assistant', text: 'hola' }));
    await engine.evaluate(run.view());
    expect(run.documentCalls).toBe(calls);
  });
});
