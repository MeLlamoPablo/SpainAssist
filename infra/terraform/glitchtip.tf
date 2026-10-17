# GlitchTip: the desktop app's crash and error reports, at https://errors.<domain>. GlitchTip
# speaks Sentry's protocol, so the app uses the official Sentry SDK (@sentry/electron) with a
# GlitchTip DSN. Self-hosted Sentry needs ~16 GB of memory; GlitchTip all-in-one (web server
# and worker in one process, its queue in Postgres instead of Valkey) runs in ~300 MB.
# Its database lives in the shared Postgres (daily backups).

locals {
  glitchtip_compose = {
    services = {
      glitchtip = {
        image = var.glitchtip_image
        # Coolify's own network, where Postgres runs (see `networks` below).
        networks = ["coolify"]
        environment = {
          # Values come from coolify_envs_bulk.glitchtip, so they are not visible in the compose file.
          DATABASE_URL     = "$${DATABASE_URL}"
          SECRET_KEY       = "$${SECRET_KEY}"
          GLITCHTIP_DOMAIN = "https://${local.hosts.errors}"
          # Web server and worker in one process; the task queue in Postgres (no Valkey).
          GLITCHTIP_EMBED_WORKER = "true"
          VALKEY_URL             = ""
          # No mail server: invitations and alerts are not sent (only the admin logs in).
          EMAIL_URL          = "consolemail://"
          DEFAULT_FROM_EMAIL = "errors@${var.domain}"
          # Nobody but the admin (terraform_data.glitchtip_admin) has an account.
          ENABLE_USER_REGISTRATION     = "false"
          ENABLE_ORGANIZATION_CREATION = "false"
          # Error events only: no uptime checks, logs or MCP server.
          GLITCHTIP_ENABLE_UPTIME  = "false"
          GLITCHTIP_ENABLE_LOGS    = "false"
          GLITCHTIP_RETENTION_DAYS = "90"
          DATABASE_POOL_MAX_SIZE   = "5"
          VTASKS_CONCURRENCY       = "5"
          LOG_LEVEL                = "WARNING"
        }
        # Uploaded files (source maps, debug files).
        volumes   = ["glitchtip-uploads:/code/uploads"]
        mem_limit = "768m"
        healthcheck = {
          test         = ["CMD-SHELL", "python -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/_health/')\" || exit 1"]
          interval     = "30s"
          timeout      = "5s"
          retries      = 5
          start_period = "60s"
        }
      }
    }
    # Same reason as LiteLLM: Coolify 4.3.23 refuses connect_to_docker_network on POST /services.
    networks = {
      coolify = { external = true }
    }
  }

  glitchtip_env = {
    DATABASE_URL = local.database_urls.glitchtip
    SECRET_KEY   = var.glitchtip_secret_key
  }

  glitchtip_admin_email = "admin@${var.domain}"
}

resource "coolify_service" "glitchtip" {
  name               = "glitchtip"
  description        = "GlitchTip error reports (Sentry protocol)"
  project_uuid       = coolify_project.main.uuid
  server_uuid        = local.server_uuid
  environment_name   = "production"
  docker_compose_raw = yamlencode(local.glitchtip_compose)
  instant_deploy     = false

  urls = [{
    name = "glitchtip"
    url  = "https://${local.hosts.errors}:8000"
  }]
}

resource "coolify_envs_bulk" "glitchtip" {
  resource_type = "service"
  resource_uuid = coolify_service.glitchtip.uuid
  variables     = local.glitchtip_env
}

# (Re)starts GlitchTip after its compose file or variables change. It migrates its database
# on start.
resource "coolify_resource_action" "glitchtip" {
  resource_uuid = coolify_service.glitchtip.uuid
  resource_type = "service"
  action        = "restart"
  triggers = {
    compose = sha256(yamlencode(local.glitchtip_compose))
    env     = sha256(jsonencode(local.glitchtip_env))
  }

  depends_on = [coolify_envs_bulk.glitchtip, terraform_data.databases]
}

# GlitchTip's only user, a superuser: admin@<domain> with var.glitchtip_admin_password.
# Created (or its password reset) over SSH, since GlitchTip has no API for it. The organization
# and the desktop project are created once in its UI (README.md, "Error reports").
resource "terraform_data" "glitchtip_admin" {
  triggers_replace = [coolify_service.glitchtip.uuid, sha256(var.glitchtip_admin_password)]

  connection {
    type        = "ssh"
    host        = local.ipv4
    user        = "root"
    private_key = var.ssh_private_key
  }

  provisioner "file" {
    content     = var.glitchtip_admin_password
    destination = "/root/sa-glitchtip-password"
  }

  provisioner "remote-exec" {
    inline = [
      "set -eu",
      "trap 'rm -f /root/sa-glitchtip-password' EXIT",
      "c=glitchtip-${coolify_service.glitchtip.uuid}",
      "for i in $(seq 1 60); do [ \"$(docker inspect -f '{{.State.Health.Status}}' $c 2>/dev/null)\" = healthy ] && break; [ $i = 60 ] && { echo 'GlitchTip did not start'; exit 1; }; sleep 5; done",
      "docker exec -i -e SA_EMAIL=${local.glitchtip_admin_email} $c ./manage.py shell -c \"import os, sys; from django.contrib.auth import get_user_model; U = get_user_model(); e = os.environ['SA_EMAIL']; u = U.objects.filter(email=e).first() or U.objects.create_superuser(email=e, password=None); u.is_staff = u.is_superuser = True; u.set_password(sys.stdin.read().strip()); u.save()\" < /root/sa-glitchtip-password",
    ]
  }

  depends_on = [coolify_resource_action.glitchtip]
}
