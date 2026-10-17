terraform {
  # The Coolify provider needs Terraform 1.6+.
  required_version = ">= 1.6.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.70"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.4"
    }
    github = {
      source  = "integrations/github"
      version = "~> 6.13"
    }
    coolify = {
      source  = "coolify-terraform/coolify"
      version = "~> 0.1.25"
    }
    unleash = {
      source  = "Unleash/unleash"
      version = "~> 3.4"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

# Authenticates with GITHUB_TOKEN or, when unset, with the GitHub CLI's login (`gh auth token`).
# Only used for the read-only deploy key Coolify clones the repository with.
provider "github" {
  owner = split("/", var.github_repository)[0]
}

# Coolify's API is reached through an SSH tunnel that ./tf.sh opens to the server, so the
# dashboard port never has to be public and the endpoint is known before the server exists.
# The provider checks the Coolify version when it starts: the first apply must be
# `./tf.sh bootstrap` (server + Coolify only), see README.md.
provider "coolify" {
  endpoint  = "http://127.0.0.1:${var.coolify_tunnel_port}"
  token     = var.coolify_api_token
  retry_max = 5
}

# Unleash's admin API, with the admin token Unleash seeds on its first start (unleash.tf). It
# goes through the server's sslip.io name, which works without DNS and keeps its certificate when
# var.domain changes: on https://flags.<domain>, the plan of that change would fail before the
# apply gets the new host its certificate.
provider "unleash" {
  base_url      = "https://${local.legacy_hosts.flags}"
  authorization = var.unleash_admin_token
}

# Route 53 and Route 53 Domains (dns.tf), as the IAM user in aws_iam.tf. Both services are
# global and served from us-east-1. Without a key in terraform.tfvars the provider falls back to
# the usual AWS environment variables (the first apply, which creates that user, needs an admin).
provider "aws" {
  region     = "us-east-1"
  access_key = var.aws_access_key_id
  secret_key = var.aws_secret_access_key
}
