/**
 * Heuristics that turn what is on the page into short, actionable notes for the model.
 * (docs/research/browser.md §9.2 for certificate errors, §10 for bot defenses.)
 */

export const CLIENT_CERT_NET_ERROR = /ERR_BAD_SSL_CLIENT_AUTH_CERT|ERR_SSL_CLIENT_AUTH_[A-Z_]+/;

export function certificateRequestedNote(host: string): string {
  const call = host
    ? `call browser_use_certificate with origins ["https://${host}"]`
    : 'call browser_use_certificate with the origin of the site in origins';
  return `${host || 'The site'} asked for a client certificate and none was presented. If the user has a digital certificate or a DNIe, ${call}, then open the page again.`;
}

/**
 * A certificate login that failed in the TLS sidecar. `code` is its X-Sa-Certificate-Error
 * (packages/sidecar/go/errors.go), `detail` the technical reason.
 */
export function certificateFailedNote(host: string, code: string, detail: string): string {
  const site = host || 'the site';
  const why = detail ? ` (${detail.slice(0, 160)})` : '';
  switch (code) {
    case 'declined':
    case 'cancelled':
      return `The user did not approve the certificate login to ${site}. Ask whether they want to try again, or to log in another way (e.g. Cl@ve).`;
    case 'unavailable':
      return `The certificate is not available for ${site} right now${why}. Call browser_use_certificate again if the user still wants to use it.`;
    case 'timeout':
      return `The certificate login to ${site} timed out${why}. With a DNIe, the user must keep the card on the phone until the page loads. Then try again.`;
    case 'rejected':
      return `${site} did not accept the certificate${why}. It may be expired, revoked or not accepted by this site.`;
    case 'no_certificate':
      return certificateRequestedNote(host);
    case 'server_certificate':
      return `${site} has an invalid security certificate${why}: do not continue.`;
    case 'unreachable':
      return `Could not connect to ${site}${why}. Try again later.`;
    default:
      return `Certificate login to ${site} failed${why}.`;
  }
}

/** A page that loaded AutoFirma's JavaScript client (the app's shim answers it). */
export function afirmaPageNote(host: string): string {
  return `${host || 'This page'} uses AutoFirma. The app replaces it: when a button on this page signs or logs in with a certificate through AutoFirma, the app asks the user to approve and pick their certificate or DNIe, and signs. Just click the button and wait; browser_use_certificate is not needed for it (that tool is only for logins where the browser itself asks for a client certificate).`;
}

const CLAVE_NO_CERT =
  /no se ha (?:presentado|seleccionado|enviado|aportado) (?:ning[uú]n )?certificado|no certificate (?:has been|was) (?:submitted|presented|sent)/i;

const CAPTCHA_TEXT =
  /\bcaptcha\b|no soy un robot|i'?m not a robot|(?:introduzca|introduce|escriba|escribe) (?:los caracteres|el texto|el c[oó]digo)[^.\n]{0,40}imagen|c[oó]digo de seguridad de la imagen/i;
const RECAPTCHA_NOTICE =
  /(?:protegido por|protected by|est[aá] protegido por) reCAPTCHA|reCAPTCHA (?:v3|Enterprise)? ?(?:y|and) (?:se aplican|the Google)/gi;

function isVisibleCaptchaFrame(url: string): boolean {
  if (/\/recaptcha\/(?:api2|enterprise)\/anchor/.test(url)) return !/[?&]size=invisible/.test(url);
  if (/hcaptcha\.com\/.*#frame=checkbox|hcaptcha\.com\/captcha\/.*checkbox/.test(url)) return true;
  if (/challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform/.test(url)) return true;
  if (/captcha-delivery\.com/.test(url)) return true;
  return false;
}

export interface NoteInput {
  url: string;
  title: string;
  /** Visible text of the page (masked). */
  text: string;
  frameUrls: readonly string[];
}

export function detectPageNotes(input: NoteInput): string[] {
  const notes: string[] = [];
  let pathname = '';
  let host = '';
  try {
    const u = new URL(input.url);
    pathname = u.pathname;
    host = u.host;
  } catch {
    // about:blank, chrome-error://...
  }

  if (
    (/\b003002\b/.test(input.text) && /certific/i.test(input.text)) ||
    CLAVE_NO_CERT.test(input.text)
  ) {
    notes.push(
      `This page says no client certificate was presented${host ? ` (${host})` : ''}. If the user has a digital certificate, call browser_use_certificate, then start the login again from the site's own "Acceder" button.`,
    );
  }
  if (/\/Sede\/errores\/erro4033\.html$/i.test(pathname)) {
    notes.push(
      'Agencia Tributaria returned its 403 page: certificate access needs a client certificate and none was presented. If the user has one, call browser_use_certificate and retry from the AEAT access selector.',
    );
  }

  const captchaText = input.text.replace(RECAPTCHA_NOTICE, '');
  if (input.frameUrls.some(isVisibleCaptchaFrame) || CAPTCHA_TEXT.test(captchaText)) {
    notes.push(
      'A CAPTCHA is on this page. Do not try to solve it: ask the user to solve it in the browser window (request_user_action), then continue.',
    );
  }

  const head = `${input.title}\n${input.text.slice(0, 2000)}`;
  if (
    /Request Rejected|Intrusion Prevention Violation|The requested URL was rejected|Access Denied\b/i.test(
      head,
    )
  ) {
    notes.push(
      'The site blocked this request (anti-bot firewall). Do not retry in a loop: ask the user to continue in the browser window, or try again later.',
    );
  }
  if (input.url.startsWith('chrome-error://')) {
    notes.push(
      'The browser could not load this page (network error). Check the address or try again later.',
    );
  }
  return notes;
}
