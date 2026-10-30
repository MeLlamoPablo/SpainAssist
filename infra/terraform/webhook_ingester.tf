# The webhook ingester (services/webhook-ingester): the only public way into Coolify, whose
# dashboard and API answer on loopback only (bootstrap.tf). GitHub's push webhook reaches it at
# https://hooks.<domain>/github; it checks GitHub's signature and forwards a rebuilt, re-signed
# copy to Coolify over the `coolify` Docker network, so no byte of a request reaches Coolify's
# PHP unless GitHub signed it, and then only the fields Coolify deploys from.
#
# A plain container next to Coolify rather than a Coolify app: it must not depend on Coolify to
# run, and it deploys from this checkout (no push needed). It runs on node:24.22.1-slim (pinned
# by digest in its compose template) with Node's built-in TypeScript support and no
# dependencies; Coolify's proxy routes the host to it through Docker labels. Changing its source,
# image or settings re-uploads and restarts it.

locals {
  github_webhook_url = "https://${local.hosts.hooks}/github"

  webhook_ingester_dir = "/data/sa/webhook-ingester"
  webhook_ingester_src = "${path.module}/../../services/webhook-ingester/src"
  webhook_ingester_files = {
    "compose.yaml"    = templatefile("${path.module}/templates/webhook-ingester.compose.yaml.tftpl", { host = local.hosts.hooks })
    "package.json"    = jsonencode({ type = "module" })
    "src/main.ts"     = file("${local.webhook_ingester_src}/main.ts")
    "src/ingester.ts" = file("${local.webhook_ingester_src}/ingester.ts")
  }
  webhook_ingester_env = join("\n", [
    "GITHUB_WEBHOOK_SECRET=${var.github_webhook_secret}",
    "GITHUB_REPOSITORY=${var.github_repository}",
    "",
  ])
}

resource "terraform_data" "webhook_ingester" {
  triggers_replace = [
    hcloud_server.main.id,
    sha256(join("\n", concat(values(local.webhook_ingester_files), [local.webhook_ingester_env]))),
  ]

  connection {
    type        = "ssh"
    host        = local.ipv4
    user        = "root"
    private_key = var.ssh_private_key
  }

  provisioner "remote-exec" {
    inline = ["mkdir -p ${local.webhook_ingester_dir}/src"]
  }

  provisioner "file" {
    content     = local.webhook_ingester_files["compose.yaml"]
    destination = "${local.webhook_ingester_dir}/compose.yaml"
  }

  provisioner "file" {
    content     = local.webhook_ingester_files["package.json"]
    destination = "${local.webhook_ingester_dir}/package.json"
  }

  provisioner "file" {
    content     = local.webhook_ingester_files["src/main.ts"]
    destination = "${local.webhook_ingester_dir}/src/main.ts"
  }

  provisioner "file" {
    content     = local.webhook_ingester_files["src/ingester.ts"]
    destination = "${local.webhook_ingester_dir}/src/ingester.ts"
  }

  provisioner "file" {
    content     = local.webhook_ingester_env
    destination = "${local.webhook_ingester_dir}/.env"
  }

  provisioner "remote-exec" {
    inline = [
      "set -eu",
      "chmod 600 ${local.webhook_ingester_dir}/.env",
      # The source is bind-mounted, so a change to it alone wouldn't recreate the container.
      "docker compose --project-directory ${local.webhook_ingester_dir} up -d --force-recreate --wait --wait-timeout 120",
    ]
  }

  depends_on = [terraform_data.coolify]
}
