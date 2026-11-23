#!/usr/bin/env bash
set -euo pipefail

# A normal Electron smoke test does not prove macOS code signing.
app="release/mac-arm64/DB EX.app"
if [[ ! -d "$app" ]]; then
  echo "::error::Expected macOS ARM64 application bundle not found: $app"
  exit 1
fi
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
/usr/bin/codesign -dv --verbose=4 "$app" 2>&1 | tee /tmp/db-ex-codesign.txt
if ! grep -Fq 'Signature=adhoc' /tmp/db-ex-codesign.txt; then
  echo "::error::DB EX bundle does not carry the required ad-hoc signature"
  exit 1
fi
if ! find "$app/Contents/Resources" -maxdepth 1 -name '*.icns' -size +10k -print -quit | grep -q .; then
  echo "::error::Custom ICNS application icon is missing from the app bundle"
  exit 1
fi
echo "Validated ad-hoc app signature and embedded ICNS icon."
