/**
 * "No soy un robot" verification page (a fake CAPTCHA) used before the appointment calendar.
 *
 * Ticking the box passes straight away in a normal browser. When the page runs under automation
 * (navigator.webdriver) it asks to pick images instead, which an accessibility-tree agent cannot
 * do: the agent must hand over to the human, or a test calls POST /__test/solve-captcha.
 */
import { randomInt } from 'node:crypto';
import type { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { type AppContext, type AppEnv, type Ctx, field, renderSede, safePath } from '../context';
import { html, type SafeHtml } from '../html';
import { type CaptchaChallenge, type CaptchaTile, randomId } from '../state';
import { alertBox } from '../views';

const CAPTCHA_COOKIE = 'sede_verificacion';

const TILE_NAMES: Record<CaptchaTile, string> = {
  semaforo: 'semáforos',
  coche: 'coches',
  arbol: 'árboles',
  casa: 'casas',
  bicicleta: 'bicicletas',
};
const TARGETS: CaptchaTile[] = ['semaforo', 'coche', 'bicicleta'];
const ALL_TILES = Object.keys(TILE_NAMES) as CaptchaTile[];

function tileSvg(kind: CaptchaTile, variant: number): string {
  const bg = ['#dfe9f3', '#e8f0e0', '#f3eadf'][variant % 3];
  const shapes: Record<CaptchaTile, string> = {
    semaforo:
      '<rect x="38" y="12" width="24" height="58" rx="5" fill="#222"/><circle cx="50" cy="24" r="7" fill="#d33"/><circle cx="50" cy="41" r="7" fill="#e9a400"/><circle cx="50" cy="58" r="7" fill="#2a2"/><rect x="47" y="70" width="6" height="22" fill="#555"/>',
    coche:
      '<rect x="14" y="48" width="72" height="22" rx="6" fill="#2d6cdf"/><path d="M28 48 l10 -16 h26 l10 16z" fill="#2d6cdf"/><circle cx="32" cy="72" r="9" fill="#222"/><circle cx="68" cy="72" r="9" fill="#222"/>',
    arbol:
      '<rect x="45" y="58" width="10" height="32" fill="#7a4b22"/><circle cx="50" cy="40" r="26" fill="#2f8a3a"/>',
    casa: '<rect x="24" y="46" width="52" height="40" fill="#c8553d"/><path d="M18 48 L50 18 L82 48z" fill="#6b2b20"/><rect x="44" y="62" width="12" height="24" fill="#3b2412"/>',
    bicicleta:
      '<circle cx="28" cy="64" r="16" fill="none" stroke="#222" stroke-width="4"/><circle cx="72" cy="64" r="16" fill="none" stroke="#222" stroke-width="4"/><path d="M28 64 L44 40 L62 40 L72 64 M44 40 L52 64 L28 64 M58 32 h10" stroke="#c22" stroke-width="4" fill="none"/>',
  };
  return `<svg viewBox="0 0 100 100" width="100" height="100" aria-hidden="true" focusable="false"><rect width="100" height="100" fill="${bg}"/>${shapes[kind]}</svg>`;
}

function newImageChallenge(): NonNullable<CaptchaChallenge['image']> {
  const target = TARGETS[randomInt(TARGETS.length)]!;
  const others = ALL_TILES.filter((t) => t !== target);
  const correctCount = 3 + randomInt(2);
  const positions = new Set<number>();
  while (positions.size < correctCount) positions.add(randomInt(9));
  const tiles = Array.from({ length: 9 }, (_, i) =>
    positions.has(i) ? target : others[randomInt(others.length)]!,
  );
  return { target, tiles, correct: [...positions].sort((a, b) => a - b) };
}

function challengeJson(image: NonNullable<CaptchaChallenge['image']>, error?: string) {
  return {
    status: 'challenge' as const,
    error,
    instruction: `Selecciona todas las imágenes con ${TILE_NAMES[image.target]}. Después pulsa «Verificar».`,
    tiles: image.tiles.map((kind, i) => tileSvg(kind, i)),
  };
}

const checkboxBody = z.object({ webdriver: z.boolean().optional() });
const imagesBody = z.object({ selected: z.array(z.number().int().min(0).max(8)).max(9) });

export function registerCaptchaRoutes(app: Hono<AppEnv>, ctx: AppContext): void {
  const { state } = ctx;

  const current = (c: Ctx): CaptchaChallenge | undefined =>
    state.captchas.get(getCookie(c, CAPTCHA_COOKIE) ?? '');

  const page = (
    c: Ctx,
    challenge: CaptchaChallenge,
    continuar: string,
    error?: SafeHtml | string,
  ) =>
    renderSede(
      c,
      ctx,
      {
        title: 'Verificación de seguridad',
        breadcrumbs: [{ label: 'Verificación de seguridad' }],
        body: html`<h1>Verificación de seguridad</h1>
          <p>Para proteger este servicio frente a usos automatizados, confirma que eres una persona.</p>
          ${error ? alertBox('error', error) : ''}
          <div class="captcha" id="captcha" data-resuelto="${challenge.solved ? 'si' : 'no'}">
            <div class="captcha-casilla">
              <input type="checkbox" id="no-robot"${challenge.solved ? html` checked disabled` : ''}>
              <label for="no-robot">No soy un robot</label>
              <span class="captcha-marca" aria-hidden="true">mock-CAPTCHA<br>Privacidad · Condiciones</span>
            </div>
            <div class="captcha-reto" id="captcha-reto" hidden>
              <p id="captcha-instruccion"></p>
              <p id="captcha-error" class="error-campo" hidden></p>
              <div class="captcha-rejilla" id="captcha-rejilla" role="group" aria-labelledby="captcha-instruccion"></div>
              <button type="button" class="boton" id="captcha-verificar">Verificar</button>
            </div>
            <p id="captcha-estado" role="status" aria-live="polite">${challenge.solved ? 'Verificación completada.' : ''}</p>
          </div>
          <form method="post" action="/verificacion" class="formulario">
            <input type="hidden" name="continuar" value="${continuar}">
            <button type="submit" class="boton">Continuar</button>
          </form>`,
      },
      error ? 400 : 200,
    );

  app.get('/verificacion', (c) => {
    let challenge = current(c);
    if (!challenge || challenge.used) {
      challenge = {
        id: randomId(),
        createdAt: state.now(),
        solved: false,
        used: false,
        attempts: 0,
      };
      state.captchas.set(challenge.id, challenge);
      setCookie(c, CAPTCHA_COOKIE, challenge.id, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      });
      ctx.log(
        `[Verificación] Página «No soy un robot» pendiente. Resuélvela con: curl -sk -X POST ${ctx.urls.main}/__test/solve-captcha`,
      );
    }
    return page(c, challenge, safePath(c.req.query('continuar')));
  });

  app.post('/verificacion/casilla', async (c) => {
    const challenge = current(c);
    if (!challenge) return c.json({ status: 'expired' }, 400);
    if (challenge.solved) return c.json({ status: 'solved' });
    const parsed = checkboxBody.safeParse(await c.req.json().catch(() => ({})));
    if (parsed.success && parsed.data.webdriver === false) {
      challenge.solved = true;
      challenge.solvedBy = 'casilla';
      return c.json({ status: 'solved' });
    }
    challenge.image = newImageChallenge();
    return c.json(challengeJson(challenge.image));
  });

  app.post('/verificacion/imagenes', async (c) => {
    const challenge = current(c);
    if (!challenge?.image) return c.json({ status: 'expired' }, 400);
    if (challenge.solved) return c.json({ status: 'solved' });
    const parsed = imagesBody.safeParse(await c.req.json().catch(() => ({})));
    const selected = parsed.success ? [...new Set(parsed.data.selected)].sort((a, b) => a - b) : [];
    if (selected.join(',') === challenge.image.correct.join(',')) {
      challenge.solved = true;
      challenge.solvedBy = 'imagenes';
      return c.json({ status: 'solved' });
    }
    challenge.attempts += 1;
    challenge.image = newImageChallenge();
    return c.json(challengeJson(challenge.image, 'No es correcto. Inténtalo de nuevo.'));
  });

  app.get('/verificacion/estado', (c) => c.json({ solved: current(c)?.solved ?? false }));

  app.post('/verificacion', async (c) => {
    const body = await c.req.parseBody();
    const continuar = safePath(field(body, 'continuar'));
    const challenge = current(c);
    if (!challenge)
      return c.redirect(`/verificacion?continuar=${encodeURIComponent(continuar)}`, 303);
    if (!challenge.solved) {
      return page(c, challenge, continuar, 'Marca la casilla «No soy un robot» para continuar.');
    }
    challenge.used = true;
    const session = c.get('session');
    if (session) session.captchaPassed = true;
    return c.redirect(continuar, 303);
  });
}
