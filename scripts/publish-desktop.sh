#!/usr/bin/env bash
set -euo pipefail

# publish-desktop.sh
#  One-command desktop release script for easycode.
#
#  Usage:
#    ./scripts/publish-desktop.sh              # tag from apps/desktop/package.json version
#    ./scripts/publish-desktop.sh patch        # bump patch (0.1.0 -> 0.1.1)
#    ./scripts/publish-desktop.sh minor        # bump minor (0.1.0 -> 0.2.0)
#    ./scripts/publish-desktop.sh major        # bump major (0.1.0 -> 1.0.0)
#    ./scripts/publish-desktop.sh 0.2.0        # explicit version
#    ./scripts/publish-desktop.sh desktop-v0.2.0
#
#  What it does:
#    1. Checks working tree is clean
#    2. Bumps apps/desktop/package.json version when needed
#    3. Commits the desktop version bump when needed
#    4. Builds local desktop release artifacts for verification
#    5. Creates an annotated desktop-v* git tag
#    6. Pushes commit + tag to origin
#
#  CI (GitHub Actions) will pick up the desktop-v* tag and build
#  cross-platform desktop artifacts, then create a GitHub Release.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

die() { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*"; }
ok() { echo "ok: $*"; }

usage() {
  sed -n '4,24p' "$0"
}

command -v git >/dev/null 2>&1 || die "git is required"
command -v bun >/dev/null 2>&1 || die "bun is required"
command -v node >/dev/null 2>&1 || die "node is required"

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac

if [ "$#" -gt 1 ]; then
  die "expected zero or one version argument"
fi

if [ -n "$(git status --porcelain)" ]; then
  die "Working tree is not clean. Commit or stash changes first."
fi

CURRENT_VERSION="$(node -e "console.log(require('./apps/desktop/package.json').version)")"

if [ "$#" -eq 0 ]; then
  VERSION="$CURRENT_VERSION"
  info "Using current desktop version: $VERSION"
else
  BUMP="$1"
  case "$BUMP" in
    patch|minor|major)
      VERSION="$(node -e "
        const [major, minor, patch] = '$CURRENT_VERSION'.split('.').map(Number);
        const bumps = {
          patch: [major, minor, patch + 1],
          minor: [major, minor + 1, 0],
          major: [major + 1, 0, 0],
        };
        console.log(bumps['$BUMP'].join('.'));
      ")"
      info "Bumping desktop $BUMP: $CURRENT_VERSION -> $VERSION"
      ;;
    desktop-v[0-9]*.[0-9]*.[0-9]*)
      VERSION="${BUMP#desktop-v}"
      info "Using desktop tag version: $VERSION"
      ;;
    v[0-9]*.[0-9]*.[0-9]*)
      VERSION="${BUMP#v}"
      info "Using tag version: $VERSION"
      ;;
    [0-9]*.[0-9]*.[0-9]*)
      VERSION="$BUMP"
      info "Using explicit desktop version: $VERSION"
      ;;
    *)
      die "Unknown bump type or version: $BUMP (use: patch, minor, major, semver, v*, or desktop-v*)"
      ;;
  esac
fi

case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) die "desktop release requires a semver version" ;;
esac

TAG="desktop-v${VERSION}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  die "Tag $TAG already exists locally"
fi

if [ "$VERSION" != "$CURRENT_VERSION" ]; then
  VERSION="$VERSION" node -e "
    const fs = require('fs');
    const file = './apps/desktop/package.json';
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    pkg.version = process.env.VERSION;
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  "
  ok "apps/desktop/package.json version updated: $VERSION"

  git add apps/desktop/package.json
  git commit -m "chore: bump desktop version to $VERSION"
  ok "Committed desktop version bump"
fi

info "Building desktop release artifacts before tagging..."
bun run desktop:release -- "$TAG"
ok "Desktop release artifacts built"

if [ -n "$(git status --porcelain -- apps/desktop/package.json)" ]; then
  die "apps/desktop/package.json changed during packaging; inspect before tagging"
fi

git tag -a "$TAG" -m "desktop release $TAG"
ok "Created tag: $TAG"

info "Pushing commit and tag to origin..."
git push origin HEAD --follow-tags
ok "Pushed. GitHub Actions is building the desktop release."

echo ""
echo "   Desktop release $TAG triggered"
echo ""
echo "   Watch progress: https://github.com/$(git remote get-url origin | sed 's/.*github.com[:\/]//; s/\.git$//')/actions"
