/**
 * AutoFirma helpers of the sede: the "requisitos técnicos" page with a signature check, and the
 * StorageService/RetrieveService pair used by autoscript.js in intermediate-server mode.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { decodeBase64, verifyCadesSignature } from '../cades';
import { type AppContext, type AppEnv, type Ctx, renderSede } from '../context';
import { html } from '../html';
import { randomCode } from '../state';
import { alertBox, summaryList } from '../views';

const checkSchema = z.object({
  datos: z.string().min(1).max(10_000),
  firma: z.string().max(6_000_000),
  certificado: z.string().max(200_000),
});

async function servletParams(c: Ctx): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...c.req.query() };
  if (c.req.method === 'POST') {
    const body = await c.req.parseBody().catch(() => ({}));
    for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export function registerAfirmaRoutes(app: Hono<AppEnv>, ctx: AppContext): void {
  const { state } = ctx;
  const crumbs = [{ label: 'Ayuda y requisitos' }];

  app.all('/afirma-signature-storage/StorageService', async (c) => {
    const p = await servletParams(c);
    if (p.op === 'check') return c.text('OK');
    if (p.op === 'put' && p.id && p.dat) {
      state.afirmaStorage.set(p.id, p.dat);
      return c.text('OK');
    }
    return c.text('err-00:= Operacion no soportada');
  });

  app.all('/afirma-signature-retriever/RetrieveService', async (c) => {
    const p = await servletParams(c);
    if (p.op === 'check') return c.text('OK');
    if (p.op === 'get' && p.id) {
      const data = state.afirmaStorage.get(p.id);
      if (data !== undefined) {
        state.afirmaStorage.delete(p.id);
        return c.text(data);
      }
      return c.text('err-06:= El fichero no existe o ha caducado');
    }
    return c.text('err-00:= Operacion no soportada');
  });

  app.get('/ayuda/autofirma', (c) => {
    const text = `Prueba de firma de la sede electrónica de pruebas. ${new Date(state.now()).toISOString()} ${randomCode(8)}`;
    return renderSede(c, ctx, {
      title: 'Requisitos técnicos y AutoFirma',
      breadcrumbs: crumbs,
      scripts: ['/js/autoscript.js', '/js/tramite-firma.js'],
      body: html`<h1>Requisitos técnicos y AutoFirma</h1>
        <p>Para firmar solicitudes en esta sede necesitas:</p>
        <ul>
          <li>Un certificado electrónico de persona física instalado en tu navegador o en tu sistema.</li>
          <li>La aplicación AutoFirma, que hace la firma con tu certificado. Se abre sola cuando la necesitas.</li>
          <li>Un navegador actualizado (Chrome, Edge, Firefox o Safari).</li>
        </ul>
        <h2>Comprueba que puedes firmar</h2>
        <p>Pulsa el botón para firmar un texto de prueba con tu certificado. No se presenta nada.</p>
        <div id="error-firma" class="alerta alerta-error" role="alert" hidden></div>
        <p id="estado-firma" class="estado-firma" role="status" aria-live="polite"></p>
        <form method="post" action="/ayuda/autofirma/comprobar" id="form-firma">
          <input type="hidden" name="datos" value="${Buffer.from(text, 'utf8').toString('base64')}">
          <input type="hidden" name="firma" value="">
          <input type="hidden" name="certificado" value="">
          <button type="button" class="boton" id="boton-firmar">Probar la firma</button>
        </form>`,
    });
  });

  app.post('/ayuda/autofirma/comprobar', async (c) => {
    const parsed = checkSchema.safeParse(await c.req.parseBody());
    let content: Buffer | undefined;
    try {
      content = parsed.success ? decodeBase64(parsed.data.datos) : undefined;
    } catch {
      content = undefined;
    }
    if (!parsed.success || !content || !parsed.data.firma) {
      return renderSede(
        c,
        ctx,
        {
          title: 'Comprobación de firma',
          breadcrumbs: crumbs,
          body: html`<h1>Comprobación de firma</h1>
            ${alertBox('error', 'No se ha recibido ninguna firma.')}
            <p><a href="/ayuda/autofirma">Volver a intentarlo</a></p>`,
        },
        400,
      );
    }
    const result = verifyCadesSignature({
      signature: parsed.data.firma,
      expectedContent: content,
      certificateArgument: parsed.data.certificado,
      now: new Date(state.now()),
    });
    return renderSede(c, ctx, {
      title: 'Comprobación de firma',
      breadcrumbs: crumbs,
      body: html`<h1>Comprobación de firma</h1>
        ${
          result.valid
            ? alertBox(
                'exito',
                'Tu firma es correcta. Ya puedes firmar solicitudes en esta sede.',
                {
                  title: 'Firma correcta',
                },
              )
            : alertBox('error', result.error ?? 'La firma no es válida.', {
                title: 'La firma no es válida',
              })
        }
        ${summaryList([
          ['Firmante', result.signer?.commonName],
          ['Emisor del certificado', result.signer?.issuerCommonName],
          [
            'Modo',
            result.mode === 'implicit'
              ? 'Implícita (incluye los datos)'
              : result.mode === 'explicit'
                ? 'Explícita (sin datos)'
                : undefined,
          ],
        ])}
        <h2>Comprobaciones</h2>
        <ul class="comprobaciones">
          ${result.checks.map((check) => html`<li>${check.ok ? 'Correcto' : 'Incorrecto'}: ${check.message}</li>`)}
        </ul>
        <p><a href="/ayuda/autofirma">Volver a probar</a></p>`,
    });
  });
}
