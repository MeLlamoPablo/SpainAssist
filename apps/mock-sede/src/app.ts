/** Builds the Hono app of the main (sede + gateway) port. */
import { Hono } from 'hono';
import type { Asset } from './assets';
import { type AppContext, type AppEnv, renderSede, sessionMiddleware } from './context';
import { html } from './html';
import { registerAfirmaRoutes } from './routes/afirma';
import { registerCaptchaRoutes } from './routes/captcha';
import { registerCitaRoutes } from './routes/cita';
import { registerGatewayRoutes } from './routes/gateway';
import { registerResidenciaRoutes } from './routes/residencia';
import { registerSedeRoutes } from './routes/sede';
import { type MockSedeTestApi, registerTestApi } from './test-api';
import { alertBox } from './views';

export function createMainApp(
  ctx: AppContext,
  assets: Map<string, Asset>,
  testApi: MockSedeTestApi,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', sessionMiddleware(ctx));
  if (ctx.config.testApi) registerTestApi(app, testApi);
  registerSedeRoutes(app, ctx, assets);
  registerGatewayRoutes(app, ctx);
  registerResidenciaRoutes(app, ctx);
  registerCitaRoutes(app, ctx);
  registerCaptchaRoutes(app, ctx);
  registerAfirmaRoutes(app, ctx);

  app.notFound((c) =>
    renderSede(
      c,
      ctx,
      {
        title: 'Página no encontrada',
        body: html`<h1>Página no encontrada</h1>
          <p>La página que buscas no existe o ha cambiado de dirección.</p>
          <p><a href="/">Volver al inicio</a></p>`,
      },
      404,
    ),
  );

  app.onError((err, c) => {
    ctx.log(`[Error] ${c.req.method} ${c.req.path}: ${err.stack ?? err.message}`);
    return renderSede(
      c,
      ctx,
      {
        title: 'Error',
        body: html`<h1>Se ha producido un error</h1>
          ${alertBox('error', 'No hemos podido atender tu petición. Inténtalo de nuevo más tarde.')}
          <p><a href="/">Volver al inicio</a></p>`,
      },
      500,
    );
  });
  return app;
}
