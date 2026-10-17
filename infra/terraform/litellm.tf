# LiteLLM proxy: the only holder of the OpenRouter and Parallel keys. The key server
# issues capped virtual keys through its admin API (one budget covers chat and search), and
# the app calls https://llm.<domain>/v1 with them. See docs/research/litellm-gateway.md.
#
# Our server now sees every prompt that goes through it, so LiteLLM must not store or log
# messages: no prompts in spend logs, message logging off, log level ERROR.

locals {
  litellm_config = {
    # Every OpenRouter model, under its OpenRouter name ("openai/gpt-6-luna" calls
    # "openrouter/openai/gpt-6-luna"). LiteLLM asks OpenRouter for the cost of each call and
    # charges the key with it, streamed or not, so models missing from LiteLLM's price list
    # are charged too. /v1/models lists LiteLLM's own stale catalogue under "openrouter/"
    # names, so the app uses pi's OpenRouter catalogue instead.
    model_list = [{
      model_name = "*"
      litellm_params = {
        model   = "openrouter/*"
        api_key = "os.environ/OPENROUTER_API_KEY"
      }
    }]

    # POST /v1/search/<search_tool_name>, charged to the calling key ($0.005 per search).
    search_tools = nonsensitive(var.parallel_api_key != "") ? [{
      search_tool_name = "parallel"
      litellm_params   = { search_provider = "parallel_ai", api_key = "os.environ/PARALLEL_API_KEY" }
    }] : []

    litellm_settings = {
      # templates/litellm_sa_pricing.py: registers OpenRouter's prices (and Perplexity Decider's) so
      # spend is charged to keys, and rejects chat calls to models without a price.
      callbacks                = ["sa_pricing.handler"]
      drop_params              = true
      turn_off_message_logging = true
      json_logs                = true
      request_timeout          = 600
      num_retries              = 1
    }

    general_settings = {
      master_key                  = "os.environ/LITELLM_MASTER_KEY"
      database_url                = "os.environ/DATABASE_URL"
      store_prompts_in_spend_logs = false
      # Spend is written to Postgres in batches; budgets are enforced from memory meanwhile
      # (one worker, so that memory is the whole truth).
      proxy_batch_write_at = 10
      # Before each call LiteLLM reserves its worst case (input tokens + max output tokens at
      # the model's price). Reject the call when that does not fit the remaining budget,
      # instead of sending it anyway (the default), so one expensive call cannot overspend.
      fail_closed_budget_enforcement = true
    }
  }

  # LiteLLM reads its config from a file. Coolify's `content:` volumes only seed a file once
  # (later changes are ignored, and Coolify strips them from the stored compose), so the config
  # travels base64-encoded in the environment and the entrypoint writes it before starting.
  litellm_start = join("; ", [
    "import base64, os",
    "os.makedirs('/tmp/litellm', exist_ok=True)",
    "open('/tmp/litellm/config.yaml', 'wb').write(base64.b64decode(os.environ['LITELLM_CONFIG_B64']))",
    "open('/tmp/litellm/sa_pricing.py', 'wb').write(base64.b64decode(os.environ['LITELLM_PRICING_B64']))",
    "os.execv('docker/prod_entrypoint.sh', ['docker/prod_entrypoint.sh', '--config', '/tmp/litellm/config.yaml', '--port', '4000', '--num_workers', '1'])",
  ])

  litellm_compose = {
    services = {
      litellm = {
        image      = var.litellm_image
        entrypoint = ["python", "-c", local.litellm_start]
        # Coolify's own network, where Postgres and both services run (see `networks` below).
        networks = ["coolify"]
        environment = {
          # Not secret: the config only names the variables that hold the keys.
          LITELLM_CONFIG_B64 = base64encode(yamlencode(local.litellm_config))
          # Callback module next to the config: OpenRouter's prices, refreshed every 6 hours.
          LITELLM_PRICING_B64 = filebase64("${path.module}/templates/litellm_sa_pricing.py")
          # Values come from coolify_envs_bulk.litellm (Coolify service variables), so they are
          # not visible in the compose file.
          LITELLM_MASTER_KEY = "$${LITELLM_MASTER_KEY}"
          LITELLM_SALT_KEY   = "$${LITELLM_SALT_KEY}"
          DATABASE_URL       = "$${DATABASE_URL}"
          UI_USERNAME        = "admin"
          UI_PASSWORD        = "$${UI_PASSWORD}"
          OPENROUTER_API_KEY = "$${OPENROUTER_API_KEY}"
          PARALLEL_API_KEY   = "$${PARALLEL_API_KEY}"
          PROXY_BASE_URL     = "https://${local.hosts.llm}"
          LITELLM_MODE       = "PRODUCTION"
          LITELLM_LOG        = "ERROR"
          STORE_MODEL_IN_DB  = "False"
        }
        healthcheck = {
          test         = ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4000/health/liveliness', timeout=5)"]
          interval     = "30s"
          timeout      = "5s"
          retries      = 5
          start_period = "60s"
        }
      }
    }
    # Joining the destination network explicitly does what the service setting
    # connect_to_docker_network does, which Coolify 4.3.23 refuses on POST /services.
    networks = {
      coolify = { external = true }
    }
  }

  litellm_env = {
    LITELLM_MASTER_KEY = var.litellm_master_key
    LITELLM_SALT_KEY   = var.litellm_salt_key
    DATABASE_URL       = local.database_urls.litellm
    UI_PASSWORD        = var.litellm_ui_password
    OPENROUTER_API_KEY = var.openrouter_api_key
    PARALLEL_API_KEY   = var.parallel_api_key
  }

  # Compose containers are named <service>-<uuid>; on the `coolify` network the key server
  # reaches the admin API by that name instead of through the public URL.
  litellm_internal_url = "http://litellm-${coolify_service.litellm.uuid}:4000"
}

resource "coolify_service" "litellm" {
  name               = "litellm"
  description        = "LiteLLM proxy (capped keys for OpenRouter, Parallel)"
  project_uuid       = coolify_project.main.uuid
  server_uuid        = local.server_uuid
  environment_name   = "production"
  docker_compose_raw = yamlencode(local.litellm_compose)
  instant_deploy     = false

  urls = [{
    name = "litellm"
    # The port is the container port Coolify's proxy forwards to; the public URL is plain 443.
    url = join(",", [for host in local.all_hosts.llm : "https://${host}:4000"])
  }]
}

resource "coolify_envs_bulk" "litellm" {
  resource_type = "service"
  resource_uuid = coolify_service.litellm.uuid
  variables     = local.litellm_env
}

# (Re)starts LiteLLM after its compose file or variables change.
resource "coolify_resource_action" "litellm" {
  resource_uuid = coolify_service.litellm.uuid
  resource_type = "service"
  action        = "restart"
  triggers = {
    compose = sha256(yamlencode(local.litellm_compose))
    env     = sha256(jsonencode(local.litellm_env))
  }

  depends_on = [coolify_envs_bulk.litellm, terraform_data.databases]
}
