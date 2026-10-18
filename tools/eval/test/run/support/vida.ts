import { sha256 } from '../../../src/rules/pdf';
import { credentialRequest, methodsPrompt } from '../../fixtures/support/play';
import { reportPdf } from '../../rules/support/pdf';
import { download, netRecord } from '../../rules/support/run';
import type { ScriptContext } from './scripted-app';

const CSV = '5A1C0E77B2D94F36';
const DOCUMENT_ID = '6f1d8c0e-3c52-4a52-9f0e-5a8d0d1c7a11';

/** The assistant starts a procedure, and the procedure agent looks at the vault. */
export function startProcedure(ctx: ScriptContext): void {
  ctx.model();
  ctx.tool('assistant', 'procedure_list', {});
  ctx.tool('assistant', 'procedure_start', {
    title: 'Vida laboral',
    brief: 'Sacar la vida laboral',
  });
  ctx.model();
  ctx.tool('procedure', 'vault_read', {});
}

/** The procedure agent types the credential from the vault and the login happens. */
export function logIn(ctx: ScriptContext): void {
  ctx.model();
  ctx.tool('procedure', 'browser_login_clave', { usernameRef: 'e5', passwordRef: 'e6' });
  ctx.bench.site(ctx.spec.bench.worldId, { authenticated: true, loginMethod: 'clave-permanente' });
  ctx.emit({
    type: 'net',
    record: netRecord({
      worldId: ctx.spec.bench.worldId,
      url: 'https://clave-dninbrt.seg-social.gob.es/login',
      host: 'clave-dninbrt.seg-social.gob.es',
    }),
  });
}

/** SpainBench sends the report, the agent saves it, and both agents tell the user. */
export function saveReportAndTell(ctx: ScriptContext): void {
  ctx.model();
  const bytes = reportPdf({ csv: CSV });
  ctx.bench.addDownload(
    ctx.spec.bench.worldId,
    download(CSV, { sha256: sha256(bytes), record: { report: 'completa' } }),
  );
  ctx.bench.emit(ctx.spec.bench.worldId, 'download', { filename: 'vida_laboral.pdf' });
  ctx.app.documents.push({
    id: DOCUMENT_ID,
    name: 'Vida laboral.pdf',
    mimeType: 'application/pdf',
    source: 'download',
    procedureId: 'p_1',
    bytes,
  });
  ctx.tool('procedure', 'download_save', { downloadId: 'dl_1', name: 'Vida laboral' });
  ctx.vaultChanged();
  ctx.say('procedure', 'Listo: guardé tu vida laboral.');
  ctx.model();
  ctx.say(
    'assistant',
    `Ya tienes tu vida laboral.\n[Informe de vida laboral](sa:document/${DOCUMENT_ID})`,
  );
}

/** Fixture 1, the golden path: the methods form, the credential request, login, download. */
export async function sinDatosGolden(ctx: ScriptContext): Promise<void> {
  startProcedure(ctx);
  ctx.mark('methods');
  const methods = await ctx.ask(methodsPrompt());
  ctx.state.methods = methods;
  ctx.mark('credential');
  const credential = await ctx.ask(credentialRequest());
  ctx.state.credential = credential;
  ctx.vaultChanged();
  logIn(ctx);
  saveReportAndTell(ctx);
  ctx.mark('done');
}

/** Fixture 2, the golden path: nothing is asked. */
export async function conDatosGolden(ctx: ScriptContext): Promise<void> {
  startProcedure(ctx);
  logIn(ctx);
  saveReportAndTell(ctx);
  ctx.mark('done');
}
