#!/usr/bin/env bash
# Builds the Apple Silicon app locally, with its own Node.js and caches under .toolchain/ in the checkout.
#
#   scripts/build-mac.sh            set up (if needed) and build
#   scripts/build-mac.sh setup      download Node.js and install dependencies
#   scripts/build-mac.sh build      build release/*-mac-arm64.dmg and .zip
#   scripts/build-mac.sh install    copy the built app to /Applications
#   scripts/build-mac.sh clean      delete .toolchain/, node_modules/ and build output
#
# NODE_MIRROR and ELECTRON_MIRROR switch the download servers (e.g. https://npmmirror.com/mirrors/node and
# https://npmmirror.com/mirrors/electron/).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$ROOT/.toolchain"
NODE_MAJOR=22
NODE_MIRROR="${NODE_MIRROR:-https://nodejs.org/dist}"
APP_NAME="Agent Monitor"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "this script builds on Apple Silicon macOS only"

# Everything the build downloads stays in the checkout.
export PATH="$TOOLS/node/bin:$PATH"
export npm_config_cache="$TOOLS/npm-cache"
export ELECTRON_CACHE="$TOOLS/cache/electron"
export ELECTRON_BUILDER_CACHE="$TOOLS/cache/electron-builder"
# No Developer ID certificate: never pick one up from the keychain (electron-builder.yml signs ad hoc).
export CSC_IDENTITY_AUTO_DISCOVERY=false

node_ok() { [ -x "$TOOLS/node/bin/node" ] && [ "$("$TOOLS/node/bin/node" -p 'process.versions.node.split(".")[0]')" = "$NODE_MAJOR" ]; }

install_node() {
  if node_ok; then say "Node.js $("$TOOLS/node/bin/node" -v) is ready"; return; fi
  local index="$NODE_MIRROR/latest-v$NODE_MAJOR.x" sums file dir
  say "Finding the latest Node.js $NODE_MAJOR at $index"
  sums="$(curl -fsSL "$index/SHASUMS256.txt")" || die "cannot download $index/SHASUMS256.txt"
  file="$(printf '%s\n' "$sums" | awk '$2 ~ /-darwin-arm64\.tar\.gz$/ { print $2; exit }')"
  [ -n "$file" ] || die "no darwin-arm64 build listed in $index/SHASUMS256.txt"
  mkdir -p "$TOOLS"
  say "Downloading $file"
  curl -fL --progress-bar -o "$TOOLS/$file" "$index/$file" || die "cannot download $index/$file"
  (cd "$TOOLS" && printf '%s\n' "$sums" | grep "  $file\$" | shasum -a 256 -c -) >/dev/null || { rm -f "$TOOLS/$file"; die "checksum mismatch for $file"; }
  dir="${file%.tar.gz}"
  rm -rf "${TOOLS:?}/$dir"
  tar -xzf "$TOOLS/$file" -C "$TOOLS"
  rm -f "$TOOLS/$file"
  ln -sfn "$dir" "$TOOLS/node"
  say "Installed Node.js $("$TOOLS/node/bin/node" -v) in .toolchain/"
}

setup() {
  install_node
  say "Installing dependencies (npm ci)"
  (cd "$ROOT" && npm ci --no-audit --no-fund)
}

build() {
  # Reinstall when there is no Node.js yet or package-lock.json changed since the last npm ci.
  if ! node_ok || [ ! -f "$ROOT/node_modules/.package-lock.json" ] || [ "$ROOT/package-lock.json" -nt "$ROOT/node_modules/.package-lock.json" ]; then setup; fi
  say "Type checking and building"
  (cd "$ROOT" && npm run build)
  say "Packaging for Apple Silicon"
  rm -rf "$ROOT/release"
  (cd "$ROOT" && npx electron-builder --mac dmg:arm64 zip:arm64 --publish never)
  say "Done:"
  ls -1 "$ROOT"/release/*-mac-arm64.dmg "$ROOT"/release/*-mac-arm64.zip
  echo "Run 'scripts/build-mac.sh install' to copy the app to /Applications, or open the .dmg."
}

install_app() {
  local app="$ROOT/release/mac-arm64/$APP_NAME.app"
  [ -d "$app" ] || die "no built app at $app; run scripts/build-mac.sh build first"
  if pgrep -xq "$APP_NAME"; then die "quit $APP_NAME first"; fi
  say "Copying $APP_NAME.app to /Applications"
  rm -rf "/Applications/$APP_NAME.app"
  ditto "$app" "/Applications/$APP_NAME.app"
  say "Installed. Open it from Launchpad or /Applications."
}

clean() {
  say "Removing .toolchain/, node_modules/ and build output"
  rm -rf "$TOOLS" "$ROOT/node_modules" "$ROOT/dist" "$ROOT/dist-electron" "$ROOT/dist-agent" "$ROOT/release"
}

case "${1:-all}" in
  all) build ;;
  setup) setup ;;
  build) build ;;
  install) install_app ;;
  clean) clean ;;
  -h|--help|help) awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0" ;;
  *) die "unknown command: $1 (try --help)" ;;
esac
