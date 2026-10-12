#!/bin/sh
# Terraform for infra/terraform, with an SSH tunnel to Coolify's API while it runs.
#
#   ./tf.sh init
#   ./tf.sh bootstrap     # first time only: server, IPs, firewall and Coolify itself
#   ./tf.sh plan
#   ./tf.sh apply
#
# The Coolify provider talks to http://127.0.0.1:<coolify_tunnel_port>, which this script
# forwards to Coolify on the server (port 8000 is not public). The provider checks Coolify's
# version when it starts, so it cannot plan before Coolify exists: that is what `bootstrap`
# (= apply -target=terraform_data.coolify) is for.
#
# Set TERRAFORM to use another binary (Terraform >= 1.6 is required).
set -eu
cd "$(dirname "$0")"
tf=${TERRAFORM:-terraform}

case "${1:-}" in
  bootstrap)
    shift
    exec "$tf" apply -target=terraform_data.coolify "$@"
    ;;
  "" | init | fmt | validate | version | output | state | show | providers | -*)
    exec "$tf" "$@"
    ;;
esac

if ! ip=$("$tf" output -raw ipv4_address 2>/dev/null) || [ -z "$ip" ]; then
  echo "tf.sh: no server in the state yet. Run ./tf.sh bootstrap first." >&2
  exit 1
fi
port=$("$tf" output -raw coolify_tunnel_port)

dir=$(mktemp -d)
pid=
cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  rm -rf "$dir"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

"$tf" output -raw ssh_private_key >"$dir/key"
chmod 600 "$dir/key"
mkdir -p .terraform
ssh -N -i "$dir/key" -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=.terraform/known_hosts \
  -o ServerAliveInterval=30 -L "127.0.0.1:$port:127.0.0.1:8000" "root@$ip" &
pid=$!

i=0
until nc -z 127.0.0.1 "$port" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 50 ] || ! kill -0 "$pid" 2>/dev/null; then
    echo "tf.sh: could not open the SSH tunnel to $ip" >&2
    exit 1
  fi
  sleep 0.2
done

status=0
"$tf" "$@" || status=$?
exit $status
