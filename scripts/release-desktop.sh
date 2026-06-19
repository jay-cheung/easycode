#!/usr/bin/env bash
set -euo pipefail

# GitHub/CI entrypoint for building desktop release artifacts.
# It updates apps/desktop/package.json inside the current checkout so
# electron-builder artifact names match the release tag, then delegates to
# package-desktop.sh. It does not commit, tag, or push.
#
# Usage:
#   ./scripts/release-desktop.sh 0.4.1
#   ./scripts/release-desktop.sh v0.4.1
#   ./scripts/release-desktop.sh desktop-v0.4.1
#   GITHUB_REF_NAME=desktop-v0.4.1 ./scripts/release-desktop.sh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLISH="never"
VERSION=""

die() { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

for arg in "$@"; do
  case "$arg" in
    --publish) PUBLISH="always" ;;
    --publish=*) PUBLISH="${arg#--publish=}" ;;
    --no-publish) PUBLISH="never" ;;
    desktop-v[0-9]*.[0-9]*.[0-9]*) VERSION="${arg#desktop-v}" ;;
    v[0-9]*.[0-9]*.[0-9]*) VERSION="${arg#v}" ;;
    [0-9]*.[0-9]*.[0-9]*) VERSION="$arg" ;;
    *) die "unknown argument: $arg" ;;
  esac
done

if [ -z "$VERSION" ] && [ -n "${GITHUB_REF_NAME:-}" ]; then
  case "$GITHUB_REF_NAME" in
    desktop-v[0-9]*.[0-9]*.[0-9]*) VERSION="${GITHUB_REF_NAME#desktop-v}" ;;
    v[0-9]*.[0-9]*.[0-9]*) VERSION="${GITHUB_REF_NAME#v}" ;;
    [0-9]*.[0-9]*.[0-9]*) VERSION="$GITHUB_REF_NAME" ;;
    *) VERSION="$GITHUB_REF_NAME" ;;
  esac
fi

case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) die "desktop release requires a semver version, v* tag, or desktop-v* tag" ;;
esac

info "setting desktop package version to $VERSION"
cd "$ROOT"
node -e "
  const fs = require('fs');
  const file = './apps/desktop/package.json';
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = '$VERSION';
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
"

"$ROOT/scripts/package-desktop.sh" "--publish=$PUBLISH"
