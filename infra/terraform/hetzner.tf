# One Hetzner Cloud VM with reserved IPs. cloud-init installs Coolify on first boot; Coolify
# then runs everything else (coolify.tf, litellm.tf, unleash.tf, glitchtip.tf). Secrets never go into cloud-init: the
# server's metadata service is readable from every container on it. bootstrap.tf delivers
# them over SSH instead.

locals {
  everywhere = ["0.0.0.0/0", "::/0"]

  ipv4 = hcloud_primary_ip.ipv4.ip_address
  # One host per service, <subdomain>.<domain>; dns.tf has their records.
  subdomains = ["coolify", "keys", "feedback", "maps", "relay", "llm", "flags", "errors"]
  hosts      = { for name in local.subdomains : name => "${name}.${var.domain}" }
  # Released desktop apps call these hosts on the server's sslip.io name, which resolves to the
  # IPv4 without any DNS: they keep answering there too. Never release the reserved IPv4 (the
  # names are the IP). The relay and Coolify's dashboard only had users of our own.
  legacy_domain = "${replace(local.ipv4, ".", "-")}.sslip.io"
  legacy_hosts  = { for name in ["keys", "feedback", "maps", "llm", "flags"] : name => "${name}.${local.legacy_domain}" }
  # Every host a service answers on.
  all_hosts = { for name in local.subdomains : name => compact([local.hosts[name], lookup(local.legacy_hosts, name, "")]) }
}

data "tls_public_key" "admin" {
  private_key_openssh = var.ssh_private_key
}

resource "hcloud_ssh_key" "admin" {
  name       = "${var.name}-admin"
  public_key = data.tls_public_key.admin.public_key_openssh
}

resource "hcloud_ssh_key" "extra" {
  for_each   = toset(var.ssh_extra_public_keys)
  name       = "${var.name}-extra-${substr(sha256(each.value), 0, 8)}"
  public_key = each.value
}

resource "hcloud_primary_ip" "ipv4" {
  name              = "${var.name}-ipv4"
  type              = "ipv4"
  location          = var.location
  auto_delete       = false
  delete_protection = var.protect
}

resource "hcloud_primary_ip" "ipv6" {
  name              = "${var.name}-ipv6"
  type              = "ipv6"
  location          = var.location
  auto_delete       = false
  delete_protection = var.protect
}

resource "hcloud_firewall" "server" {
  name = var.name

  rule {
    description = "SSH (admin, Terraform bootstrap, Coolify API tunnel)"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.ssh_allowed_cidrs
  }

  rule {
    description = "HTTP (ACME challenges, redirect to HTTPS)"
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = local.everywhere
  }

  rule {
    description = "HTTPS"
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = local.everywhere
  }

  rule {
    description = "HTTP/3"
    direction   = "in"
    protocol    = "udp"
    port        = "443"
    source_ips  = local.everywhere
  }

  rule {
    description = "Ping"
    direction   = "in"
    protocol    = "icmp"
    source_ips  = local.everywhere
  }

  # Not opened on purpose: Coolify's dashboard (8000) and realtime ports (6001, 6002). The
  # dashboard is served at https://coolify.<domain> through Coolify's proxy, and Terraform
  # reaches the API through the SSH tunnel.
}

resource "hcloud_server" "main" {
  name               = var.name
  server_type        = var.server_type
  image              = var.image
  location           = var.location
  backups            = var.enable_backups
  ssh_keys           = concat([hcloud_ssh_key.admin.id], [for k in hcloud_ssh_key.extra : k.id])
  firewall_ids       = [hcloud_firewall.server.id]
  delete_protection  = var.protect
  rebuild_protection = var.protect

  public_net {
    ipv4_enabled = true
    ipv4         = hcloud_primary_ip.ipv4.id
    ipv6_enabled = true
    ipv6         = hcloud_primary_ip.ipv6.id
  }

  # No secrets here (see the top of this file).
  user_data = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    coolify_version = var.coolify_version
  })

  lifecycle {
    # cloud-init only runs on first boot, and replacing the server would lose every volume
    # (Postgres included). Later changes (e.g. a Coolify upgrade) go through bootstrap.tf.
    ignore_changes = [user_data, image, ssh_keys]
  }
}
