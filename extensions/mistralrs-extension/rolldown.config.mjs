import { defineConfig } from 'rolldown'
import pkgJson from './package.json' with { type: 'json' }
import settingJson from './settings.json' with { type: 'json' }

const repoUrl = pkgJson.repository?.url ?? ''
const defaultRepo =
  repoUrl.replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '') ||
  'thewulf7/honza'

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
    // Repository whose GitHub releases provide mistralrs-server binaries.
    // Overridable at runtime via the extension's release_repo setting.
    GITHUB_REPO: JSON.stringify(process.env.MISTRALRS_GITHUB_REPO || defaultRepo),
    MISTRALRS_BINARY_NAME: JSON.stringify(
      process.platform === 'win32' ? 'mistralrs-server.exe' : 'mistralrs-server'
    ),
  },
  inject: process.env.IS_DEV
    ? {}
    : {
        fetch: ['@tauri-apps/plugin-http', 'fetch'],
      },
})
