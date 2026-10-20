#!/bin/bash
# notarize.sh <path> <submission name>: notarizes a signed .app or .dmg and staples the ticket,
# so a re-run of the job never redoes what Apple already did. Apple keys tickets by the signed
# bytes, and the job notarizes the same artifact every run:
#   1. Staple: if Apple accepted an earlier run's submission (even one this job stopped waiting
#      for), the ticket is there and this is all a re-run does.
#   2. A submission of this name still in progress (an earlier run timed out): wait for it.
#   3. Otherwise submit, wait and staple.
# Then Gatekeeper must accept it. Needs APPLE_API_KEY (the .p8's path), APPLE_API_KEY_ID and
# APPLE_API_ISSUER.
set -euo pipefail
target=$1
name=$2
auth=(--key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
timeout=30m

staple() { xcrun stapler staple "$target" > /dev/null 2>&1; }

check() {
  if [[ $target == *.app ]]; then
    spctl --assess -vvv --type exec "$target"
  else
    spctl --assess -vvv --type open --context context:primary-signature "$target"
  fi
}

if staple; then
  echo "$name: already notarized, stapled the ticket"
  check
  exit 0
fi

pending=$(xcrun notarytool history "${auth[@]}" --output-format json |
  jq -r --arg name "$name" \
    'first(.history[] | select(.name == $name and .status == "In Progress") | .id) // empty')
if [[ -n $pending ]]; then
  echo "$name: waiting for submission $pending from an earlier run"
  xcrun notarytool wait "$pending" "${auth[@]}" --timeout "$timeout" || true
  if staple; then
    check
    exit 0
  fi
  echo "$name: that submission was not for these bytes, submitting"
fi

# notarytool takes a zip, dmg or pkg, not a bare .app.
upload=$target
if [[ $target == *.app ]]; then
  upload="$RUNNER_TEMP/$name"
  ditto -c -k --sequesterRsrc --keepParent "$target" "$upload"
fi
result="$RUNNER_TEMP/notarytool-$name.json"
code=0
xcrun notarytool submit "$upload" "${auth[@]}" --wait --timeout "$timeout" \
  --output-format json > "$result" || code=$?
cat "$result"
echo
id=$(jq -r '.id // empty' "$result")
status=$(jq -r '.status // empty' "$result")
if [[ $status != Accepted ]]; then
  # Apple's log names each file it rejected, and why.
  [[ -n $id ]] && xcrun notarytool log "$id" "${auth[@]}" || true
  echo "::error::Notarization of $name: ${status:-no result} (notarytool exit $code). Re-run this job: it picks up a late ticket instead of submitting again."
  exit 1
fi
xcrun stapler staple "$target"
check
