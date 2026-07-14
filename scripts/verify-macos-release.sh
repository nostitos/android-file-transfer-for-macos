#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DMG_PATH="${1:?Usage: verify-macos-release.sh DMG_PATH ARCH}"
ARCH="${2:?Usage: verify-macos-release.sh DMG_PATH ARCH}"
TEAM_ID="${EXPECTED_TEAM_ID:-RJL9XWBZ9L}"
MOUNT_POINT="$(mktemp -d "${TMPDIR:-/tmp}/android-file-transfer-dmg.XXXXXX")"

cleanup() {
  hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || true
  rmdir "$MOUNT_POINT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

codesign --verify --verbose=2 "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG_PATH"
hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_POINT" -quiet

APP_PATH="$(find "$MOUNT_POINT" -maxdepth 1 -type d -name '*.app' -print -quit)"
[[ -n "$APP_PATH" ]]
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
xcrun stapler validate "$APP_PATH"
spctl --assess --type execute --verbose=4 "$APP_PATH"

APP_TEAM="$(codesign -dv --verbose=4 "$APP_PATH" 2>&1 | awk -F= '/^TeamIdentifier=/{print $2; exit}')"
[[ "$APP_TEAM" == "$TEAM_ID" ]]

for relative_path in \
  'Contents/Resources/bin/mtp-json' \
  'Contents/Resources/bin/file-promise-drag.node' \
  'Contents/Resources/lib/libmtp.9.dylib' \
  'Contents/Resources/lib/libusb-1.0.0.dylib'; do
  BINARY="$APP_PATH/$relative_path"
  codesign --verify --strict --verbose=2 "$BINARY"
  BINARY_TEAM="$(codesign -dv --verbose=4 "$BINARY" 2>&1 | awk -F= '/^TeamIdentifier=/{print $2; exit}')"
  [[ "$BINARY_TEAM" == "$TEAM_ID" ]]
done

node "$ROOT/scripts/check-macho.mjs" --root "$APP_PATH" --arch "$ARCH" --max-macos 12.0
echo "Verified signed, notarized $ARCH DMG: $DMG_PATH"
