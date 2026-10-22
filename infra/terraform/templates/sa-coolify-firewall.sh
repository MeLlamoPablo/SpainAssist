#!/bin/sh
# Coolify's dashboard (8000) and realtime ports (6001, 6002) answer only on loopback, where
# Tailscale Serve and the Terraform SSH tunnel reach them. Docker publishes them on every
# address, and Tailscale accepts tailnet traffic before Docker's DOCKER-USER chain, so the
# block sits in mangle PREROUTING, ahead of both: every interface but loopback and Docker's
# own (whose containers may use these ports among themselves) is refused. Idempotent.
set -eu
for ipt in iptables ip6tables; do
  $ipt -t mangle -N SA-COOLIFY 2>/dev/null || $ipt -t mangle -F SA-COOLIFY
  for iface in lo docker0 br+ veth+; do
    $ipt -t mangle -A SA-COOLIFY -i "$iface" -j RETURN
  done
  $ipt -t mangle -A SA-COOLIFY -p tcp -m multiport --dports 8000,6001,6002 -j DROP
  $ipt -t mangle -C PREROUTING -j SA-COOLIFY 2>/dev/null || $ipt -t mangle -I PREROUTING -j SA-COOLIFY
done
