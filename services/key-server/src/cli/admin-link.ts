/**
 * Builds the admin page link from the Terraform files: the token from `terraform.tfvars`
 * (`key_server_admin_token`) and the key server URL from the state's `urls` output (or from the
 * `domain` variable). The token goes in the URL fragment, which browsers never send to the
 * server, put in Referer headers or write to access logs; the page moves it to sessionStorage
 * and clears the address bar.
 */

export class AdminLinkError extends Error {}

const GIT_CRYPT_MAGIC = '\0GITCRYPT';

export function isGitCryptLocked(text: string): boolean {
  return text.startsWith(GIT_CRYPT_MAGIC);
}

/**
 * Reads a top-level string variable (`name = "value"`) from a .tfvars file. Commented-out lines
 * are ignored; heredocs and expressions are not supported (none of ours need them).
 */
export function readTfvarsString(text: string, name: string): string | undefined {
  const re = new RegExp(String.raw`^[ \t]*${name}[ \t]*=[ \t]*"((?:[^"\\\n]|\\.)*)"`, 'm');
  const match = re.exec(text);
  if (!match) return undefined;
  return match[1]!.replace(/\\(["\\])/g, '$1');
}

/** `urls.key_server` from a Terraform state file (JSON), if present. */
export function keyServerUrlFromState(stateJson: string): string | undefined {
  try {
    const state = JSON.parse(stateJson) as {
      outputs?: { urls?: { value?: { key_server?: unknown } } };
    };
    const url = state.outputs?.urls?.value?.key_server;
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
  if (isGitCryptLocked(tfvars) || (state !== undefined && isGitCryptLocked(state))) {
    throw new AdminLinkError(
      'the Terraform files are encrypted: run `git-crypt unlock` in this checkout first',
    );
  }
  const token = readTfvarsString(tfvars, 'key_server_admin_token');
  if (!token) {
    throw new AdminLinkError('key_server_admin_token is empty: the admin page is disabled');
  }
  const domain = readTfvarsString(tfvars, 'domain');
  const base =
    (state !== undefined ? keyServerUrlFromState(state) : undefined) ??
    (domain ? `https://keys.${domain}` : undefined);
  if (!base) {
    throw new AdminLinkError(
      'no key server URL: set `domain` in terraform.tfvars or apply once (`urls` output)',
    );
  }
  return adminPageUrl(base, token);
}
