# Everything that runs inside Coolify: one Postgres (a database and a role per service), the
# key server and the feedback server (built by Coolify from GitHub), LiteLLM (litellm.tf) and
# Unleash (unleash.tf).

data "coolify_servers" "localhost" {
  filter {
    name   = "name"
    values = ["localhost"]
  }
}

locals {
  server_uuid = one(data.coolify_servers.localhost.servers).uuid
}

resource "coolify_project" "main" {
  name        = "SpainAssistant"
  description = "Managed by Terraform (infra/terraform)"

  # Coolify upgrades and token rotations (bootstrap.tf) happen before any resource change.
  depends_on = [terraform_data.coolify]
}

# --- Postgres -----------------------------------------------------------------------------

resource "coolify_database_postgresql" "main" {
  name              = "postgres"
  description       = "Databases keyserver, feedback, litellm and unleash (one role each)"
  project_uuid      = coolify_project.main.uuid
  server_uuid       = local.server_uuid
  environment_name  = "production"
  image             = "postgres:17-alpine"
  postgres_user     = "postgres"
  postgres_password = var.postgres_password
  postgres_db       = "postgres"
  is_public         = false
  instant_deploy    = true
}

locals {
  # Standalone databases run in a container named after their uuid, on the `coolify` network.
  postgres_host = coolify_database_postgresql.main.uuid

  databases = {
    key_server = { database = "keyserver", role = "key_server" }
    feedback   = { database = "feedback", role = "feedback" }
    litellm    = { database = "litellm", role = "litellm" }
    unleash    = { database = "unleash", role = "unleash" }
  }
  database_urls = {
    for k, db in local.databases :
    k => "postgres://${db.role}:${var.service_db_passwords[k]}@${local.postgres_host}:5432/${db.database}"
  }

  database_setup_sql = templatefile("${path.module}/templates/databases.sql.tftpl", {
    databases = local.databases
    passwords = var.service_db_passwords
  })
}

# Coolify's API cannot set Postgres init scripts, so the per-service roles and databases are
# created over SSH (idempotent; re-runs when a password changes).
resource "terraform_data" "databases" {
  triggers_replace = [local.postgres_host, sha256(local.database_setup_sql)]

  connection {
    type        = "ssh"
    host        = local.ipv4
    user        = "root"
    private_key = var.ssh_private_key
  }

  provisioner "file" {
    content     = local.database_setup_sql
    destination = "/root/sa-databases.sql"
  }

  provisioner "remote-exec" {
    inline = [
      "set -eu",
      "trap 'rm -f /root/sa-databases.sql' EXIT",
      "for i in $(seq 1 60); do docker exec ${local.postgres_host} pg_isready -U postgres -d postgres >/dev/null 2>&1 && break; [ $i = 60 ] && { echo 'Postgres did not start'; exit 1; }; sleep 5; done",
      "docker exec -i ${local.postgres_host} psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres < /root/sa-databases.sql",
    ]
  }
}

# Daily pg_dump of every service database, kept on the server (Hetzner's daily server backups
# take them off the machine). Add an S3 destination in Coolify for off-site copies.
resource "coolify_database_backup" "daily" {
  database_uuid         = coolify_database_postgresql.main.uuid
  frequency             = "0 3 * * *"
  enabled               = true
  databases_to_backup   = join(",", [for db in values(local.databases) : db.database])
  retain_amount_locally = 7
  save_s3               = false

  depends_on = [terraform_data.databases]
}

# --- Source: read-only deploy key for the private GitHub repository -----------------------

resource "tls_private_key" "github_deploy" {
  algorithm = "ED25519"
}

resource "github_repository_deploy_key" "coolify" {
  repository = split("/", var.github_repository)[1]
  title      = "Coolify (${var.name}, Terraform)"
  key        = trimspace(tls_private_key.github_deploy.public_key_openssh)
  read_only  = true
}

resource "coolify_private_key" "github" {
  name        = "github-deploy-key"
  description = "Read-only deploy key for ${var.github_repository} (Terraform)"
  private_key = tls_private_key.github_deploy.private_key_openssh
}

# --- Key server, feedback server, maps server and relay server ---------------------------

locals {
  # Shared build inputs: a change in any of them redeploys every app (see watch_paths).
  workspace_paths = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "packages/shared/**"]

  apps = {
    key_server = {
      name        = "key-server"
      port        = "8787"
      hosts       = local.all_hosts.keys
      watch_paths = concat(["services/key-server/**"], local.workspace_paths)
    }
    feedback_server = {
      name        = "feedback-server"
      port        = "8788"
      hosts       = local.all_hosts.feedback
      watch_paths = concat(["services/feedback-server/**", "packages/pii/**", "packages/gateway-keys/**"], local.workspace_paths)
    }
    maps_server = {
      name        = "maps-server"
      port        = "8793"
      hosts       = local.all_hosts.maps
      watch_paths = concat(["services/maps-server/**", "packages/gateway-keys/**"], local.workspace_paths)
    }
    relay_server = {
      name        = "relay-server"
      port        = "8794"
      hosts       = local.all_hosts.relay
      watch_paths = concat(["services/relay-server/**"], local.workspace_paths)
    }
  }

  # Runtime environment of each app (sensitive: kept apart from `apps`, which feeds for_each).
  app_env = {
    key_server = merge({
      DATABASE_URL       = local.database_urls.key_server
      VOUCHER_PEPPER     = var.voucher_pepper
      ADMIN_TOKEN        = var.key_server_admin_token
      TRUST_PROXY        = "1"
      LOG_LEVEL          = "info"
      DEV_SEED           = "0"
      LITELLM_ADMIN_URL  = local.litellm_internal_url
      LITELLM_MASTER_KEY = var.litellm_master_key
      LITELLM_PUBLIC_URL = "https://${local.hosts.llm}"
      # ChatGPT users' decider keys: one per OpenAI account, stored encrypted (D12).
      KEY_ENCRYPTION_KEY = var.key_encryption_key
      # Deep research: Parallel Task API, processor and price forced by the key server (D13).
      PARALLEL_API_KEY = var.parallel_api_key
    }, var.key_server_env)
    # Sharing learnings and voting need the user's LiteLLM key, checked like the maps server does.
    feedback_server = merge({
      DATABASE_URL = local.database_urls.feedback
      ADMIN_TOKEN  = var.feedback_admin_token
      LITELLM_URL  = local.litellm_internal_url
      # One vote per user and entry: users' ids are an HMAC of their key with this secret.
      USER_ID_SECRET = var.feedback_user_id_secret
      TRUST_PROXY    = "1"
      DEV_SEED       = "0"
    }, var.feedback_server_env)
    # Mapbox address lookups for the app (no Mapbox token ships in it). Users authenticate with
    # their own LiteLLM key, checked against LiteLLM's /key/info over the internal network.
    maps_server = merge({
      MAPBOX_TOKEN = var.mapbox_secret_token
      LITELLM_URL  = local.litellm_internal_url
      DAILY_LIMIT  = "250"
      WEEKLY_LIMIT = "500"
      TRUST_PROXY  = "1"
    }, var.maps_server_env)
    # Desktop <-> phone relay for DNIe signatures: only end-to-end encrypted frames, no accounts.
    # It also serves the pairing links' landing page and the Android App Links file.
    relay_server = merge({
      TRUST_PROXY         = "1"
      ANDROID_CERT_SHA256 = var.android_cert_sha256
    }, var.relay_server_env)
  }

  # One coolify_environment_variable per (app, key). Variable names are not secret.
  app_env_entries = merge([
    for app in keys(local.apps) : {
      for key in nonsensitive(keys(local.app_env[app])) : "${app}/${key}" => { app = app, key = key }
    }
  ]...)
}

resource "coolify_application_private_git" "app" {
  for_each = local.apps

  name                   = each.value.name
  project_uuid           = coolify_project.main.uuid
  server_uuid            = local.server_uuid
  environment_name       = "production"
  git_repository         = "git@github.com:${var.github_repository}.git"
  git_branch             = var.git_branch
  private_key_uuid       = coolify_private_key.github.uuid
  build_pack             = "dockerfile"
  base_directory         = "/"
  dockerfile_location    = "/services/${each.value.name}/Dockerfile"
  ports_exposes          = each.value.port
  domains                = join(",", [for host in each.value.hosts : "https://${host}"])
  is_force_https_enabled = true
  # Push to deploy: github_repository_webhook.coolify calls Coolify, which checks the signature
  # with this secret and redeploys the app if the push touched one of its watch_paths.
  is_auto_deploy_enabled          = true
  manual_webhook_secret_github    = var.github_webhook_secret
  watch_paths                     = join("\n", each.value.watch_paths)
  inject_build_args_to_dockerfile = false # secrets stay out of image builds
  # Coolify's own health check needs curl or wget, which node:24-slim lacks; the image's
  # HEALTHCHECK (node + fetch on /health) is used instead. Coolify copies its timings into these
  # settings, so they are repeated here to keep plans clean.
  health_check_enabled      = false
  health_check_interval     = 30
  health_check_timeout      = 5
  health_check_retries      = 3
  health_check_start_period = 20
  limits_memory             = "512m"

  depends_on = [github_repository_deploy_key.coolify]
}

# GitHub -> Coolify push webhook (Coolify's endpoint for repositories cloned with a deploy key).
# One hook serves both apps: Coolify matches repository and branch, then checks each app's secret.
resource "github_repository_webhook" "coolify" {
  repository = split("/", var.github_repository)[1]
  events     = ["push"]
  active     = true

  configuration {
    url          = "${local.coolify_url}/webhooks/source/github/events/manual"
    content_type = "json"
    secret       = var.github_webhook_secret
    insecure_ssl = false
  }

  depends_on = [coolify_application_private_git.app]
}

resource "coolify_environment_variable" "app" {
  for_each = local.app_env_entries

  application_uuid = coolify_application_private_git.app[each.value.app].uuid
  key              = each.value.key
  value            = local.app_env[each.value.app][each.value.key]
  is_build         = false
  is_runtime       = true
  is_literal       = true
}

resource "coolify_deployment" "app" {
  for_each = local.apps

  application_uuid    = coolify_application_private_git.app[each.key].uuid
  wait_for_completion = true
  triggers = {
    revision = var.deploy_revision
    branch   = var.git_branch
    env      = sha256(jsonencode(local.app_env[each.key]))
  }
  timeouts = {
    create = "30m"
  }

  depends_on = [coolify_environment_variable.app, terraform_data.databases, coolify_resource_action.litellm]
}
