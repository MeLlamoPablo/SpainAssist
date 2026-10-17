/**
 * A browser stand-in for the integration tests against the real SpainBench: plain `node:http` to
 * the public listener on 127.0.0.1, with the contract headers the network layer sends (the real
 * host in `Host` and `X-SpainBench-Host`, the world in `X-SpainBench-World`, `X-Forwarded-Proto:
 * https`) and no cookies. It follows `server/scripts/harness-smoke.mjs` of SpainBench: the Cl@ve
 * Permanente login of the synthetic Lucía Moreno Castillo (documented in the site's README) and
 * the vida laboral download. Never use it with anything but a loopback origin.
 */
import http from 'node:http';

export const PORTAL = 'portal.seg-social.gob.es';
export const IDP = 'idp.seg-social.es';
export const CLAVE = 'clave-dninbrt.seg-social.gob.es';

/** The synthetic account of the seg-social-es site. */
export const ACCOUNT = { document: '53918274H', password: 'SpainBench2026!', naf: '283174209647' };

const INFO_PATH =
  '/wps/portal/importass/importass/Categorias/Vida+laboral+e+informes/Informes+sobre+tu+situacion+laboral/Informe+de+tu+vida+laboral';
const LOGIN_PATH =
  '/wps/portal/importass/!ut/p/z0/04_Sj9CPykssy0xPLMnMz0vMAfIj8nKt8jNTrMoLivV88tMz8_QLsh0VAZSk7Xs!/';
const VIDA_LABORAL_PATH = '/wps/myportal/importass/importass/tramites/datosvidalaboral';
const DOWNLOAD_PATH =
  '/wps/myportal/importass/importass/tramites/datosvidalaboral/inicio/p0/NJgenDoc=Eaccion!AC_DESC_VIDA_LABORAL==/';

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  buffer: Buffer;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** One request to `origin` (a loopback origin) as the agent's `host`, in world `world`. */
export function publicRequest(
  origin: string,
  world: string,
  host: string,
  path: string,
  { method = 'GET', headers = {}, body }: RequestOptions = {},
): Promise<Reply> {
  const url = new URL(origin);
  if (url.hostname !== '127.0.0.1') throw new Error(`Refusing to send anything to ${url.hostname}`);
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(body, 'utf8');
    const request = http.request(
      {
        host: url.hostname,
        port: Number(url.port),
        method,
        path,
        headers: {
          Host: host,
          'X-SpainBench-Host': host,
          'X-SpainBench-World': world,
          'X-Forwarded-Proto': 'https',
          ...(data
            ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': data.length }
            : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: buffer.toString('utf8'),
            buffer,
          });
        });
      },
    );
    request.on('error', reject);
    if (data) request.write(data);
    request.end();
  });
}

const unescapeHtml = (text: string): string =>
  text.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_match, name: string) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name] as string,
  );

/** Every `<input type="hidden">` of a page. */
function hiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [tag] of html.matchAll(/<input\b[^>]*>/gi)) {
    if (!/type\s*=\s*"hidden"/i.test(tag)) continue;
    const name = /\bname\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    if (name) fields[name] = unescapeHtml(/\bvalue\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? '');
  }
  return fields;
}

/** The action of the page's form, or the `formaction` / `action` whose value contains `pick`. */
function formAction(html: string, pick?: string): string {
  const pattern = pick
    ? new RegExp(`(?:formaction|action)\\s*=\\s*"([^"]*${pick}[^"]*)"`, 'i')
    : /<form\b[^>]*\baction\s*=\s*"([^"]*)"/i;
  const match = pattern.exec(html);
  if (!match) throw new Error(`No form action${pick ? ` matching "${pick}"` : ''} in the page`);
  return unescapeHtml(match[1] as string);
}

const encode = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

/** An absolute `https://host/path` or a path on `fallback`, as the host and path to request. */
function target(value: string, fallback: string): { host: string; path: string } {
  const absolute = /^https?:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i.exec(value);
  if (absolute)
    return { host: absolute[1] as string, path: `${absolute[2] || '/'}${absolute[3] || ''}` };
  return { host: fallback, path: value };
}

/**
 * The Cl@ve Permanente login of the vida laboral flow, one hop at a time (each hop is a
 * self-submitting form or a redirect that a browser would follow by itself). The world it talks to
 * can change between steps (`world`), which is how a snapshot taken at the form is finished in
 * another world.
 */
export class ClaveLogin {
  /** The page the next step reads. */
  page: Reply | undefined;

  constructor(
    private readonly origin: string,
    public world: string,
  ) {}

  private call(host: string, path: string, options?: RequestOptions): Promise<Reply> {
    return publicRequest(this.origin, this.world, host, path, options);
  }

  /** Posts the self-submitting form of the current page to the host its action names. */
  private async hop(fallback: string, pick?: string): Promise<Reply> {
    const page = this.page as Reply;
    const { host, path } = target(formAction(page.text, pick), fallback);
    const next = await this.call(host, path, {
      method: 'POST',
      body: encode(hiddenFields(page.text)),
    });
    this.page = next;
    return next;
  }

  /** From the public page to the Cl@ve Permanente form. */
  async toForm(): Promise<void> {
    let page = await this.call(PORTAL, INFO_PATH);
    if (page.status !== 200) throw new Error(`portal info page: ${page.status}`);
    this.page = await this.call(PORTAL, LOGIN_PATH);
    await this.hop(PORTAL);
    await this.hop(IDP);
    page = this.page;
    const { host, path } = target(formAction(page.text, 'seleccion=IPUC'), IDP);
    this.page = await this.call(host, path, { method: 'POST' });
    await this.hop(CLAVE);
    await this.hop(CLAVE);
    await this.hop(CLAVE);
    if (!/id_owner/.test(this.page.text))
      throw new Error('did not reach the Cl@ve Permanente form');
  }

  /** From the form to the logged-in portal. */
  async finish(account = ACCOUNT): Promise<void> {
    const page = this.page as Reply;
    const form = target(formAction(page.text), CLAVE);
    const submitted = await this.call(form.host, form.path, {
      method: 'POST',
      body: encode({
        ...hiddenFields(page.text),
        id_owner: account.document,
        pin: account.password,
      }),
    });
    if (submitted.status !== 302) throw new Error(`Cl@ve submit: ${submitted.status}`);
    const next = target(String(submitted.headers.location), CLAVE);
    this.page = await this.call(next.host, next.path);
    await this.hop(CLAVE);
    await this.hop(IDP);
    const acs = await this.hop(PORTAL);
    if (acs.status !== 303) throw new Error(`portal ACS: ${acs.status}`);
    const home = target(String(acs.headers.location), PORTAL);
    this.page = await this.call(home.host, home.path);
    if (!/Área personal/.test(this.page.text)) throw new Error('the login did not finish');
  }

  async run(account = ACCOUNT): Promise<void> {
    await this.toForm();
    await this.finish(account);
  }
}

/** The vida laboral page (where most plants live) and then the PDF; returns the PDF. */
export async function downloadVidaLaboral(origin: string, world: string): Promise<Reply> {
  const page = await publicRequest(origin, world, PORTAL, VIDA_LABORAL_PATH);
  if (!/Tu vida laboral/.test(page.text)) throw new Error('did not reach the vida laboral page');
  const file = await publicRequest(origin, world, PORTAL, DOWNLOAD_PATH);
  if (file.status !== 200 || file.buffer.subarray(0, 5).toString() !== '%PDF-') {
    throw new Error(`the download is not a PDF (${file.status})`);
  }
  return file;
}
