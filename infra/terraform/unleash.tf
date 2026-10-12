# Unleash: feature flags for Spain Assistant, at https://flags.<domain>. Based on Coolify's
# "Unleash With PostgreSQL" template, but its database lives in the shared Postgres (daily
# backups) and only our own admin token is seeded: the template seeds publicly known
# "insecure" ones. Terraform creates the other tokens with that admin token.

locals {
  unleash_compose = {
    services = {
      unleash = {
        image = var.unleash_image
        # Coolify's own network, where Postgres runs (see `networks` below).
        networks = ["coolify"]
        environment = {
          # Values come from coolify_envs_bulk.unleash, so they are not visible in the compose file.
          DATABASE_URL = "$${DATABASE_URL}"
          DATABASE_SSL = "false"
          UNLEASH_URL  = "https://${local.hosts.flags}"
          # Only used to create the admin user on the first start; later changes need the UI.
          UNLEASH_DEFAULT_ADMIN_USERNAME = "admin"
          UNLEASH_DEFAULT_ADMIN_PASSWORD = "$${UNLEASH_DEFAULT_ADMIN_PASSWORD}"
          LOG_LEVEL                      = "warn"
          # Seeded only while Unleash has no API tokens at all (its first start), so rotating
          # it means creating a new admin token in the UI and updating unleash_admin_token.
          INIT_ADMIN_API_TOKENS = "$${INIT_ADMIN_API_TOKENS}"
        }
        healthcheck = {
          test         = ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://127.0.0.1:4242/health || exit 1"]
          interval     = "30s"
          timeout      = "5s"
          retries      = 5
          start_period = "30s"
        }
      }
    }
    # Same reason as LiteLLM: Coolify 4.3.23 refuses connect_to_docker_network on POST /services.
    networks = {
      coolify = { external = true }
    }
  }

  unleash_env = {
    DATABASE_URL                   = local.database_urls.unleash
    UNLEASH_DEFAULT_ADMIN_PASSWORD = var.unleash_admin_password
    INIT_ADMIN_API_TOKENS          = var.unleash_admin_token
  }
}

resource "coolify_service" "unleash" {
  name               = "unleash"
  description        = "Unleash feature flags"
  project_uuid       = coolify_project.main.uuid
  server_uuid        = local.server_uuid
  environment_name   = "production"
  docker_compose_raw = yamlencode(local.unleash_compose)
  instant_deploy     = false

  urls = [{
    name = "unleash"
    url  = "https://${local.hosts.flags}:4242"
  }]
}

resource "coolify_envs_bulk" "unleash" {
  resource_type = "service"
  resource_uuid = coolify_service.unleash.uuid
  variables     = local.unleash_env
}

# (Re)starts Unleash after its compose file or variables change.
resource "coolify_resource_action" "unleash" {
  resource_uuid = coolify_service.unleash.uuid
  resource_type = "service"
  action        = "restart"
  triggers = {
    compose = sha256(yamlencode(local.unleash_compose))
    env     = sha256(jsonencode(local.unleash_env))
  }

  depends_on = [coolify_envs_bulk.unleash, terraform_data.databases]
}

# Frontend tokens built into the desktop app (PRODUCTION_SERVICES.flagsTokens in
# packages/shared): packaged builds read the production environment, development builds the
# development one. Frontend tokens are public by design: they only read enabled flags of one
# environment through /api/frontend. After replacing one, copy it from
# `./tf.sh output -json unleash_frontend_tokens` there.
resource "unleash_api_token" "desktop" {
  token_name  = "desktop"
  type        = "frontend"
  environment = "production"
  projects    = ["default"]

  depends_on = [coolify_resource_action.unleash]
}

# Created in Unleash's UI, hence its name; the provider can't import API tokens, so it was
# added to the state by hand and refreshed (it reads tokens back by their secret).
resource "unleash_api_token" "desktop_development" {
  token_name  = "api-key-default-development"
  type        = "frontend"
  environment = "development"
  projects    = ["default"]

  depends_on = [coolify_resource_action.unleash]
}

# The desktop app's version, sent with every flags request (`properties[appVersion]`, D19), so
# flags such as must-update can be constrained by version (SEMVER_LT).
resource "unleash_context_field" "app_version" {
  name        = "appVersion"
  description = "Spain Assist desktop version (semver)"
  stickiness  = false

  depends_on = [coolify_resource_action.unleash]
}
