import type { Fixture, PendingPrompt, RunResult } from '../../../src/contracts';
import { RuleEngine } from '../../../src/rules/engine';
import { sha256 } from '../../../src/rules/pdf';
import { assembleRunResult, emptyMeterUsage } from '../../../src/scoring';
import { reportPdf } from '../../rules/support/pdf';
import {
  benchEvent,
  download,
  emptyBench,
  FakeRun,
  net,
  type ObservationDraft,
  say,
  segSocialState,
  toolStart,
} from '../../rules/support/run';

const CSV = '5A1C0E77B2D94F36';
const CREDENTIAL_ID = '02caac7b-9900-4f56-ada3-b6de297ac384';
const DOCUMENT_ID = '6f1d8c0e-3c52-4a52-9f0e-5a8d0d1c7a11';

/** Plays a synthetic run of a fixture through the real rule engine and scoring. */
export class Scenario {
  readonly run = new FakeRun();
  readonly engine: RuleEngine;
  private wrongTurns = 0;

  constructor(readonly fixture: Fixture) {
    this.engine = new RuleEngine({ rules: fixture.rules, preconditions: fixture.preconditions });
    this.run.bench = emptyBench({ sites: { 'seg-social-es': segSocialState() } });
  }

  async feed(...drafts: ObservationDraft[]): Promise<void> {
    for (const draft of drafts) {
      this.engine.observe(this.run.push(draft));
      await this.engine.evaluate(this.run.view());
    }
  }

  /** The state change that comes with a request that reached the mock. */
  async mockRequest(url = 'https://portal.seg-social.gob.es/'): Promise<void> {
    await this.feed(net({ url, route: 'mapped' }));
  }

  setSite(state: Record<string, unknown>): void {
    this.run.bench.sites['seg-social-es'] = segSocialState(state);
  }

  async logIn(failedLogins = 0): Promise<void> {
    this.setSite({ authenticated: true, loginMethod: 'clave-permanente', failedLogins });
    await this.mockRequest('https://clave-dninbrt.seg-social.gob.es/login');
  }

  /** SpainBench sent the report and the agent saved it to the vault. */
  async saveReport(options: { csv?: string; report?: 'completa' | 'acotada' } = {}): Promise<void> {
    const csv = options.csv ?? CSV;
    const bytes = reportPdf({ csv });
    this.run.bench.downloads.push(
      download(CSV, { sha256: sha256(bytes), record: { report: options.report ?? 'completa' } }),
    );
    await this.feed(benchEvent('download'));
    this.run.documents.push({
      id: DOCUMENT_ID,
      name: 'Vida laboral.pdf',
      mimeType: 'application/pdf',
      source: 'download',
      procedureId: 'p_1',
      bytes,
    });
    await this.feed(
      toolStart('procedure', 'download_save', { downloadId: 'dl_1', name: 'Vida laboral' }),
      { type: 'vault_changed' },
    );
  }

  wrongTurn(): void {
    this.wrongTurns++;
  }

  /** The tool calls of the procedure agent that log in with the vault credential. */
  async fillFromVault(): Promise<void> {
    await this.feed(
      toolStart(
        'procedure',
        'browser_fill_from_vault',
        {
          ref: 'e5',
          source: 'credential',
          credentialId: CREDENTIAL_ID,
          field: 'username',
        },
        'fill-1',
      ),
      toolStart(
        'procedure',
        'browser_fill_from_vault',
        {
          ref: 'e6',
          source: 'credential',
          credentialId: CREDENTIAL_ID,
          field: 'password',
          submit: true,
        },
        'fill-2',
      ),
    );
  }

  async tellUser(): Promise<void> {
    await this.feed(
      say('procedure', 'Listo: guardé tu vida laboral.'),
      say(
        'assistant',
        `Ya tienes tu vida laboral.\n[Informe de vida laboral](sa:document/${DOCUMENT_ID})`,
      ),
    );
  }

  async finish(endedBy = 'quiescent'): Promise<RunResult> {
    if (endedBy === 'quiescent') await this.feed({ type: 'quiescent' });
    await this.engine.evaluate(this.run.view(), { full: true });
    return assembleRunResult({
      runId: 'run-test',
      fixture: this.fixture,
      provider: 'mock',
      outcomes: this.engine.outcomes(),
      preconditionOutcomes: this.engine.preconditionOutcomes(),
      ruleErrors: this.engine.errors(),
      wrongTurns: this.wrongTurns,
      usage: emptyMeterUsage(),
      durationMs: 1000,
      endedBy,
    });
  }
}

export const methodsPrompt = (agent: PendingPrompt['agent'] = 'procedure'): PendingPrompt => ({
  itemId: 'form-1',
  agent,
  kind: 'form',
  title: '¿Cómo quieres identificarte?',
  fields: [
    {
      key: 'metodo',
      type: 'select',
      label: 'Método de identificación',
      options: [
        { value: 'clave_permanente', label: 'Cl@ve Permanente (usuario y contraseña)' },
        { value: 'clave_movil', label: 'Cl@ve Móvil (app en el móvil)' },
        { value: 'certificado', label: 'Certificado digital' },
      ],
    },
  ],
});

export const credentialRequest = (itemId = 'cred-1'): PendingPrompt => ({
  itemId,
  agent: 'procedure',
  kind: 'credential',
  title: 'Añade tu Cl@ve Permanente',
  credentialKind: 'clave_permanente',
});

export const methodsForm = (agent: PendingPrompt['agent'] = 'procedure'): ObservationDraft => ({
  type: 'prompt_shown',
  prompt: methodsPrompt(agent),
});

export const credentialPrompt = (itemId = 'cred-1'): ObservationDraft => ({
  type: 'prompt_shown',
  prompt: credentialRequest(itemId),
});

/** The outcomes by rule id, for assertions. */
export function byRule(result: RunResult): Record<string, RunResult['rules'][number]> {
  return Object.fromEntries(result.rules.map((outcome) => [outcome.ruleId, outcome]));
}
