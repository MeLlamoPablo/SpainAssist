/**
 * Opens the learnings admin page in the browser, already signed in.
 *
 *   corepack pnpm feedback               # production: reads infra/terraform (git-crypt unlocked)
 *   corepack pnpm feedback --print       # print the link instead of opening it
 *   corepack pnpm feedback --local       # http://127.0.0.1:8788 with $ADMIN_TOKEN
 *   corepack pnpm feedback --url <base>  # another feedback server, with $ADMIN_TOKEN
 *
 * The link carries the admin token in its fragment: treat it like the token itself.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AdminLinkError, adminPageUrl, resolveAdminLink } from './admin-link';

const TERRAFORM_DIR = fileURLToPath(new URL('../../../../infra/terraform/', import.meta.url));

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function openInBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
        : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', (err) => {
    console.error(`Could not open a browser (${err.message}). Use --print instead.`);
    process.exitCode = 1;
  });
  child.unref();
}

function run(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift(); // `pnpm run x -- --flag` forwards the separator
  const { values } = parseArgs({
    args: argv,
    options: {
      print: { type: 'boolean', default: false },
      local: { type: 'boolean', default: false },
      url: { type: 'string' },
    },
  });

  let link: string;
  if (values.local || values.url) {
    const token = process.env.ADMIN_TOKEN;
    if (!token) throw new AdminLinkError("set ADMIN_TOKEN to the server's admin token");
    link = adminPageUrl(values.url ?? `http://127.0.0.1:${process.env.PORT || 8788}`, token);
  } else {
    link = resolveAdminLink({
      tfvars: readOptional(`${TERRAFORM_DIR}terraform.tfvars`),
      state: readOptional(`${TERRAFORM_DIR}terraform.tfstate`),
    });
  }

  if (values.print) {
    console.log(link);
  } else {
    console.error(`Opening ${link.replace(/#.*/, '')}`);
    openInBrowser(link);
  }
}

try {
  run();
} catch (err) {
  console.error(`feedback: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
