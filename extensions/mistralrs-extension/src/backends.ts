import {
  getJanDataFolderPath,
  fs,
  joinPath,
  events,
  DownloadEvent,
} from '@janhq/core'
import { invoke } from '@tauri-apps/api/core'
import { getSystemInfo } from '@janhq/tauri-plugin-hardware-api'

/**
 * One installable mistralrs-server build: a release version (git tag of the
 * release repo) plus a platform/acceleration variant ("backend"), e.g.
 * version "v0.8.3", backend "windows-cuda-x64".
 */
export interface MistralrsBackend {
  version: string
  backend: string
  downloadUrl: string
  installed: boolean
}

/** Release asset name for a backend variant. */
export function assetNameFor(backend: string): string {
  return `mistralrs-server-${backend}.tar.gz`
}

// ---------------------------------------------------------------------------
// Path helpers
// folder structure: <Jan data folder>/mistralrs/backends/<version>/<backend>/
// ---------------------------------------------------------------------------

export async function getBackendsDir(): Promise<string> {
  const janData = await getJanDataFolderPath()
  return joinPath([janData, 'mistralrs', 'backends'])
}

export async function getBackendDir(
  version: string,
  backend: string
): Promise<string> {
  const backendsDir = await getBackendsDir()
  return joinPath([backendsDir, version, backend])
}

export async function getBackendExePath(
  version: string,
  backend: string
): Promise<string> {
  const dir = await getBackendDir(version, backend)
  return joinPath([dir, MISTRALRS_BINARY_NAME])
}

export async function isBackendInstalled(
  version: string,
  backend: string
): Promise<boolean> {
  return fs.existsSync(await getBackendExePath(version, backend))
}

// ---------------------------------------------------------------------------
// Supported variants for this machine
// ---------------------------------------------------------------------------

/**
 * Backend variants this machine can run, in preference order (best first).
 */
export async function determineSupportedBackends(): Promise<string[]> {
  const sysInfo = await getSystemInfo()
  const os = sysInfo.os_type
  const rawArch = sysInfo.cpu.arch?.toLowerCase() ?? ''
  const arch =
    rawArch === 'aarch64' || rawArch === 'arm64' ? 'arm64' : 'x64'
  const hasNvidia = (sysInfo.gpus ?? []).some(
    (g) => g.vendor?.toLowerCase().includes('nvidia') || g.nvidia_info
  )

  if (os === 'macos') {
    return arch === 'arm64' ? ['macos-metal-arm64'] : ['macos-cpu-x64']
  }

  const variants: string[] = []
  if (hasNvidia) variants.push(`${os}-cuda-${arch}`)
  variants.push(`${os}-cpu-${arch}`)
  return variants
}

// ---------------------------------------------------------------------------
// Querying installed / remote backends
// ---------------------------------------------------------------------------

export async function getInstalledBackends(): Promise<MistralrsBackend[]> {
  const backendsDir = await getBackendsDir()
  if (!(await fs.existsSync(backendsDir))) return []

  const installed: MistralrsBackend[] = []
  const versions = await fs.readdirSync(backendsDir)
  for (const versionEntry of versions) {
    const version = String(versionEntry).split(/[/\\]/).pop()!
    const versionDir = await joinPath([backendsDir, version])
    let variants: string[]
    try {
      variants = await fs.readdirSync(versionDir)
    } catch {
      continue
    }
    for (const variantEntry of variants) {
      const backend = String(variantEntry).split(/[/\\]/).pop()!
      if (await isBackendInstalled(version, backend)) {
        installed.push({ version, backend, downloadUrl: '', installed: true })
      }
    }
  }
  return installed
}

// ---------------------------------------------------------------------------
// GitHub release fetching, with caching
//
// Several flows (dropdown refresh, recommendation, install, update check)
// need the release list, and unauthenticated GitHub API calls are limited to
// 60/hour — so the raw list is cached per repo, errors are negatively cached,
// and concurrent callers share one in-flight request.
// ---------------------------------------------------------------------------

const RELEASES_TTL_MS = 5 * 60_000
const RELEASES_ERROR_TTL_MS = 60_000

let releasesCache: { repo: string; fetchedAt: number; releases: any[] } | null =
  null
let releasesError: { repo: string; failedAt: number } | null = null
let releasesInflight: { repo: string; promise: Promise<any[]> } | null = null

async function fetchGithubReleases(repo: string): Promise<any[]> {
  const now = Date.now()
  if (
    releasesCache &&
    releasesCache.repo === repo &&
    now - releasesCache.fetchedAt < RELEASES_TTL_MS
  ) {
    return releasesCache.releases
  }
  if (
    releasesError &&
    releasesError.repo === repo &&
    now - releasesError.failedAt < RELEASES_ERROR_TTL_MS
  ) {
    return []
  }
  if (releasesInflight && releasesInflight.repo === repo) {
    return releasesInflight.promise
  }

  const promise = (async () => {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${repo}/releases?per_page=30`,
        { headers: { Accept: 'application/vnd.github+json' } }
      )
      if (!response.ok) {
        console.warn(`[mistralrs] GitHub API responded ${response.status}`)
        releasesError = { repo, failedAt: Date.now() }
        return []
      }
      const releases = (await response.json()) as any[]
      releasesCache = { repo, fetchedAt: Date.now(), releases }
      releasesError = null
      return releases
    } catch (e) {
      console.warn('[mistralrs] GitHub releases fetch failed:', e)
      releasesError = { repo, failedAt: Date.now() }
      return []
    } finally {
      releasesInflight = null
    }
  })()

  releasesInflight = { repo, promise }
  return promise
}

/**
 * Fetches releases of `repo` and returns every asset matching a backend
 * variant supported on this machine. Releases without matching assets
 * (e.g. app releases when the repo is shared) are skipped.
 */
export async function fetchRemoteBackends(
  repo: string,
  supportedBackends: string[]
): Promise<MistralrsBackend[]> {
  const releases = await fetchGithubReleases(repo)
  const result: MistralrsBackend[] = []
  for (const release of releases) {
    if (release.prerelease || release.draft) continue
    for (const backend of supportedBackends) {
      const asset = release.assets?.find(
        (a: any) => a.name === assetNameFor(backend)
      )
      if (asset) {
        result.push({
          version: release.tag_name as string,
          backend,
          downloadUrl: asset.browser_download_url as string,
          installed: false,
        })
      }
    }
  }
  return result
}

/**
 * Remote (hardware-supported) + locally installed backends, newest version
 * first; within a version, supported-variant preference order is preserved.
 */
export async function listAvailableBackends(
  repo: string
): Promise<MistralrsBackend[]> {
  const supported = await determineSupportedBackends()
  const [remote, installed] = await Promise.all([
    fetchRemoteBackends(repo, supported).catch(() => [] as MistralrsBackend[]),
    getInstalledBackends(),
  ])

  const installedKeys = new Set(
    installed.map((b) => `${b.version}/${b.backend}`)
  )
  const remoteWithState = remote.map((b) => ({
    ...b,
    installed: installedKeys.has(`${b.version}/${b.backend}`),
  }))

  const remoteKeys = new Set(remote.map((b) => `${b.version}/${b.backend}`))
  const localOnly = installed.filter(
    (b) => !remoteKeys.has(`${b.version}/${b.backend}`)
  )

  return [...remoteWithState, ...localOnly].sort((a, b) =>
    b.version.localeCompare(a.version, undefined, { numeric: true })
  )
}

/**
 * The best backend to recommend: newest remote version, best variant.
 * Returns '' when there is no remote data (offline / repo without releases).
 */
export async function determineBestBackend(
  repo: string
): Promise<string> {
  const supported = await determineSupportedBackends()
  const remote = await fetchRemoteBackends(repo, supported).catch(
    () => [] as MistralrsBackend[]
  )
  if (remote.length === 0) return ''

  const newestVersion = remote
    .map((b) => b.version)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
  const candidates = remote.filter((b) => b.version === newestVersion)
  candidates.sort(
    (a, b) => supported.indexOf(a.backend) - supported.indexOf(b.backend)
  )
  return `${candidates[0].version}/${candidates[0].backend}`
}

// ---------------------------------------------------------------------------
// Download & install
// ---------------------------------------------------------------------------

export async function downloadBackend(
  version: string,
  backend: string,
  downloadUrl: string
): Promise<string> {
  const backendDir = await getBackendDir(version, backend)
  if (!(await fs.existsSync(backendDir))) await fs.mkdir(backendDir)

  const archivePath = await joinPath([backendDir, assetNameFor(backend)])
  const taskId = `mistralrs-${version}-${backend}`.replace(
    /[^a-zA-Z0-9-]/g,
    '-'
  )
  const downloadType = 'Engine'

  const downloadManager = window.core.extensionManager.getByName(
    '@janhq/download-extension'
  )

  let downloadCompleted = false
  try {
    await downloadManager.downloadFiles(
      [{ url: downloadUrl, save_path: archivePath, model_id: taskId }],
      taskId,
      (transferred: number, total: number) => {
        downloadCompleted = transferred >= total
        events.emit(DownloadEvent.onFileDownloadUpdate, {
          modelId: taskId,
          percent: transferred / total,
          size: { transferred, total },
          downloadType,
        })
      }
    )

    if (!downloadCompleted) {
      events.emit(DownloadEvent.onFileDownloadStopped, {
        modelId: taskId,
        downloadType,
      })
      throw new Error('Download cancelled')
    }

    await invoke('decompress', { path: archivePath, outputDir: backendDir })
    await fs.rm(archivePath)

    const binaryPath = await joinPath([backendDir, MISTRALRS_BINARY_NAME])
    if (!(await fs.existsSync(binaryPath))) {
      throw new Error(
        'mistralrs-server binary not found in archive after extraction'
      )
    }

    events.emit(DownloadEvent.onFileDownloadSuccess, {
      modelId: taskId,
      downloadType,
    })
    return binaryPath
  } catch (e) {
    events.emit(DownloadEvent.onFileDownloadError, {
      modelId: taskId,
      downloadType,
    })
    if (await fs.existsSync(backendDir)) await fs.rm(backendDir)
    throw e
  }
}

/** Remove an installed backend from disk. */
export async function removeBackend(
  version: string,
  backend: string
): Promise<void> {
  const backendDir = await getBackendDir(version, backend)
  if (await fs.existsSync(backendDir)) await fs.rm(backendDir)
}

/**
 * Install from a local .tar.gz archive (sideload).
 * Returns the `<version>/<backend>` string of the installed build.
 */
export async function installFromArchive(
  archivePath: string
): Promise<{ version: string; backend: string }> {
  const filename = archivePath.split(/[/\\]/).pop() ?? ''
  // mistralrs-server-<backend>.tar.gz → backend; anything else → "custom"
  const backendMatch = filename.match(/^mistralrs-server-(.+)\.tar\.gz$/)
  const backend = backendMatch?.[1] ?? 'custom'
  const versionMatch = filename.match(/v\d+\.\d+[\.\d]*/)?.[0]
  const version = versionMatch ?? `local-${Date.now()}`

  const backendDir = await getBackendDir(version, backend)
  if (!(await fs.existsSync(backendDir))) await fs.mkdir(backendDir)

  await invoke('decompress', { path: archivePath, outputDir: backendDir })

  const binaryPath = await joinPath([backendDir, MISTRALRS_BINARY_NAME])
  if (!(await fs.existsSync(binaryPath))) {
    await fs.rm(backendDir)
    throw new Error('mistralrs-server binary not found in the provided archive')
  }

  return { version, backend }
}

// ---------------------------------------------------------------------------
// Dropdown option builder
// ---------------------------------------------------------------------------

export function buildDropdownOptions(
  backends: MistralrsBackend[],
  activeSelection: string
): { value: string; name: string }[] {
  const options = backends.map((b) => {
    const value = `${b.version}/${b.backend}`
    return {
      value,
      name: b.installed ? `${value} (installed)` : value,
    }
  })

  if (
    activeSelection &&
    activeSelection.includes('/') &&
    !options.some((o) => o.value === activeSelection)
  ) {
    options.unshift({
      value: activeSelection,
      name: `${activeSelection} (installed)`,
    })
  }

  return options
}
