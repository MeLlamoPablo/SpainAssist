# DNS on Route 53. var.dns_domain is registered with Route 53 Domains, and its hosted zone is
# the one the registrar created with the domain (imported below, so the delegation never
# changes). The zone holds an A and an AAAA record for every service host.
#
# The records exist whatever var.domain says. The apps keep using <ipv4-with-dashes>.sslip.io
# until var.domain = var.dns_domain in terraform.tfvars; then ./tf.sh apply moves Coolify's
# dashboard, the apps and LiteLLM to the new hosts (with new certificates). Update the app's
# default service URLs too (PRODUCTION_SERVICES in @sa/shared).
#
# Records point straight at the server: Coolify's proxy gets Let's Encrypt certificates over
# HTTP-01 itself, and no CDN in front cuts long LiteLLM streams or sees prompts.

import {
  to = aws_route53_zone.main
  id = "Z0179001KEZ24N44HX9L"
}

import {
  to = aws_route53domains_registered_domain.main
  id = var.dns_domain
}

resource "aws_route53_zone" "main" {
  name    = var.dns_domain
  comment = "HostedZone created by Route53 Registrar"

  lifecycle {
    prevent_destroy = true
  }
}

# Destroying this resource only drops it from the state: the domain stays registered. The
# Terraform IAM user cannot delete, transfer or stop renewing it either (aws_iam.tf).
resource "aws_route53domains_registered_domain" "main" {
  domain_name = var.dns_domain
  auto_renew  = true
  # .es domains have no transfer lock.
  transfer_lock = false

  dynamic "name_server" {
    for_each = aws_route53_zone.main.name_servers
    content {
      name = name_server.value
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_route53_record" "a" {
  for_each = toset(local.subdomains)
  zone_id  = aws_route53_zone.main.zone_id
  name     = "${each.key}.${var.dns_domain}"
  type     = "A"
  ttl      = 300
  records  = [local.ipv4]
}

resource "aws_route53_record" "aaaa" {
  for_each = toset(local.subdomains)
  zone_id  = aws_route53_zone.main.zone_id
  name     = "${each.key}.${var.dns_domain}"
  type     = "AAAA"
  ttl      = 300
  records  = [cidrhost(hcloud_primary_ip.ipv6.ip_network, 1)]
}
