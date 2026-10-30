# Infrastructure

Four small backends, plus Postgres, a LiteLLM gateway, Unleash and GlitchTip:

| Service | Port | Database | What |
| --- | --- | --- | --- |
| `key-server` | 8787 | `keyserver` (role `key_server`) | Vouchers → capped LiteLLM keys, web research ([README](../services/key-server/README.md)) |
| `feedback-server` | 8788 | `feedback` (role `feedback`) | Anonymous learnings ([README](../services/feedback-server/README.md)) |
| `maps-server` | 8793 | – | Mapbox address lookups behind users' LiteLLM keys ([README](../services/maps-server/README.md)) |
| `relay-server` | 8794 | – | Desktop ↔ phone relay for DNIe signatures ([README](../services/relay-server/README.md)) |
| `webhook-ingester` (production only) | 8795 | – | GitHub push webhooks → Coolify, nothing else ([README](../services/webhook-ingester/README.md)) |
| `postgres` | internal | – | Postgres 17, one database and one role per service |
| `litellm` (production only) | 4000 | `litellm` (role `litellm`) | LLM and search gateway: OpenRouter and Parallel behind budget-capped virtual keys |
| `unleash` (production only) | 4242 | `unleash` (role `unleash`) | Feature flags |
| `glitchtip` (production only) | 8000 | `glitchtip` (role `glitchtip`) | The desktop app's error reports (Sentry protocol) |

Production runs on one Hetzner VM managed by Coolify, all declared in Terraform (see
[Production](#production-hetzner--coolify-terraform)). The app has the production URLs built in
(`PRODUCTION_SERVICES` in `@sa/shared`; not settings). Development builds can point elsewhere
with `SA_KEY_SERVER_URL`, `SA_FEEDBACK_SERVER_URL`, `SA_MAPS_SERVER_URL` and
`SA_RELAY_SERVER_URL`, and turn flags on with `SA_FEATURE_FLAGS`; packaged builds ignore them.

## Local development without Docker

Each service runs straight from TypeScript. The key and feedback servers keep an embedded PGlite
database under their own `.data/` directory (git-ignored), so nothing else is needed:

```sh
corepack pnpm install
corepack pnpm services -- --mocks   # every backend + mock LLM (:8789) and mock sede (:8790)
corepack pnpm dev:local             # the desktop app, pointed at them
```

- `corepack pnpm services` (`scripts/dev-services.mjs`) starts the key server (`DEV_SEED=1`:
  demo voucher `SA-DEMO42`), the feedback server (`DEV_SEED=1`: example learnings) and the relay
  (on `0.0.0.0`, so a phone on the same Wi-Fi can reach it). The maps server starts only when
  `MAPBOX_TOKEN` and `LITELLM_URL` are set. `--mocks` adds the mock LLM and the mock sede;
  `--only key-server,mock-sede` picks services. Ctrl+C stops them all.
- `corepack pnpm dev:local` points the four `SA_*_SERVER_URL` variables at `127.0.0.1` and turns
  on the `dnie-phone` flag.
- Without `LITELLM_ADMIN_URL` the key server issues mock keys for the mock LLM, so onboarding
  works fully offline. Without `LITELLM_URL` the feedback server only searches (no sharing or
  votes).
- One service by hand: `corepack pnpm --filter @sa/<name> dev` (watch mode). Use
  `DATABASE_URL=pglite://memory` for a throwaway database.

## Local stack with Docker

A production-like Postgres, key server and feedback server (no LiteLLM, maps or relay):

```sh
cp infra/.env.example infra/.env     # set VOUCHER_PEPPER (required) and the passwords
docker compose -f infra/docker-compose.yml up -d --build
docker compose -f infra/docker-compose.yml logs -f key-server
curl -s localhost:8787/health
```

Create vouchers inside the running stack (codes are printed once):

```sh
docker compose -f infra/docker-compose.yml exec key-server \
  node --import tsx src/cli/vouchers-create.ts --count 5 --amount 5 --note "launch"
# or, with ADMIN_TOKEN set:
curl -s localhost:8787/admin/vouchers -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"count":5,"amountUsd":5}'
```

Notes:

- Images build from the repository root (`context: ..`) with `services/<name>/Dockerfile`:
  `node:24.22.1-slim` (pinned by digest), `corepack pnpm install --frozen-lockfile --prod
  --filter @sa/<name>...`, run with `node --import tsx` (no build step). Each service's `Dockerfile.dockerignore` keeps host
  `node_modules` and `.data` out of the image.
- Compose reads `infra/.env`. Every variable has a default, and empty values count as unset. The
  stack's own variables are `BIND_ADDRESS` (default `127.0.0.1`: the interface ports are
  published on), `POSTGRES_PASSWORD`, and the role passwords `KEY_SERVER_DB_PASSWORD` and
  `FEEDBACK_DB_PASSWORD` (URL-safe characters only). The services' own settings are in their
  READMEs; add any the compose file lacks to their `environment:` block.
- `postgres/init/10-create-databases.sh` runs only when the `pgdata` volume is created (roles,
  databases, `unaccent` and `pg_trgm` for the feedback database). Changing a password later:
  `ALTER ROLE key_server PASSWORD '…'`, then update `.env`. Postgres is not published.
- Validate the file without a Docker daemon: `docker compose -f infra/docker-compose.yml config`.
- Backups: `docker compose -f infra/docker-compose.yml exec -T postgres pg_dump -U postgres keyserver > keyserver.sql`
  (same for `feedback`). Losing `VOUCHER_PEPPER` invalidates every unredeemed code.

## Production: Hetzner + Coolify (Terraform)

`infra/terraform/` provisions one Hetzner Cloud VM, installs [Coolify](https://coolify.io) on
it and declares everything Coolify runs, with the
[Coolify provider](https://registry.terraform.io/providers/coolify-terraform/coolify/latest):

```text
Hetzner Cloud, nbg1: reserved IPv4 + IPv6; firewall: 22, 80, 443, UDP 41641 (Tailscale) (+ ICMP)
└─ cx23 (2 vCPU, 4 GB), Ubuntu 26.04, 2 GB swap, daily Hetzner backups
   ├─ Tailscale: Coolify's dashboard at https://spainassist.<tailnet>.ts.net (tailnet only)
   ├─ webhook-ingester  https://hooks.<domain>/github  GitHub push webhooks → Coolify
   └─ Coolify 4.4.7: on loopback only (no public dashboard), Traefik + Let's Encrypt
      └─ project "SpainAssistant" / production
         ├─ postgres          Postgres 17: databases keyserver, feedback, litellm, unleash,
         │                    glitchtip (one role each); daily pg_dump, 7 kept on the server
         ├─ key-server        https://keys.<domain>      vouchers → capped LiteLLM keys
         ├─ feedback-server   https://feedback.<domain>  anonymous learnings
         ├─ maps-server       https://maps.<domain>      Mapbox address lookups (holds the
         │                                               Mapbox secret token)
         ├─ relay-server      https://relay.<domain>     desktop ↔ phone relay, pairing page
         ├─ litellm           https://llm.<domain>       LiteLLM proxy: holds the OpenRouter
         │                                               and Parallel keys
         ├─ unleash           https://flags.<domain>     Unleash: feature flags
         └─ glitchtip         https://errors.<domain>    GlitchTip: the desktop app's error
                                                         reports (Sentry protocol)
```

`<domain>` is `spainassist.es` (`var.domain`). It is registered with Route 53 Domains, and its
hosted zone has an A and an AAAA record for every host above (see `dns.tf`). The apex and `www`
point at the website, which is on Framer.

Desktop versions released before the move to `<domain>` call the server's sslip.io name instead
(`keys.2-31-6-160.sslip.io` and so on, which resolves to the IP without DNS). So keys, feedback,
maps, llm and flags answer on both names (`legacy_hosts` in `hetzner.tf`,
`./tf.sh output legacy_urls`). Keep them, and never release the reserved IPv4: the old names are
the IP. The relay and the webhook host are on `<domain>` only.

| File | What |
| --- | --- |
| `versions.tf` | Providers: hcloud, tls, github (deploy key), coolify (through the SSH tunnel), unleash, aws |
| `hetzner.tf` + `templates/cloud-init.yaml.tftpl` | SSH keys, reserved IPs, firewall, server; cloud-init installs updates, swap and Coolify (no secrets) |
| `bootstrap.tf` + `templates/coolify-bootstrap.*`, `templates/sa-coolify-firewall.sh` | Over SSH: Coolify's root user, API token and API access, no instance domain, Coolify's ports on loopback only; upgrades Coolify when `coolify_version` changes |
| `webhook_ingester.tf` + `templates/webhook-ingester.compose.yaml.tftpl` | The webhook ingester's container (GitHub → Coolify), uploaded from this checkout |
| `coolify.tf` + `templates/databases.sql.tftpl` | Project, Postgres, its per-service roles and daily backup, GitHub deploy key and webhook, the four apps, their env vars and deployments |
| `litellm.tf` + `templates/litellm_sa_pricing.py` | LiteLLM's compose file, `config.yaml` (models, search tools), pricing callback, env vars, restart on change |
| `unleash.tf` | Unleash's compose file, env vars, restart on change, the desktop app's frontend tokens |
| `glitchtip.tf` | GlitchTip's compose file, env vars, restart on change, its admin user |
| `dns.tf` | Route 53: the registered domain (name servers, auto-renew), its hosted zone, the service records and the website's (Framer) |
| `aws_iam.tf` | The IAM user Terraform manages AWS with: only `dns.tf`'s resources, never deleting or transferring a domain |
| `github_release.tf` + `secrets/` | GitHub Actions secrets for macOS signing/notarization, Microsoft Store submission, and Android signing/Google Play identity federation (`apps/mobile/README.md`, Releasing) |
| `tf.sh` | Runs Terraform with an SSH tunnel to Coolify's API |

### Why it looks like this

- **LiteLLM** is the only way to give users capped keys for Parallel, which has no per-key
  limits: one LiteLLM virtual key with a USD budget covers chat (OpenRouter behind LiteLLM)
  and search (`POST /v1/search/parallel`). Upstream keys live only in LiteLLM (and Parallel's
  in the key server too, for web research). Our server sees every prompt, so LiteLLM stores
  none (`store_prompts_in_spend_logs: false`, `turn_off_message_logging`, log level ERROR). See
  [docs/research/litellm-gateway.md](../docs/research/litellm-gateway.md).
- **Every OpenRouter model.** One wildcard route (`*` → `openrouter/*`) serves every
  OpenRouter model under its OpenRouter id. LiteLLM charges keys with the cost OpenRouter
  reports for each call (streamed or not), so models missing from LiteLLM's price list still
  count against budgets. Voucher keys may call every model and search tool; ChatGPT keys only
  the Perplexity Decider route and the transcription model (see the key server's `KEY_ROUTES`).
- **No secrets in cloud-init.** The metadata service that serves user data is readable from
  every container on the VM. cloud-init installs Coolify without a root user (nobody can
  reach the dashboard yet: port 8000 is closed); the secrets go over SSH afterwards.
- **Coolify itself is not public.** Its dashboard, API and realtime ports (8000, 6001, 6002)
  answer on loopback only: `templates/sa-coolify-firewall.sh` drops them on every other
  interface (in `mangle PREROUTING`, because Tailscale accepts tailnet traffic before Docker's
  `DOCKER-USER` chain), and Coolify has no instance domain, so its proxy routes nothing to it.
  Terraform reaches the API through an SSH tunnel (`tf.sh`); people reach the dashboard on the
  tailnet ([Coolify's dashboard](#coolifys-dashboard-tailnet)). This came after
  CVE-2026-109618/109619 (unauthenticated PHP RCE, October 2026): a public Coolify is a public
  PHP application.
- **GitHub reaches Coolify only through the webhook ingester** (`webhook_ingester.tf`,
  [services/webhook-ingester](../services/webhook-ingester/README.md)), at
  `https://hooks.<domain>/github`. It checks GitHub's signature, then sends Coolify a new request
  with only the fields Coolify deploys from, re-signed, so nothing unsigned (and nothing but
  those fields) ever reaches Coolify's PHP. It is a plain container next to Coolify, not a
  Coolify app: it runs without Coolify and deploys from your checkout, without a push.
- **One Postgres, one role per service.** Coolify's API cannot run init scripts, so
  `terraform_data.databases` creates roles and databases over SSH (idempotent).
- **Builds from GitHub, deploys on push.** Coolify clones the private repository with a
  read-only deploy key that Terraform creates (`github_repository_deploy_key`), and a GitHub
  push webhook triggers the deploy. It builds what is pushed to `git_branch` (default `master`),
  not your working copy.
- **LiteLLM's config travels in an environment variable.** Coolify writes a compose `content:`
  file only once and ignores later edits, so `config.yaml` is base64 in `LITELLM_CONFIG_B64`
  (and the pricing module in `LITELLM_PRICING_B64`), and the entrypoint writes them before
  starting LiteLLM. Changing models or search tools restarts LiteLLM with the new file.
- **Coolify 4.3.23 quirks.** `POST /services` refuses `connect_to_docker_network`, so LiteLLM's
  compose joins the external `coolify` network itself. Coolify copies the image's
  `HEALTHCHECK` timings into the app settings, so `coolify.tf` repeats them to keep plans clean.
- **The decider route relies on the proxy normalizing paths.** Keys may call
  `/openrouter/alpha/decisions` (scan screening). LiteLLM (v1.104, still so in v1.106.2) matches
  allowed routes as prefixes and its pass-through resolves `..`, so
  `…/decisions/../../v1/chat/completions` would reach OpenRouter chat on our key with no spend
  recorded. Coolify's Traefik cleans `..` and `%2e%2e` before LiteLLM sees the path (which
  LiteLLM then refuses) and rejects encoded slashes; checked on 2026-10-05 with
  `curl --path-as-is`. Re-check after Traefik or LiteLLM upgrades, or if LiteLLM ever runs behind
  another proxy.
- **Prices** come from `templates/litellm_sa_pricing.py` (a LiteLLM callback module written next
  to its config). At start and every 6 hours it loads OpenRouter's public price list
  (`/api/v1/models`) and registers every priced model, so a new model needs no deploy; Perplexity
  Decider, which that list lacks, is registered by hand. Without a price, calls cost $0 and escape
  key budgets, so the same module rejects chat calls to models without one (OpenRouter's routers
  such as `openrouter/auto`, free models, and models LiteLLM's own list lacks if OpenRouter's
  cannot be loaded): budget reservation needs a price to check a call's worst case.
  A missing chat price triggers one refresh and recheck before rejection, off the event loop.
  Concurrent misses share the refresh; miss-triggered attempts (including failures) are limited
  to one per minute per process across all model names. Already priced calls proceed immediately.
  The container log shows `sa_pricing: registered N OpenRouter prices`.

  Offline pricing callback tests: `python3 -m unittest discover -s infra/tests -v` (standard
  library only; LiteLLM, FastAPI, the catalog request and the startup thread are mocked).

### Requirements

- Terraform ≥ 1.6 (the Coolify provider's floor): `brew install hashicorp/tap/terraform`, or
  run `tf.sh` with `TERRAFORM=/path/to/terraform`.
- `gh auth login` (or `GITHUB_TOKEN`) with admin rights on the repository: the GitHub provider
  manages the deploy key, the webhook and the release's Actions secrets with it.
- `ssh` and `nc`.
- An AWS key: `aws_access_key_id`/`aws_secret_access_key` in `terraform.tfvars` (the IAM user
  from `aws_iam.tf`). The apply that creates that user, and any later change to its policy,
  needs an admin key instead: `./tf.sh apply -var-file=<admin.tfvars>`, or for the very first
  apply `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` with the two variables left out.

### First deployment

```sh
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in; see the comments
./tf.sh init
./tf.sh bootstrap   # Hetzner resources + Coolify (≈10 min); the Coolify provider needs Coolify running
./tf.sh apply       # Postgres, LiteLLM, Unleash, GlitchTip and the four apps (built from GitHub)
./tf.sh output urls
```

Then put the server on the tailnet ([Coolify's dashboard](#coolifys-dashboard-tailnet)).

Log in to Coolify with `./tf.sh output coolify_root_email` and `coolify_root_password` from
`terraform.tfvars`; to LiteLLM's UI (`/ui`) as `admin` with `litellm_ui_password`; to Unleash as
`admin` with `unleash_admin_password` (only applied on Unleash's first start: change it later in
Unleash's UI). Terraform manages Unleash's API tokens with `unleash_admin_token`, which Unleash
seeds on its first start. The app has two frontend tokens built in
(`PRODUCTION_SERVICES.flagsTokens`): `desktop` for the `production` environment (packaged
builds) and `api-key-default-development` for `development` (development builds; created in
Unleash's UI and added to the state by hand). The flags themselves are created by hand in
Unleash's UI (project `default`): `dnie-phone` (type experiment; its strategy's variant
`prerelease` or `release` sets the DNIe's stage, and on without a variant means `release`, which is
also all that versions up to 0.3.0 understand), `must-update` (constrained on the `appVersion` context field,
e.g. `SEMVER_LT 0.3.0`: without a constraint it blocks every version) and `error-reports` (type
kill switch, on in production). The desktop reads them at start-up, and every flag is off when
Unleash can't be reached (`FEATURE_FLAG_NAMES` in `@sa/shared`).

### Coolify's dashboard (tailnet)

The dashboard is at `https://spainassist.pygmy-reedfish.ts.net` (`var.coolify_dashboard_url`),
for devices on the tailnet only: Tailscale Serve terminates HTTPS with a Tailscale certificate
and proxies to Coolify on loopback, including its websockets (realtime on `/app`, terminal on
`/terminal/ws`, which Coolify uses when the page has no port). Terraform doesn't manage
Tailscale; on a new server, as root:

```sh
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --auth-key=<key from the admin console> --hostname=spainassist --accept-dns=false
tailscale serve --bg --https=443 http://127.0.0.1:8000
tailscale serve --bg --https=443 --set-path=/app http://127.0.0.1:6001/app
tailscale serve --bg --https=443 --set-path=/terminal/ws http://127.0.0.1:6002/terminal/ws
```

The Hetzner firewall lets Tailscale's UDP port 41641 in: without it, direct connections rely on
hole punching through the stateful firewall, keep falling back to a DERP relay, and the dashboard
stalls. Coolify's nginx only compresses in its HTTPS mode, so the bootstrap turns gzip on with
`docker-compose.custom.yml` (Traefik used to compress the dashboard; Serve doesn't).
`--accept-dns=false` leaves the server's resolver (and so the containers' DNS) alone. Serve
strips the mount path before proxying, hence the path repeated in the targets. The
configuration survives reboots (`tailscale serve status`). Without Tailscale, the SSH tunnel
still works: `ssh -L 8000:127.0.0.1:8000 root@<ip>` and http://localhost:8000 (no realtime
updates).

### Error reports (GlitchTip)

The desktop app reports errors with the official Sentry SDK to GlitchTip at
`https://errors.<domain>`, which speaks Sentry's protocol. Self-hosted Sentry needs about
16 GB of memory; GlitchTip runs all-in-one (web server and worker in one process, its queue in
Postgres, no Valkey) in a few hundred MB. Pointing the app at another Sentry-compatible server
only changes its DSN.

- Log in as `admin@<domain>` with `glitchtip_admin_password` (Terraform creates that superuser
  and resets its password when the variable changes). Sign-up is closed and there is no mail
  server, so nobody else gets an account and alerts aren't e-mailed.
- The organization `spain-assist` and its project `desktop` (platform Electron) were created
  once in the UI. The project's DSN (*Settings → Client Keys*) is built into the app as
  `PRODUCTION_SERVICES.errorReportsDsn`. DSNs are public by design: they can only send events.
  Set a rate limit on the key there if a flood ever fills the database.
- Events are kept 90 days (`GLITCHTIP_RETENTION_DAYS`).

### Day to day

- **Deploy new code**: push to `git_branch` (`master`). A GitHub webhook
  (`github_repository_webhook.coolify`, signed with `github_webhook_secret`) tells Coolify
  through the webhook ingester, and Coolify redeploys each app whose `watch_paths` the push touched (the key server also watches
  `models_warningUpdatingThisWillChangeItInAllClientsOnPushToMaster.json`, for its scan deciders): its `services/<name>/**`, the
  workspace packages it uses, the root manifests and the lockfile. A commit message with
  `[skip ci]` skips the deploy. To redeploy without a push, change `deploy_revision` and apply,
  or press *Redeploy* in Coolify. Webhook deploys cause no Terraform drift (apps track the
  branch, not a commit).
- **Settings and secrets**: edit `terraform.tfvars`, `./tf.sh apply`. Terraform sets each app's
  variables (`local.app_env` in `coolify.tf`; their meaning is in each service's README); add or
  override others with `key_server_env`, `feedback_server_env`, `maps_server_env` and
  `relay_server_env`. Changed app variables redeploy that app; LiteLLM restarts when its config
  or variables change.
- **Upgrade Coolify**: bump `coolify_version` and apply (the bootstrap re-runs the installer;
  auto-update is off so the provider and Coolify stay compatible). Coolify's installer takes
  its scripts and compose files from a CDN that serves the newest release, so the bootstrap
  runs the version's own `install.sh` and `upgrade.sh` from its git tag (`v<coolify_version>`),
  pointed at a copy of that tag's files, and restarts Coolify with the tag's compose files if
  anything else is in place. Check that Coolify's GitHub webhook still reads only what the
  webhook ingester sends (its README).
- **Upstream keys**: set `openrouter_api_key` and `parallel_api_key` and apply. An empty
  Parallel key leaves its search tool out of LiteLLM's config.
- **Vouchers**: `corepack pnpm vouchers` (repo root, git-crypt unlocked) opens
  `https://keys.<domain>/admin` signed in (token from `key_server_admin_token`, passed in the
  URL fragment). The admin API also works with curl:
  `curl -s https://keys.<domain>/admin/vouchers -H "authorization: Bearer $ADMIN_TOKEN"`.
  `corepack pnpm feedback` does the same for the feedback server's admin page.
- **LiteLLM keys by hand** (UI or API): always set `allowed_routes` the way the key server does
  (`KEY_ROUTES` in `services/key-server/src/providers/key-provisioner.ts`). LiteLLM's default
  route group includes `/openrouter/*`, a pass-through that uses our OpenRouter key and charges
  nothing to the key's budget.
- **SSH**: `ssh root@$(./tf.sh output -raw ipv4_address)` with the key from
  `ssh_extra_public_keys`, or `./tf.sh output -raw ssh_private_key`.
- **Backups**: Coolify dumps every database daily at 03:00 and keeps 7 on the server; Hetzner's
  daily server backups take them off the machine. Add an S3 destination in Coolify for
  off-site copies. Since Coolify 4.4, restoring one PostgreSQL database keeps objects that
  already exist unless "Replace objects that already exist" is set (the old `--clean`), and
  skips owners and privileges unless "Keep owners and privileges" is set.
- **Destroy**: set `protect = false` and apply first (delete protection on the server and IPs).

### Secrets and git-crypt

`terraform.tfvars` and `terraform.tfstate` hold every secret (the state also has the GitHub
deploy key and Coolify's view of the env vars). Secrets that are files live in `secrets/`: the
Developer ID Application certificate (`developer-id.p12`, its password in `terraform.tfvars`)
and the App Store Connect API key for notarization (`AuthKey_<key id>.p8`). All of them are
committed encrypted with git-crypt (`.gitattributes` at the repository root); a locked clone
sees ciphertext.

- **Unlock**: `git-crypt unlock` decrypts with Pablo's on-device GPG key (`652182…24E6AA2E`),
  the only key file in `.git-crypt/keys/default/0/`.
- **Recovery** without that key: the root commit `89c22c9` (tag `yubikey-recovery`) holds
  a key file for the YubiKey GPG key (`93C1AE…483FD814`). The next commit deletes it, so
  everyday unlocks don't ask for the card. To recover, restore it from that commit and unlock
  with the YubiKey:
  `git checkout yubikey-recovery -- .git-crypt/keys/default/0/93C1AE6AA35C5B388955984612BF2F12483FD814.gpg`.
  Never drop that commit when rewriting history.
- Check `git-crypt status` before committing a new secret file, and add it to `.gitattributes`
  first: without the filter git stores it in plain text.
