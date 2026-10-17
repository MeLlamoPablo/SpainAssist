# DNS on Route 53. var.domain is registered with Route 53 Domains, and its hosted zone is
# the one the registrar created with the domain (imported below, so the delegation never
# changes). The zone holds an A and an AAAA record for every service host, and the records of
# the website, which is on Framer (at the end).
#
# The services answer on these hosts and, for released desktop apps, on the server's sslip.io
# name too (legacy_hosts in hetzner.tf), which needs no records.
#
# Records point straight at the server: Coolify's proxy gets Let's Encrypt certificates over
# HTTP-01 itself, and no CDN in front cuts long LiteLLM streams or sees prompts.

import {
  to = aws_route53_zone.main
  id = "Z0179001KEZ24N44HX9L"
}

import {
  to = aws_route53domains_registered_domain.main
  id = var.domain
}

resource "aws_route53_zone" "main" {
  name    = var.domain
  comment = "HostedZone created by Route53 Registrar"

  lifecycle {
    prevent_destroy = true
  }
}

# Destroying this resource only drops it from the state: the domain stays registered. The
# Terraform IAM user cannot delete, transfer or stop renewing it either (aws_iam.tf).
resource "aws_route53domains_registered_domain" "main" {
  domain_name = var.domain
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
  name     = "${each.key}.${var.domain}"
  type     = "A"
  ttl      = 300
  records  = [local.ipv4]
}

resource "aws_route53_record" "aaaa" {
  for_each = toset(local.subdomains)
  zone_id  = aws_route53_zone.main.zone_id
  name     = "${each.key}.${var.domain}"
  type     = "AAAA"
  ttl      = 300
  records  = [cidrhost(hcloud_primary_ip.ipv6.ip_network, 1)]
}

# The website: spainassist.es and www.spainassist.es, with the values Framer's custom-domain
# settings ask for. Framer serves both names and gets their certificates itself.
resource "aws_route53_record" "website" {
  zone_id = aws_route53_zone.main.zone_id
  name    = var.domain
  type    = "A"
  ttl     = 300
  records = ["31.43.160.6", "31.43.161.6"]
}

resource "aws_route53_record" "website_www" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "www.${var.domain}"
  type    = "CNAME"
  ttl     = 300
  records = ["sites.framer.app"]
}
