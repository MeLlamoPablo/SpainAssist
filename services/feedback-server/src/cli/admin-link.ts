/**
 * Builds the admin page link from the Terraform files: the token from `terraform.tfvars`
 * (`feedback_admin_token`) and the feedback server URL from the state's `urls` output (or from
 * the `domain` variable). The token goes in the URL fragment, which browsers never send to the
 * server, put in Referer headers or write to access logs; the page moves it to sessionStorage
 * and clears the address bar. Same scheme as the key server's `corepack pnpm vouchers`.
 */

export class AdminLinkError extends Error {}

/** Reads a top-level string variable (`name = "value"`) from a .tfvars file. */
export function readTfvarsString(text: string, name: string): string | undefined {
  const re = new RegExp(String.raw`^[ \t]*${name}[ \t]*=[ \t]*"((?:[^"\\\n]|\\.)*)"`, 'm');
  const match = re.exec(text);
  return match ? match[1]!.replace(/\\(["\\])/g, '$1') : undefined;
}

/** `urls.feedback_server` from a Terraform state file (JSON), if present. */
export function feedbackServerUrlFromState(stateJson: string): string | undefined {
  try {
    const url = (
      JSON.parse(stateJson) as { outputs?: { urls?: { value?: { feedback_server?: unknown } } } }
    ).outputs?.urls?.value?.feedback_server;
    return typeof url === 'string' && url ? url : undefined;
  } catch {
    return undefined;
  }
}

export function adminPageUrl(baseUrl: string, token: string): string {
  const url = new URL('/admin', baseUrl);
  url.hash = `token=${encodeURIComponent(token)}`;
  return url.toString();
}

export function resolveAdminLink(files: { tfvars?: string; state?: string }): string {
  const { tfvars, state } = files;
  if (tfvars === undefined) throw new AdminLinkError('infra/terraform/terraform.tfvars not found');
  if ([tfvars, state].some((text) => text?.startsWith('\0GITCRYPT'))) {
    throw new AdminLinkError(
      'the Terraform files are encrypted: run `git-crypt unlock` in this checkout first',
    );
  }
  const token = readTfvarsString(tfvars, 'feedback_admin_token');
  if (!token) throw new AdminLinkError('feedback_admin_token is empty: the admin page is disabled');
  const domain = readTfvarsString(tfvars, 'domain');
  const base =
    (state !== undefined ? feedbackServerUrlFromState(state) : undefined) ??
    (domain ? `https://feedback.${domain}` : undefined);
  if (!base) {
    throw new AdminLinkError(
      'no feedback server URL: set `domain` in terraform.tfvars or apply once (`urls` output)',
    );
  }
  return adminPageUrl(base, token);
}
