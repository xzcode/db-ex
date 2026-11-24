#!/usr/bin/env bash
# Apple Silicon fallback when GitHub-hosted Actions runners are unavailable.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "ERROR: Requires a native Apple Silicon macOS machine." >&2; exit 1
fi
for command in node npm codesign shasum; do
  command -v "$command" >/dev/null 2>&1 || { echo "ERROR: Missing $command" >&2; exit 1; }
done
xcode-select -p >/dev/null 2>&1 || { echo "ERROR: Install Xcode Command Line Tools." >&2; exit 1; }
if [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]]; then
  echo "ERROR: Node.js 22+ required." >&2; exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: Refuse to package uncommitted changes." >&2; exit 1
fi
test -f assets/approved-icon-source.003.txt || { echo "ERROR: Approved icon source missing." >&2; exit 1; }
commit="$(git rev-parse HEAD)"
echo "Building approved-icon RC3 from $commit"
npm ci
npm run typecheck
npm run build
node --import tsx --test tests/icon-generator.test.ts

# electron-builder reads mac.identity='-' from package.json and ad-hoc signs.
CSC_IDENTITY_AUTO_DISCOVERY=false npm exec electron-builder -- --publish never
bash scripts/verify-mac-package.sh
node scripts/check-packages.mjs

src_dmg="release/DB EX-0.5.0-mac-arm64.dmg"
src_zip="release/DB EX-0.5.0-mac-arm64.zip"
test -s "$src_dmg" && test -s "$src_zip"
out_dmg="release/DB-EX-icon-rc3-macos-arm64.dmg"
out_zip="release/DB-EX-icon-rc3-macos-arm64.zip"
cp "$src_dmg" "$out_dmg"
cp "$src_zip" "$out_zip"
(cd release && shasum -a 256 DB-EX-icon-rc3-macos-arm64.dmg DB-EX-icon-rc3-macos-arm64.zip > SHA256SUMS-Icon-RC3.txt)
echo "Verified ad-hoc signature, custom icon and packaged app smoke."
echo "Source commit: $commit"
printf ' - %s\n' "$out_dmg" "$out_zip" "release/SHA256SUMS-Icon-RC3.txt"

if [[ "$#" -eq 0 || "$1" != "--publish" ]]; then
  echo "To upload, rerun with --publish using an authenticated GitHub CLI."
  exit 0
fi
command -v gh >/dev/null 2>&1 || { echo "ERROR: GitHub CLI required to upload." >&2; exit 1; }
repo='xzcode/db-ex'
tag='v0.5.0-icon-rc3'
if gh release view "$tag" --repo "$repo" >/dev/null 2>&1 ||
   gh api "repos/$repo/git/ref/tags/$tag" >/dev/null 2>&1; then
  echo "ERROR: Release or tag already exists; refusing overwrite." >&2; exit 1
fi
cat > release/RELEASE-NOTES-Icon-RC3.md <<'NOTES'
# DB EX Approved Icon · macOS RC3

macOS Apple Silicon test build. Ad-hoc signed; not Apple Developer ID notarized.
The icon is the user-approved dark-navy tile with thin cyan database linework
and three colored status dots, generated from a SHA-256 pinned artwork source.
MongoDB connection fixes from RC2 remain in place. Old releases are unchanged.
Use SHA256SUMS-Icon-RC3.txt to verify your downloaded installer.
NOTES
gh release create "$tag" --repo "$repo" --target "$commit" --draft --prerelease \
  --title "DB EX Approved App Icon · macOS RC3" \
  --notes-file release/RELEASE-NOTES-Icon-RC3.md
gh release upload "$tag" --repo "$repo" "$out_dmg" "$out_zip" release/SHA256SUMS-Icon-RC3.txt
echo "Uploaded 3 assets to draft release. Review and publish only after verifying."
echo "https://github.com/$repo/releases"
