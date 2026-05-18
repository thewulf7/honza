#!/bin/bash
# setup-macos-signing.sh
#
# Sets up a local macOS keychain for code signing Jan builds.
# Mirrors the certificate import done in CI by apple-actions/import-codesign-certs.
#
# Required environment variables:
#   CODE_SIGN_P12_BASE64      Base64-encoded .p12 certificate
#   CODE_SIGN_P12_PASSWORD    Password for the .p12 certificate
#
# Optional environment variables (for notarization):
#   NOTARIZE_P8_BASE64        Base64-encoded App Store Connect API .p8 key
#   NOTARY_KEY_ID             App Store Connect API Key ID
#   NOTARY_ISSUER             App Store Connect API Issuer ID
#
# After running this script, build with:
#   export APPLE_CERTIFICATE="$CODE_SIGN_P12_BASE64"
#   export APPLE_CERTIFICATE_PASSWORD="$CODE_SIGN_P12_PASSWORD"
#   export APPLE_API_ISSUER="$NOTARY_ISSUER"
#   export APPLE_API_KEY="$NOTARY_KEY_ID"
#   export APPLE_API_KEY_PATH="/tmp/notary-key.p8"   # if notarization is set up
#   make build

set -euo pipefail

KEYCHAIN_NAME="jan-signing.keychain-db"
KEYCHAIN_PASSWORD="$(openssl rand -hex 16)"
P12_TMP="$(mktemp /tmp/signing-cert.XXXXXX.p12)"

cleanup() {
  rm -f "$P12_TMP"
}
trap cleanup EXIT

# ── Validate required inputs ────────────────────────────────────────────────

if [[ -z "${CODE_SIGN_P12_BASE64:-}" ]]; then
  echo "Error: CODE_SIGN_P12_BASE64 is not set." >&2
  exit 1
fi

if [[ -z "${CODE_SIGN_P12_PASSWORD:-}" ]]; then
  echo "Error: CODE_SIGN_P12_PASSWORD is not set." >&2
  exit 1
fi

# ── Keychain setup ───────────────────────────────────────────────────────────

echo "==> Creating signing keychain: $KEYCHAIN_NAME"

# Remove any leftover keychain from a previous run
security delete-keychain "$KEYCHAIN_NAME" 2>/dev/null || true

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"

# Prevent auto-lock (6 h timeout)
security set-keychain-settings -lut 21600 "$KEYCHAIN_NAME"

security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"

# ── Import certificate ───────────────────────────────────────────────────────

echo "==> Importing code-signing certificate"

echo "$CODE_SIGN_P12_BASE64" | base64 --decode > "$P12_TMP"

security import "$P12_TMP" \
  -k "$KEYCHAIN_NAME" \
  -P "$CODE_SIGN_P12_PASSWORD" \
  -T /usr/bin/codesign \
  -T /usr/bin/security

# Allow codesign to use the private key without prompting
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "$KEYCHAIN_PASSWORD" \
  "$KEYCHAIN_NAME"

# Prepend to the search list so codesign finds it first
security list-keychains -d user -s "$KEYCHAIN_NAME" $(security list-keychains -d user | tr -d '"')

echo "==> Keychain setup complete"

# ── Notarization key (optional) ──────────────────────────────────────────────

if [[ -n "${NOTARIZE_P8_BASE64:-}" ]]; then
  NOTARY_KEY_PATH="/tmp/notary-key.p8"
  echo "==> Writing notarization key to $NOTARY_KEY_PATH"
  echo "$NOTARIZE_P8_BASE64" | base64 --decode > "$NOTARY_KEY_PATH"
  chmod 600 "$NOTARY_KEY_PATH"
  echo "==> Notarization key ready"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "Signing environment is ready. Export these variables before running make build:"
echo ""
echo "  export APPLE_CERTIFICATE=\"\$CODE_SIGN_P12_BASE64\""
echo "  export APPLE_CERTIFICATE_PASSWORD=\"\$CODE_SIGN_P12_PASSWORD\""

if [[ -n "${NOTARIZE_P8_BASE64:-}" ]]; then
  echo "  export APPLE_API_KEY_PATH=\"/tmp/notary-key.p8\""
  if [[ -n "${NOTARY_KEY_ID:-}" ]]; then
    echo "  export APPLE_API_KEY=\"$NOTARY_KEY_ID\""
  else
    echo "  export APPLE_API_KEY=\"<your key ID>\""
  fi
  if [[ -n "${NOTARY_ISSUER:-}" ]]; then
    echo "  export APPLE_API_ISSUER=\"$NOTARY_ISSUER\""
  else
    echo "  export APPLE_API_ISSUER=\"<your issuer ID>\""
  fi
fi

echo ""
echo "To tear down the keychain when done:"
echo "  security delete-keychain $KEYCHAIN_NAME"
