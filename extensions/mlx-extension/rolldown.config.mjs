
import { defineConfig } from 'rolldown'
import pkgJson from './package.json' with { type: 'json' }
import settingJson from './settings.json' with { type: 'json' }

const repoUrl = pkgJson.repository?.url ?? ''
const defaultRepo = repoUrl.replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '') || 'thewulf7/honza'

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
    IS_MAC: JSON.stringify(process.platform === 'darwin'),
    GITHUB_REPO: JSON.stringify(process.env.GITHUB_REPO || defaultRepo),
    MLX_ASSET_NAME: JSON.stringify('mlx-server-macos-arm64.tar.gz'),
  },
  inject: process.env.IS_DEV ? {} : {
      fetch: ['@tauri-apps/plugin-http', 'fetch'],
  },
})
