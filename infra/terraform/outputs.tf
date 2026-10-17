output "ipv4_address" {
  description = "Reserved IPv4 (A records point here)."
  value       = hcloud_primary_ip.ipv4.ip_address
}

output "ipv6_address" {
  description = "Reserved IPv6 network (AAAA records point at its ::1)."
  value       = hcloud_primary_ip.ipv6.ip_network
}

output "urls" {
  description = "Public endpoints. The app's PRODUCTION_SERVICES take key_server, feedback_server, maps_server and relay_server."
  value = {
    coolify         = local.coolify_url
    key_server      = "https://${local.hosts.keys}"
    feedback_server = "https://${local.hosts.feedback}"
    maps_server     = "https://${local.hosts.maps}"
    relay_server    = "https://${local.hosts.relay}"
    litellm         = "https://${local.hosts.llm}"
    litellm_ui      = "https://${local.hosts.llm}/ui"
    unleash         = "https://${local.hosts.flags}"
    glitchtip       = "https://${local.hosts.errors}"
  }
}

output "legacy_urls" {
  description = "Endpoints on the server's sslip.io name that released desktop apps still call."
  value       = { for name, host in local.legacy_hosts : name => "https://${host}" }
}

output "unleash_frontend_tokens" {
  description = "Unleash frontend tokens built into the desktop app, by environment (public by design)."
  value = {
    production  = unleash_api_token.desktop.secret
    development = unleash_api_token.desktop_development.secret
  }
  sensitive = true
}

output "coolify_root_email" {
  value = var.coolify_root_email != "" ? var.coolify_root_email : "admin@${var.domain}"
}

output "ssh" {
  value = "ssh root@${hcloud_primary_ip.ipv4.ip_address}"
}

# Read by ./tf.sh for the Coolify API tunnel. depends_on: a targeted apply (./tf.sh bootstrap)
# only saves outputs that depend on a targeted resource.
output "coolify_tunnel_port" {
  value      = var.coolify_tunnel_port
  depends_on = [hcloud_server.main]
}

output "ssh_private_key" {
  description = "Root SSH key: terraform output -raw ssh_private_key"
  value       = var.ssh_private_key
  sensitive   = true
  depends_on  = [hcloud_server.main]
}
