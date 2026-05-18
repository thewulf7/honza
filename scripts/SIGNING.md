# Code Signing Setup

## Overview

Jan builds are signed on three platforms:
- **macOS**: Developer ID Application certificate + notarization via App Store Connect API
- **Windows**: Azure Key Vault via AzureSignTool
- **Linux**: No signing required

All secrets must be added to the GitHub repo under **Settings → Secrets and variables → Actions**.

---

## macOS

### 1. Code Signing Certificate

1. In Xcode → Settings → Accounts → select your Apple Developer account → **Manage Certificates**
2. Create a **"Developer ID Application"** certificate
3. Open **Keychain Access**, find the certificate, right-click → **Export** → save as `.p12` with a strong password
4. Base64-encode it:
   ```bash
   base64 -i cert.p12 | pbcopy
   ```
5. Add to GitHub secrets:
   | Secret | Value |
   |--------|-------|
   | `CODE_SIGN_P12_BASE64` | Base64-encoded `.p12` |
   | `CODE_SIGN_P12_PASSWORD` | Password set during export |

### 2. Notarization Key (App Store Connect API)

1. Go to [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **Users & Access → Integrations → App Store Connect API**
2. Generate a new key with the **Developer** role
3. Download the `.p8` file — **it can only be downloaded once**
4. Note the **Key ID** and **Issuer ID** displayed on the page
5. Base64-encode the key:
   ```bash
   base64 -i AuthKey_XXXX.p8 | pbcopy
   ```
6. Add to GitHub secrets:
   | Secret | Value |
   |--------|-------|
   | `NOTARIZE_P8_BASE64` | Base64-encoded `.p8` |
   | `NOTARY_KEY_ID` | Key ID from the portal |
   | `NOTARY_ISSUER` | Issuer ID from the portal |

### 3. Test Locally

Use `scripts/setup-macos-signing.sh` to replicate the CI keychain setup on your machine:

```bash
export CODE_SIGN_P12_BASE64="..."
export CODE_SIGN_P12_PASSWORD="..."
export NOTARIZE_P8_BASE64="..."
export NOTARY_KEY_ID="..."
export NOTARY_ISSUER="..."

./scripts/setup-macos-signing.sh
```

The script prints the `APPLE_*` env vars to export before building:

```bash
export APPLE_CERTIFICATE="$CODE_SIGN_P12_BASE64"
export APPLE_CERTIFICATE_PASSWORD="$CODE_SIGN_P12_PASSWORD"
export APPLE_API_KEY_PATH="/tmp/notary-key.p8"
export APPLE_API_KEY="$NOTARY_KEY_ID"
export APPLE_API_ISSUER="$NOTARY_ISSUER"
make build
```

To clean up the keychain when done:
```bash
security delete-keychain jan-signing.keychain-db
```

---

## Windows

Windows signing uses **Azure Key Vault** via `AzureSignTool`. The certificate lives in Key Vault rather than being exported.

Add to GitHub secrets:
| Secret | Value |
|--------|-------|
| `AZURE_KEY_VAULT_URI` | Key Vault URI (e.g. `https://my-vault.vault.azure.net`) |
| `AZURE_CLIENT_ID` | Service principal / app registration client ID |
| `AZURE_TENANT_ID` | Azure tenant ID |
| `AZURE_CLIENT_SECRET` | Service principal client secret |
| `AZURE_CERT_NAME` | Name of the certificate in Key Vault |

Signing is handled automatically by `src-tauri/sign.ps1` during the build — no local setup is needed.

---

## Tauri Updater Signing

Both macOS and Windows updater artifacts are signed with a Tauri private key so the auto-updater can verify them.

Generate a key pair (run once, store the output safely):
```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/jan.key
```

Add to GitHub secrets:
| Secret | Value |
|--------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/jan.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password chosen during generation |

The public key is already committed in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`.
