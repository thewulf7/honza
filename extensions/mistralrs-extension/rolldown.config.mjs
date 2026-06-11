import { defineConfig } from 'rolldown'
import pkgJson from './package.json' with { type: 'json' }
import settingJson from './settings.json' with { type: 'json' }

const repoUrl = pkgJson.repository?.url ?? ''
const defaultRepo =
  repoUrl.replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '') ||
  'EricLBuehler/mistral.rs'

// Platform-specific asset names for the mistralrs-server binary archive
function getMistralrsAssetName() {
  const platform = process.platform
  const arch = process.arch
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? 'mistralrs-server-macos-arm64.tar.gz'
      : 'mistralrs-server-macos-x86_64.tar.gz'
  }
  if (platform === 'linux') {
    return 'mistralrs-server-linux-x86_64.tar.gz'
  }
  // Windows
  return 'mistralrs-server-windows-x86_64.zip'
}

export default defineConfig({
  input: 'src/index.ts',
  output: {
    format: 'esm',
    file: 'dist/index.js',
  },
  platform: 'browser',
  define: {
    SETTINGS: JSON.stringify(settingJson),
    ENGINE: JSON.stringify(pkgJson.engine),
    GITHUB_REPO: JSON.stringify(
      process.env.GITHUB_REPO || defaultRepo
    ),
    MISTRALRS_ASSET_NAME: JSON.stringify(getMistralrsAssetName()),
    MISTRALRS_BINARY_NAME: JSON.stringify(
      process.platform === 'win32'
        ? 'mistralrs-server.exe'
        : 'mistralrs-server'
    ),
  },
  inject: process.env.IS_DEV
    ? {}
    : {
        fetch: ['@tauri-apps/plugin-http', 'fetch'],
      },
})
