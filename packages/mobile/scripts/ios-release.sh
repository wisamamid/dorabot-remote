#!/usr/bin/env bash
# Build, sign and export (optionally upload) the iOS app for App Store Connect / TestFlight.
#
#   packages/mobile/scripts/ios-release.sh            # archive + export an .ipa, no upload
#   UPLOAD=1 packages/mobile/scripts/ios-release.sh   # also upload to App Store Connect
#
# Auth is an App Store Connect API key, from the environment:
#   ASC_KEY_PATH     path to the AuthKey_XXXX.p8 file
#   ASC_KEY_ID       key id
#   ASC_ISSUER_ID    issuer id
# If unset, they are read from ~/.config/opencode/secrets/global/{asc_private_key.p8,asc_key_id,asc_issuer_id}.
# Key contents are never printed or copied into the repo.
set -euo pipefail

TEAM_ID="${TEAM_ID:-6JE2QNN9JG}"
SECRETS_DIR="${SECRETS_DIR:-$HOME/.config/opencode/secrets/global}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mobile="$(cd "$here/.." && pwd)"
root="$(cd "$mobile/../.." && pwd)"
ios="$mobile/ios/App"
out="$mobile/ios/build"

ASC_KEY_PATH="${ASC_KEY_PATH:-}"
ASC_KEY_ID="${ASC_KEY_ID:-}"
ASC_ISSUER_ID="${ASC_ISSUER_ID:-}"
if [[ -z "$ASC_KEY_PATH" && -f "$SECRETS_DIR/asc_private_key.p8" ]]; then ASC_KEY_PATH="$SECRETS_DIR/asc_private_key.p8"; fi
if [[ -z "$ASC_KEY_ID" && -f "$SECRETS_DIR/asc_key_id" ]]; then ASC_KEY_ID="$(tr -d '[:space:]' < "$SECRETS_DIR/asc_key_id")"; fi
if [[ -z "$ASC_ISSUER_ID" && -f "$SECRETS_DIR/asc_issuer_id" ]]; then ASC_ISSUER_ID="$(tr -d '[:space:]' < "$SECRETS_DIR/asc_issuer_id")"; fi

missing=()
[[ -n "$ASC_KEY_PATH" && -f "$ASC_KEY_PATH" ]] || missing+=(ASC_KEY_PATH)
[[ -n "$ASC_KEY_ID" ]] || missing+=(ASC_KEY_ID)
[[ -n "$ASC_ISSUER_ID" ]] || missing+=(ASC_ISSUER_ID)
if ((${#missing[@]})); then
  echo "error: missing App Store Connect API credentials: ${missing[*]}" >&2
  exit 1
fi

destination="export"
[[ "${UPLOAD:-0}" == "1" ]] && destination="upload"

build_number="$(date -u +%Y%m%d%H%M)"
echo "==> build number $build_number, destination: $destination"

echo "==> building web and syncing Capacitor"
(cd "$root" && npm run build -w @dorabot-remote/protocol && npm run build -w @dorabot-remote/mobile)
(cd "$mobile" && npx cap sync ios)

rm -rf "$out"
mkdir -p "$out"

cat > "$out/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>teamID</key>
  <string>$TEAM_ID</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>destination</key>
  <string>$destination</string>
  <key>uploadSymbols</key>
  <true/>
</dict>
</plist>
PLIST

auth=(
  -allowProvisioningUpdates
  -authenticationKeyPath "$ASC_KEY_PATH"
  -authenticationKeyID "$ASC_KEY_ID"
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
)

echo "==> archiving"
xcodebuild archive \
  -project "$ios/App.xcodeproj" \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$out/App.xcarchive" \
  CURRENT_PROJECT_VERSION="$build_number" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  "${auth[@]}"

echo "==> exporting ($destination)"
xcodebuild -exportArchive \
  -archivePath "$out/App.xcarchive" \
  -exportOptionsPlist "$out/ExportOptions.plist" \
  -exportPath "$out/export" \
  "${auth[@]}"

echo "==> done: $out/export"
