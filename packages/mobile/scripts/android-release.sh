#!/usr/bin/env bash
# Build a signed release AAB for Google Play.
#
#   ANDROID_KEYSTORE_PATH=... ANDROID_KEYSTORE_PASSWORD=... ANDROID_KEY_ALIAS=... \
#   ANDROID_KEY_PASSWORD=... packages/mobile/scripts/android-release.sh
#
# The keystore is a dedicated upload key for this app. It must live outside the
# repo and is never created or copied by this script.
set -euo pipefail

missing=()
for v in ANDROID_KEYSTORE_PATH ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; do
  [[ -n "${!v:-}" ]] || missing+=("$v")
done
if ((${#missing[@]})); then
  echo "error: missing required environment variables: ${missing[*]}" >&2
  echo "Create a new upload keystore outside the repo (keytool -genkeypair -v -keystore <path> -alias <alias> -keyalg RSA -keysize 4096 -validity 10000) and export the variables above." >&2
  exit 1
fi
if [[ ! -f "$ANDROID_KEYSTORE_PATH" ]]; then
  echo "error: ANDROID_KEYSTORE_PATH does not point to a file: $ANDROID_KEYSTORE_PATH" >&2
  exit 1
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mobile="$(cd "$here/.." && pwd)"
root="$(cd "$mobile/../.." && pwd)"

# Gradle 8.14 needs JDK 21; Android Studio's bundled JBR works if JAVA_HOME is unset.
if [[ -z "${JAVA_HOME:-}" ]] && command -v /usr/libexec/java_home >/dev/null 2>&1; then
  JAVA_HOME="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
  [[ -n "$JAVA_HOME" ]] && export JAVA_HOME
fi

version_code="${VERSION_CODE:-$(( $(date -u +%s) / 60 ))}"
echo "==> versionCode $version_code"

echo "==> building web and syncing Capacitor"
(cd "$root" && npm run build -w @dorabot-remote/protocol && npm run build -w @dorabot-remote/mobile)
(cd "$mobile" && npx cap sync android)

echo "==> bundling release"
(cd "$mobile/android" && ./gradlew bundleRelease -PversionCode="$version_code")

echo "==> done: $mobile/android/app/build/outputs/bundle/release/app-release.aab"
