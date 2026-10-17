# Infrastructure

Two small, isolated backends, Postgres, a LiteLLM gateway and Unleash:

| Service | Port | Database | What |
| --- | --- | --- | --- |
| `key-server` | 8787 | `keyserver` (role `key_server`) | Vouchers → capped LiteLLM keys ([README](../services/key-server/README.md)) |
| `feedback-server` | 8788 | `feedback` (role `feedback`) | Anonymous learnings |
| `maps-server` (production only) | 8793 | – | Mapbox address lookups behind users' LiteLLM keys ([README](../services/maps-server/README.md)) |
| `postgres` | internal | – | Postgres 17, one database and one role per service |
| `litellm` (production only) | 4000 | `litellm` (role `litellm`) | LLM and search gateway: OpenRouter and Parallel behind budget-capped virtual keys |
| `unleash` (production only) | 4242 | `unleash` (role `unleash`) | Feature flags |

Production runs on one Hetzner VM managed by Coolify, all declared in Terraform (see
[Production](#production-hetzner--coolify-terraform)). The app has the production URLs built in
(`PRODUCTION_SERVICES` in `@sa/shared`; not settings). Development builds can point elsewhere
with `SA_KEY_SERVER_URL` / `SA_FEEDBACK_SERVER_URL`, e.g. `corepack pnpm dev:local` for
`http://127.0.0.1:8787` and `http://127.0.0.1:8788`; packaged builds ignore them.

## Local development without Docker

Each service runs straight from TypeScript with an embedded PGlite database under its own
`.data/` directory (git-ignored), so nothing else is needed:

```sh
corepack pnpm install
DEV_SEED=1 corepack pnpm --filter @sa/key-server dev       # :8787, demo voucher SA-DEMO-DEMO-DEMO
corepack pnpm --filter @sa/feedback-server dev             # :8788
corepack pnpm --filter @sa/mock-llm dev                    # :8789, used by mock voucher keys
```

Without `LITELLM_ADMIN_URL` the key server issues mock keys for the mock LLM, so onboarding
works fully offline. Use `DATABASE_URL=pglite://memory` for a throwaway database (e.g. e2e
runs).

## Local stack with Docker

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
  `node:24-slim`, `corepack pnpm install --frozen-lockfile --prod --filter @sa/<name>...`, run
  with `node --import tsx` (no build step). The key server's
  `Dockerfile.dockerignore` keeps host `node_modules` and `.data` out of the image.
- The compose file assumes `services/feedback-server/Dockerfile` follows the same pattern and
  that the feedback server reads `HOST`, `PORT`, `DATABASE_URL`, `TRUST_PROXY` and `LOG_LEVEL`;
  add its other settings to its `environment:` block.
- `postgres/init/10-create-databases.sh` runs only when the `pgdata` volume is created (roles,
  databases, `unaccent` and `pg_trgm` for the feedback database). Changing a password later:
  `ALTER ROLE key_server PASSWORD '…'`, then update `.env`.
- Ports are published on `BIND_ADDRESS` (default `127.0.0.1`). Postgres is not published.
- Validate the file without a Docker daemon: `docker compose -f infra/docker-compose.yml config`.
- Backups: `docker compose -f infra/docker-compose.yml exec -T postgres pg_dump -U postgres keyserver > keyserver.sql`
  (same for `feedback`). Losing `VOUCHER_PEPPER` invalidates every unredeemed code.

## Production: Hetzner + Coolify (Terraform)

`infra/terraform/` provisions one Hetzner Cloud VM, installs [Coolify](https://coolify.io) on
it and declares everything Coolify runs, with the
[Coolify provider](https://registry.terraform.io/providers/coolify-terraform/coolify/latest):

```text
Hetzner Cloud, nbg1: reserved IPv4 + IPv6; firewall: 22, 80, 443 (+ ICMP)
└─ cx23 (2 vCPU, 4 GB), Ubuntu 26.04, 2 GB swap, daily Hetzner backups
   └─ Coolify 4.3.23: dashboard https://coolify.<domain>, Traefik + Let's Encrypt
      └─ project "SpainAssistant" / production
         ├─ postgres          Postgres 17: databases keyserver, feedback, litellm, unleash
                              (one role each)
         ├─ key-server        https://keys.<domain>      vouchers → capped LiteLLM keys
         ├─ feedback-server   https://feedback.<domain>  anonymous learnings
         ├─ maps-server       https://maps.<domain>      Mapbox address lookups (holds the
         │                                               Mapbox secret token)
         ├─ litellm           https://llm.<domain>       LiteLLM proxy: holds the OpenRouter
         │                                               and Parallel keys
         └─ unleash           https://flags.<domain>     Unleash: feature flags
```

`<domain>` is `spainassist.es` (`var.domain`). It is registered with Route 53 Domains, and its
hosted zone has an A and an AAAA record for every host above (see `dns.tf`). The apex and `www`
point at the website, which is on Framer.

Desktop versions released before the move call the server's sslip.io name instead
(`keys.2-31-6-160.sslip.io` and so on, which resolves to the IP without DNS). So keys, feedback,
maps, llm and flags answer on both names (`legacy_hosts` in `hetzner.tf`,
`./tf.sh output legacy_urls`). Keep them, and never release
the reserved IPv4: the old names are the IP. The relay and the dashboard are on `<domain>` only.

| File | What |
| --- | --- |
| `versions.tf` | Providers: hcloud, tls, github (deploy key), coolify (through the SSH tunnel), unleash, aws |
| `hetzner.tf` + `templates/cloud-init.yaml.tftpl` | SSH keys, reserved IPs, firewall, server; cloud-init installs updates, swap and Coolify (no secrets) |
| `bootstrap.tf` + `templates/coolify-bootstrap.*` | Over SSH: Coolify's root user, API token, API access and dashboard domain; upgrades Coolify when `coolify_version` changes |
| `coolify.tf` + `templates/databases.sql.tftpl` | Project, Postgres and its per-service roles, GitHub deploy key, both services, their env vars and deployments |
| `litellm.tf` | LiteLLM's compose file, `config.yaml` (models, search tools), env vars, restart on change |
| `unleash.tf` | Unleash's compose file, env vars, restart on change, the desktop app's frontend tokens |
| `dns.tf` | Route 53: the registered domain (name servers, auto-renew), its hosted zone, the service records and the website's (Framer) |
| `aws_iam.tf` | The IAM user Terraform manages AWS with: only `dns.tf`'s resources, never deleting or transferring a domain |
| `tf.sh` | Runs Terraform with an SSH tunnel to Coolify's API |

### Why it looks like this

- **LiteLLM** is the only way to give users capped keys for Parallel, which has no per-key
  limits: one LiteLLM virtual key with a USD budget covers chat (OpenRouter behind LiteLLM)
  and search (`POST /v1/search/parallel`). Upstream keys live only in LiteLLM.
  Our server now sees every prompt, so LiteLLM stores none (`store_prompts_in_spend_logs:
  false`, `turn_off_message_logging`, log level ERROR). See
  [docs/research/litellm-gateway.md](../docs/research/litellm-gateway.md).
- **Every OpenRouter model.** One wildcard route (`*` → `openrouter/*`) serves every
  OpenRouter model under its OpenRouter id. LiteLLM charges keys with the cost OpenRouter
  reports for each call (streamed or not), so models missing from LiteLLM's price list still
  count against budgets. Voucher keys may call every model and search tool; ChatGPT keys only
  the Perplexity Decider route (see the key server's `KEY_ROUTES`).
- **No secrets in cloud-init.** The metadata service that serves user data is readable from
  every container on the VM. cloud-init installs Coolify without a root user (nobody can
  reach the dashboard yet: port 8000 is closed); the secrets go over SSH afterwards.
- **The Coolify API is not public.** Terraform reaches it through an SSH tunnel (`tf.sh`), so
  port 8000 stays closed and the provider's endpoint is known before the server exists. The
  dashboard is served through Coolify's proxy at `https://coolify.<domain>`.
- **One Postgres, one role per service.** Coolify's API cannot run init scripts, so
  `terraform_data.databases` creates roles and databases over SSH (idempotent).
- **Builds from GitHub, deploys on push.** Coolify clones the private repository with a
  read-only deploy key that Terraform creates (`github_repository_deploy_key`), and a GitHub
  push webhook triggers the deploy. It builds what is pushed to `git_branch` (default `master`),
  not your working copy.

- **LiteLLM's config travels in an environment variable.** Coolify writes a compose `content:`
  file only once and ignores later edits, so `config.yaml` is base64 in `LITELLM_CONFIG_B64`
  and the entrypoint writes it before starting LiteLLM. Changing models or search tools
  restarts LiteLLM with the new file.
- **Coolify 4.3.23 quirks.** `POST /services` refuses `connect_to_docker_network`, so LiteLLM's
  compose joins the external `coolify` network itself. Coolify copies the image's
  `HEALTHCHECK` timings into the app settings, so `coolify.tf` repeats them to keep plans clean.

- **The decider route relies on the proxy normalizing paths.** Keys may call
  `/openrouter/alpha/decisions` (scan screening, D12). LiteLLM v1.104 matches allowed routes as
  prefixes and its pass-through resolves `..`, so `…/decisions/../../v1/chat/completions` would
  reach OpenRouter chat on our key with no spend recorded. Coolify's Traefik cleans `..` and
  `%2e%2e` before LiteLLM sees the path (which LiteLLM then refuses) and rejects encoded
  slashes; checked on 2026-10-05 with `curl --path-as-is`. Re-check after Traefik or LiteLLM
  upgrades, or if LiteLLM ever runs behind another proxy.
- **Prices** come from `templates/litellm_sa_pricing.py` (a LiteLLM callback module written next
  to its config). At start and every 6 hours it loads OpenRouter's public price list
  (`/api/v1/models`) and registers every priced model, so a new model needs no deploy; Perplexity
  Decider, which that list lacks, is registered by hand. Without a price, calls cost $0 and escape
  key budgets, so the same module rejects chat calls to models without one (OpenRouter's routers
  such as `openrouter/auto`, free models, and models LiteLLM's own list lacks if OpenRouter's
  cannot be loaded): budget reservation needs a price to check a call's worst case. The container
  log shows `sa_pricing: registered N OpenRouter prices`.

### Requirements

- Terraform ≥ 1.6 (the Coolify provider's floor): `brew install hashicorp/tap/terraform`, or
  run `tf.sh` with `TERRAFORM=/path/to/terraform`.
- `gh auth login` (or `GITHUB_TOKEN`) with admin rights on the repository: the GitHub provider
  manages the deploy key with it.
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
./tf.sh apply       # Postgres, LiteLLM, Unleash, both services (builds from GitHub)
./tf.sh output urls
```

Log in to Coolify with `./tf.sh output coolify_root_email` and `coolify_root_password` from
`terraform.tfvars`; to LiteLLM's UI (`/ui`) as `admin` with `litellm_ui_password`; to Unleash as `admin` with
`unleash_admin_password` (only applied on Unleash's first start: change it later in Unleash's
UI). Terraform manages Unleash's API tokens with `unleash_admin_token`, which Unleash seeds on
its first start. The app has two frontend tokens built in (`PRODUCTION_SERVICES.flagsTokens`):
`desktop` for the `production` environment (packaged builds) and `api-key-default-development`
for `development` (development builds; created in Unleash's UI and added to the state by hand).
The flags themselves are created by hand in Unleash's UI (project `default`): `feedback-server`
and `dnie-phone` (type experiment, off until the phone app is published). The desktop reads
them at start-up, and every flag is off when Unleash can't be reached (`docs/ARCHITECTURE.md`,
"Feature flags").

### Day to day

- **Deploy new code**: push to `git_branch` (`master`). A GitHub webhook
  (`github_repository_webhook.coolify`, signed with `github_webhook_secret`) tells Coolify, which redeploys each app whose `watch_paths`
  the push touched: its `services/<name>/**`, its workspace packages, the root manifests and
  the lockfile. A commit message with `[skip ci]` skips the deploy. To redeploy without a push,
  change `deploy_revision` and apply, or press *Redeploy* in Coolify. Webhook deploys cause no
  Terraform drift (apps track the branch, not a commit).
- **Settings and secrets**: edit `terraform.tfvars`, `./tf.sh apply`. Changed app variables
  redeploy that app; LiteLLM restarts when its config or variables change.
- **Upgrade Coolify**: bump `coolify_version` and apply (the bootstrap re-runs the installer;
  auto-update is off so the provider and Coolify stay compatible).
- **Upstream keys**: set `openrouter_api_key` and `parallel_api_key` and apply. An empty
  Parallel key leaves its search tool out of LiteLLM's config.
- **Vouchers**: `corepack pnpm vouchers` (repo root, git-crypt unlocked) opens
  `https://keys.<domain>/admin` signed in (token from `key_server_admin_token`, passed in the
  URL fragment). The admin API also works with curl:
  `curl -s https://keys.<domain>/admin/vouchers -H "authorization: Bearer $ADMIN_TOKEN"`.
- **LiteLLM keys by hand** (UI or API): always set `allowed_routes` the way the key server
  does (`/v1/chat/completions`, `/v1/models`, `/v1/search`, `/key/info`). LiteLLM's default
  route group includes `/openrouter/*`, a pass-through that uses our OpenRouter key and charges
  nothing to the key's budget.
- **SSH**: `ssh root@$(./tf.sh output -raw ipv4_address)` with the key from
  `ssh_extra_public_keys`, or `./tf.sh output -raw ssh_private_key`.
- **Destroy**: set `protect = false` and apply first (delete protection on the server and IPs).

### Secrets and git-crypt

`terraform.tfvars` and `terraform.tfstate` hold every secret (the state also has the GitHub
deploy key and Coolify's view of the env vars). They are committed encrypted with git-crypt
(`.gitattributes` at the repository root); a locked clone sees ciphertext.

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

## Environment variables

Compose reads `infra/.env`; every variable has a default, and empty values count as unset.

### Stack (compose only)

| Variable | Default | Meaning |
| --- | --- | --- |
| `BIND_ADDRESS` | `127.0.0.1` | Interface the service ports are published on |
| `POSTGRES_PASSWORD` | `postgres` | Superuser password |
| `KEY_SERVER_DB_PASSWORD` / `FEEDBACK_DB_PASSWORD` | `key_server` / `feedback` | Service role passwords (URL-safe characters only) |

### Key server

See the configuration table in
[services/key-server/README.md](../services/key-server/README.md#configuration). In
production Terraform sets them (`local.app_env` in `terraform/coolify.tf`): `DATABASE_URL`,
`VOUCHER_PEPPER`, `ADMIN_TOKEN`, `TRUST_PROXY=1`, and `LITELLM_ADMIN_URL` (LiteLLM's container on
Coolify's network), `LITELLM_MASTER_KEY`, `LITELLM_PUBLIC_URL` (`https://llm.<domain>`). Add others
(e.g. `KEY_TTL_DAYS`, `LITELLM_SEARCH_TOOLS`) with `key_server_env` in `terraform.tfvars`.

### Feedback server

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8788` (`0.0.0.0` in Docker) | Listen address |
| `DATABASE_URL` | PGlite under the service's `.data/` (compose: Postgres `feedback`) | |
| `TRUST_PROXY`, `LOG_LEVEL` | `0`, `info` | Same meaning as for the key server |

Other feedback-server settings are documented in `services/feedback-server/README.md`.
