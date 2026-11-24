#!/bin/bash
# Install or update Shoal on macOS with one command:
#   curl -fsSL https://raw.githubusercontent.com/romainmourad/Shoal/main/install.sh | bash
# Downloads the latest release from GitHub, quits Shoal if it is running, replaces the app
# and opens it again. Conversations, history and settings live in ~/Library/Application Support/Shoal
# and are kept. A file downloaded with curl is not quarantined, so macOS does not block the app.
set -euo pipefail

REPO="romainmourad/Shoal"
say() { printf '\033[1;32m›\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || fail "This script is for macOS. On Windows, download Shoal from https://github.com/$REPO/releases/latest"

# Apple silicon or Intel (hw.optional.arm64 is also right when the terminal runs under Rosetta)
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then ARCH="arm64"; else ARCH="x64"; fi

# latest version: GitHub redirects /releases/latest to /releases/tag/vX.Y.Z
TAG_URL=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") || fail "Could not reach GitHub."
VERSION="${TAG_URL##*/tag/v}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Could not find the latest version of Shoal."

# where Shoal is (or goes): an existing install is updated in place, otherwise /Applications
if [ -n "${SHOAL_APP_DIR:-}" ]; then DIR="$SHOAL_APP_DIR"
elif [ -d "$HOME/Applications/Shoal.app" ] && [ ! -d "/Applications/Shoal.app" ]; then DIR="$HOME/Applications"
elif [ -w "/Applications" ]; then DIR="/Applications"
else DIR="$HOME/Applications"; fi
APP="$DIR/Shoal.app"

CURRENT=""
[ -d "$APP" ] && CURRENT=$(defaults read "$APP/Contents/Info" CFBundleShortVersionString 2>/dev/null || true)
if [ "$CURRENT" = "$VERSION" ]; then
  say "Shoal $VERSION is already installed (latest version)."
  open "$APP"; exit 0
fi
if [ -n "$CURRENT" ]; then say "Updating Shoal $CURRENT → $VERSION"; else say "Installing Shoal $VERSION"; fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ZIP="Shoal-$VERSION-mac-$ARCH.zip"
say "Downloading ${ZIP}…"
curl -fL --progress-bar -o "$TMP/$ZIP" "https://github.com/$REPO/releases/download/v$VERSION/$ZIP" || fail "Download failed."
ditto -x -k "$TMP/$ZIP" "$TMP/out" || fail "Could not unzip $ZIP."
[ -d "$TMP/out/Shoal.app" ] || fail "Shoal.app not found in $ZIP."

# quit Shoal if it is running (open conversations are noted and resumed at the next launch).
# Only the app itself is matched: its background server stops on its own, or is restarted by the new
# version if "Keep conversations running after quitting" is on.
app_pids() { ps -axo pid=,args= | awk '{ pid = $1; $1 = ""; sub(/^ /, "") } /\.app\/Contents\/MacOS\/Shoal$/ { print pid }'; }
if [ -n "$(app_pids)" ]; then
  say "Quitting Shoal…"
  osascript -e 'quit app "Shoal"' >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do [ -z "$(app_pids)" ] && break; sleep 0.25; done
  [ -z "$(app_pids)" ] || kill $(app_pids) 2>/dev/null || true
  sleep 1
fi

mkdir -p "$DIR"
rm -rf "$APP"
ditto "$TMP/out/Shoal.app" "$APP" || fail "Could not copy Shoal.app to $DIR."
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

say "Shoal $VERSION is installed in $DIR. Opening it…"
open "$APP"
