# Everything secret lives in terraform.tfvars (see terraform.tfvars.example). Secrets also end
# up in terraform.tfstate: both files must only ever be committed encrypted (git-crypt).

# --- Hetzner Cloud -------------------------------------------------------------------------

variable "hcloud_token" {
  description = "Hetzner Cloud API token (read & write) of the project that holds the server."
  type        = string
  sensitive   = true
}

variable "name" {
  description = "Name prefix for every Hetzner resource."
  type        = string
  default     = "spainassistant"
}

variable "location" {
  description = "Hetzner location (EU: nbg1, fsn1, hel1)."
  type        = string
  default     = "nbg1"
}

variable "server_type" {
  description = "Hetzner server type. cx23 (2 vCPU, 4 GB, 40 GB) is the cheapest x86 type with enough memory for Coolify, LiteLLM, Postgres and both services."
  type        = string
  default     = "cx23"
}

variable "image" {
  description = "OS image. Changing it later does not rebuild the server."
  type        = string
  default     = "ubuntu-26.04"
}

variable "enable_backups" {
  description = "Hetzner daily server backups (+20% of the server price). They hold Postgres: vouchers and LiteLLM keys."
  type        = bool
  default     = true
}

variable "protect" {
  description = "Delete/rebuild protection for the server and its IPs. Set to false (and apply) before destroying them."
  type        = bool
  default     = true
}

variable "ssh_private_key" {
  description = "OpenSSH private key (ed25519) for root on the server. Terraform derives the public key, bootstraps Coolify with it and ./tf.sh tunnels to the Coolify API with it."
  type        = string
  sensitive   = true
}

variable "ssh_extra_public_keys" {
  description = "More public keys allowed to log in as root (e.g. your laptop's)."
  type        = list(string)
  default     = []
}

variable "ssh_allowed_cidrs" {
  description = "Networks allowed to reach SSH (Terraform and the Coolify tunnel use SSH too)."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

# --- Domains -------------------------------------------------------------------------------

variable "domain" {
  description = "Base domain the services are served on, e.g. var.dns_domain once its records resolve. Empty = <ipv4-with-dashes>.sslip.io, which resolves to the server without any DNS setup."
  type        = string
  default     = ""
}

variable "dns_domain" {
  description = "Domain registered with Route 53 Domains whose hosted zone holds the service records (dns.tf)."
  type        = string
  default     = "spainassist.es"
}

# --- AWS -----------------------------------------------------------------------------------

variable "aws_access_key_id" {
  description = "Access key of the Terraform IAM user (aws_iam.tf). Null = the AWS environment variables."
  type        = string
  default     = null
}

variable "aws_secret_access_key" {
  description = "Secret of aws_access_key_id."
  type        = string
  default     = null
  sensitive   = true
}

# --- Coolify -------------------------------------------------------------------------------

variable "coolify_version" {
  description = "Coolify version installed by the bootstrap (auto-update is off). Bumping it and applying upgrades Coolify."
  type        = string
  default     = "4.3.23"
}

variable "coolify_root_email" {
  description = "Login e-mail of Coolify's root user. Empty = admin@<base domain>."
  type        = string
  default     = ""
}

variable "coolify_root_password" {
  description = "Password of Coolify's root user (dashboard login). Re-applied by every bootstrap run."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.coolify_root_password) >= 16 && can(regex("[a-z]", var.coolify_root_password)) && can(regex("[A-Z]", var.coolify_root_password)) && can(regex("[0-9]", var.coolify_root_password)) && can(regex("^[A-Za-z0-9_.-]+$", var.coolify_root_password))
    error_message = "coolify_root_password must be at least 16 characters of [A-Za-z0-9_.-] with lower case, upper case and digits."
  }
}

variable "coolify_api_token" {
  description = "Coolify API token (root ability) for this Terraform config. The bootstrap stores its hash in Coolify; changing it and re-running the bootstrap rotates it."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z0-9]{40,}$", var.coolify_api_token))
    error_message = "coolify_api_token must be at least 40 letters and digits."
  }
}

variable "coolify_tunnel_port" {
  description = "Local port of the SSH tunnel to Coolify's API that ./tf.sh opens."
  type        = number
  default     = 18000
}

# --- Application source --------------------------------------------------------------------

variable "github_repository" {
  description = "GitHub repository (owner/name) Coolify builds the key server and the feedback server from."
  type        = string
  default     = "MeLlamoPablo/SpainAssist"
}

variable "git_branch" {
  description = "Branch Coolify deploys; a push to it redeploys the services whose files changed (GitHub webhook)."
  type        = string
  default     = "master"
}

variable "github_webhook_secret" {
  description = "Secret GitHub signs push webhooks with; Coolify checks it before deploying."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z0-9]{32,}$", var.github_webhook_secret))
    error_message = "github_webhook_secret must be at least 32 letters and digits."
  }
}

variable "deploy_revision" {
  description = "Any string. Changing it makes the next apply redeploy both services from the branch head, without a push (pushes deploy through the webhook)."
  type        = string
  default     = "1"
}

# --- Postgres (one container, one database and one role per service) ----------------------

variable "postgres_password" {
  description = "Password of the postgres superuser."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{24,}$", var.postgres_password))
    error_message = "postgres_password must be at least 24 characters of [A-Za-z0-9_-]."
  }
}

variable "service_db_passwords" {
  description = "Passwords of the per-service database roles: key_server, feedback, litellm and unleash (URL-safe)."
  type = object({
    key_server = string
    feedback   = string
    litellm    = string
    unleash    = string
  })
  sensitive = true

  validation {
    condition     = alltrue([for p in values(var.service_db_passwords) : can(regex("^[A-Za-z0-9_-]{24,}$", p))])
    error_message = "Every service database password must be at least 24 characters of [A-Za-z0-9_-]."
  }
}

# --- Key server ----------------------------------------------------------------------------

variable "voucher_pepper" {
  description = "Key server VOUCHER_PEPPER (HMAC key for voucher codes). Never change it once vouchers exist."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{32,}$", var.voucher_pepper))
    error_message = "voucher_pepper must be at least 32 characters of [A-Za-z0-9_-]."
  }
}

variable "key_server_admin_token" {
  description = "Key server ADMIN_TOKEN (creates and revokes vouchers over HTTP). Empty disables the admin API."
  type        = string
  sensitive   = true
  default     = ""
}

variable "key_encryption_key" {
  description = "Key server KEY_ENCRYPTION_KEY: 32 bytes as 64 hex characters (openssl rand -hex 32). Encrypts the stored ChatGPT-account LiteLLM keys; never change it once such keys exist."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.key_encryption_key))
    error_message = "key_encryption_key must be 64 lowercase hex characters."
  }
}

variable "key_server_env" {
  description = "Extra key server environment variables (non-secret settings such as KEY_TTL_DAYS), merged over the defaults in coolify.tf."
  type        = map(string)
  default     = {}
}

# --- Feedback server -----------------------------------------------------------------------

variable "feedback_admin_token" {
  description = "Feedback server ADMIN_TOKEN. Empty disables its admin API."
  type        = string
  sensitive   = true
  default     = ""
}

variable "feedback_user_id_secret" {
  description = "Feedback server USER_ID_SECRET: HMAC key for users' ids (one vote per user and entry). openssl rand -hex 32; never change it once votes exist."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{32,}$", var.feedback_user_id_secret))
    error_message = "feedback_user_id_secret must be at least 32 characters of [A-Za-z0-9_-]."
  }
}

variable "feedback_server_env" {
  description = "Extra feedback server environment variables, merged over the defaults in coolify.tf."
  type        = map(string)
  default     = {}
}

# --- Maps server ---------------------------------------------------------------------------

variable "mapbox_secret_token" {
  description = "Mapbox secret token (sk.…) used only by the maps server for address lookups. Create one in the Mapbox account with no extra scopes; geocoding needs none."
  type        = string
  sensitive   = true

  validation {
    condition     = startswith(var.mapbox_secret_token, "sk.")
    error_message = "mapbox_secret_token must be a Mapbox secret token (sk.…)."
  }
}

variable "maps_server_env" {
  description = "Extra maps server environment variables (e.g. DAILY_LIMIT), merged over the defaults in coolify.tf."
  type        = map(string)
  default     = {}
}

# --- Relay server --------------------------------------------------------------------------

variable "android_cert_sha256" {
  description = "SHA-256 fingerprints (AB:CD:..., comma-separated) of the Android app's signing certificates (Play App Signing and upload key), for App Links on the relay host. Empty: no assetlinks.json; pairing links then open through the landing page."
  type        = string
  default     = ""
}

variable "relay_server_env" {
  description = "Extra relay server environment variables (e.g. ROOMS_PER_ADDRESS), merged over the defaults in coolify.tf."
  type        = map(string)
  default     = {}
}

# --- LiteLLM -------------------------------------------------------------------------------

variable "litellm_image" {
  description = "LiteLLM proxy image (the -database flavour bundles Prisma for Postgres)."
  type        = string
  default     = "ghcr.io/berriai/litellm-database:v1.104.0"
}

variable "litellm_master_key" {
  description = "LiteLLM master key (admin API). The key server uses it to issue capped virtual keys. Must start with sk-."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^sk-[A-Za-z0-9_-]{32,}$", var.litellm_master_key))
    error_message = "litellm_master_key must look like sk- followed by at least 32 characters of [A-Za-z0-9_-]."
  }
}

variable "litellm_salt_key" {
  description = "LITELLM_SALT_KEY: encrypts provider credentials stored in LiteLLM's database. Never change it once set."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.litellm_salt_key) >= 32
    error_message = "litellm_salt_key must be at least 32 characters."
  }
}

variable "litellm_ui_password" {
  description = "Password of LiteLLM's admin UI (user admin) at https://llm.<domain>/ui."
  type        = string
  sensitive   = true
}

variable "openrouter_api_key" {
  description = "OpenRouter API key LiteLLM forwards chat calls with. Empty = chat calls fail upstream."
  type        = string
  sensitive   = true
  default     = ""
}

variable "parallel_api_key" {
  description = "Parallel API key: LiteLLM's 'parallel' search tool and the key server's deep research (pro). Empty = neither."
  type        = string
  sensitive   = true
  default     = ""
}

# --- Unleash -------------------------------------------------------------------------------

variable "unleash_image" {
  description = "Unleash server image."
  type        = string
  default     = "unleashorg/unleash-server:8.2.0"
}

variable "unleash_admin_password" {
  description = "Password of Unleash's admin user at https://flags.<domain>. Only applied on Unleash's first start."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.unleash_admin_password) >= 16
    error_message = "unleash_admin_password must be at least 16 characters."
  }
}

variable "unleash_admin_token" {
  description = "Unleash admin API token Terraform manages Unleash with, as *:*.<secret>. Seeded only on Unleash's first start."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^\\*:\\*\\.[A-Za-z0-9]{32,}$", var.unleash_admin_token))
    error_message = "unleash_admin_token must look like *:*. followed by at least 32 letters and digits."
  }
}
