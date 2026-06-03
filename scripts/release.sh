#!/usr/bin/env bash
set -euo pipefail

# ── release.sh ──────────────────────────────────────────────
#  Automated release script for easycode.
#
#  Usage:
#    ./scripts/release.sh              # tag from current package.json version
#    ./scripts/release.sh patch        # bump patch (0.1.0 → 0.1.1)
#    ./scripts/release.sh minor        # bump minor (0.1.0 → 0.2.0)
#    ./scripts/release.sh major        # bump major (0.1.0 → 1.0.0)
#    ./scripts/release.sh 0.2.0        # explicit version
#
#  What it does:
#    1. Checks working tree is clean
#    2. Bumps version in package.json (optional)
#    3. Commits the version bump
#    4. Runs the unified gate (includes build + real-provider checks)
#    5. Creates an annotated git tag (v*)
#    6. Pushes commit + tag to origin
#
#  CI (GitHub Actions) will pick up the tag and build all
#  platform binaries, then create a GitHub Release.
# ─────────────────────────────────────────────────────────────

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# --- helpers -------------------------------------------------

die() { echo "❌ $*" >&2; exit 1; }
info() { echo "🔹 $*"; }
ok()   { echo "✅ $*"; }

# --- checks --------------------------------------------------

command -v git >/dev/null 2>&1 || die "git is required"
command -v bun >/dev/null 2>&1 || die "bun is required"

if [ -n "$(git status --porcelain)" ]; then
  die "Working tree is not clean. Commit or stash changes first."
fi

# --- version -------------------------------------------------

CURRENT_VERSION="$(node -e "console.log(require('./package.json').version)")"

if [ $# -eq 0 ]; then
  VERSION="$CURRENT_VERSION"
  info "Using current version: $VERSION"
else
  BUMP="${1}"
  case "$BUMP" in
    patch|minor|major)
      VERSION="$(node -e "
        const [mj, mn, pt] = '$CURRENT_VERSION'.split('.').map(Number);
        const bumps = { patch: [mj,mn,pt+1], minor: [mj,mn+1,0], major: [mj+1,0,0] };
        console.log(bumps['$BUMP'].join('.'));
      ")"
      info "Bumping $BUMP: $CURRENT_VERSION → $VERSION"
      ;;
    [0-9]*.[0-9]*.[0-9]*)
      VERSION="$BUMP"
      info "Using explicit version: $VERSION"
      ;;
    *)
      die "Unknown bump type or version: $BUMP (use: patch, minor, major, or semver like 0.2.0)"
      ;;
  esac
fi

# --- execute -------------------------------------------------

TAG="v${VERSION}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  die "Tag $TAG already exists locally"
fi

# Bump version in package.json if changed
if [ "$VERSION" != "$CURRENT_VERSION" ]; then
  node -e "
    const pkg = require('./package.json');
    pkg.version = '$VERSION';
    require('fs').writeFileSync('./package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
  ok "package.json version updated: $VERSION"

  git add package.json
  git commit -m "chore: bump version to $VERSION"
  ok "Committed version bump"
fi

# Verify before tagging so failed builds do not leave pushed release tags behind.
info "Running release verification..."
bun run gate
ok "Verification passed"

# Create tag
git tag -a "$TAG" -m "release $TAG"
ok "Created tag: $TAG"

# Push
info "Pushing commit and tag to origin..."
git push origin HEAD --follow-tags
ok "Pushed! GitHub Actions is building the release 🚀"

echo ""
echo "   ✦  Release $TAG triggered  ✦"
echo ""
echo "   Watch progress: https://github.com/$(git remote get-url origin | sed 's/.*github.com[:\/]//; s/\.git$//')/actions"
