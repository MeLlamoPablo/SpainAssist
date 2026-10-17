# Installs Coolify on the server and prepares it for the Coolify provider: root user, API
# token, API access and the dashboard domain. Runs over SSH so that no secret goes through
# cloud-init, and runs again (idempotently) whenever an input changes, e.g. coolify_version
# (upgrade), the domain or a rotated password/token.
#
# The first apply must stop here: `./tf.sh bootstrap` (= apply -target=terraform_data.coolify),
# because the Coolify provider needs a running Coolify to plan anything else.

locals {
  coolify_url = "https://${local.hosts.coolify}"

  bootstrap_env = join("\n", [for k, v in {
    COOLIFY_VERSION  = var.coolify_version
    SA_COOLIFY_URL   = local.coolify_url
    SA_ROOT_EMAIL    = var.coolify_root_email != "" ? var.coolify_root_email : "admin@${var.domain}"
    SA_ROOT_PASSWORD = var.coolify_root_password
    SA_API_TOKEN     = var.coolify_api_token
  } : "${k}='${v}'"])

  bootstrap_files = {
    script = file("${path.module}/templates/coolify-bootstrap.sh")
    php    = file("${path.module}/templates/coolify-bootstrap.php")
  }
}

resource "terraform_data" "coolify" {
  triggers_replace = [
    hcloud_server.main.id,
    sha256(join("\n", [local.bootstrap_env, local.bootstrap_files.script, local.bootstrap_files.php])),
  ]

  connection {
    type        = "ssh"
    host        = local.ipv4
    user        = "root"
    private_key = var.ssh_private_key
    timeout     = "5m"
  }

  provisioner "file" {
    content     = local.bootstrap_env
    destination = "/root/sa-bootstrap.env"
  }

  provisioner "file" {
    content     = local.bootstrap_files.php
    destination = "/root/sa-bootstrap.php"
  }

  provisioner "file" {
    content     = local.bootstrap_files.script
    destination = "/root/coolify-bootstrap.sh"
  }

  provisioner "remote-exec" {
    inline = [
      "chmod 600 /root/sa-bootstrap.env /root/sa-bootstrap.php",
      "bash /root/coolify-bootstrap.sh",
    ]
  }
}
