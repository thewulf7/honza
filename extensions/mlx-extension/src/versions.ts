import { getJanDataFolderPath, fs, joinPath, events, DownloadEvent } from '@janhq/core'
import { invoke } from '@tauri-apps/api/core'
import { setMlxCustomBinaryPath } from '@janhq/tauri-plugin-mlx-api'

export interface MlxRelease {
  version: string
  downloadUrl: string
  installed: boolean
}

export const BUNDLED_VERSION = 'bundled'

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export async function getVersionsDir(): Promise<string> {
  const janData = await getJanDataFolderPath()
  return joinPath([janData, 'mlx', 'versions'])
}

export async function getVersionBinaryPath(version: string): Promise<string> {
  const versionsDir = await getVersionsDir()
  return joinPath([versionsDir, version, 'mlx-server'])
}

// ---------------------------------------------------------------------------
// Querying installed / remote versions
// ---------------------------------------------------------------------------

export async function getInstalledVersions(): Promise<string[]> {
  const versionsDir = await getVersionsDir()
  if (!(await fs.existsSync(versionsDir))) return []

  const entries = await fs.readdirSync(versionsDir)
  const installed: string[] = []
  for (const entry of entries) {
    const binary = await joinPath([versionsDir, String(entry), 'mlx-server'])
    if (await fs.existsSync(binary)) installed.push(String(entry))
  }
  return installed
}

export async function fetchRemoteReleases(): Promise<MlxRelease[]> {
  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=20`
  )
  if (!response.ok) {
    console.warn(`[MLX] GitHub API responded ${response.status}`)
    return []
  }

  const releases = (await response.json()) as any[]
  return releases
    .filter((r: any) => !r.prerelease && !r.draft)
    .filter((r: any) => r.assets?.some((a: any) => a.name === MLX_ASSET_NAME))
    .map((r: any) => ({
      version: r.tag_name as string,
      downloadUrl: r.assets.find((a: any) => a.name === MLX_ASSET_NAME)
        ?.browser_download_url as string,
      installed: false,
    }))
}

/** Merges remote releases with locally installed versions. */
export async function listAllVersions(): Promise<MlxRelease[]> {
  const [remote, installed] = await Promise.all([
    fetchRemoteReleases().catch(() => [] as MlxRelease[]),
    getInstalledVersions(),
  ])

  const installedSet = new Set(installed)

  const remoteWithState = remote.map((r) => ({
    ...r,
    installed: installedSet.has(r.version),
  }))

  // Local-only versions (manually installed / not on current remote release list)
  const remoteVersionSet = new Set(remote.map((r) => r.version))
  const localOnly: MlxRelease[] = installed
    .filter((v) => !remoteVersionSet.has(v))
    .map((v) => ({ version: v, downloadUrl: '', installed: true }))

  return [...remoteWithState, ...localOnly]
}

// ---------------------------------------------------------------------------
// Download & activation
// ---------------------------------------------------------------------------

export async function downloadVersion(
  version: string,
  downloadUrl: string
): Promise<string> {
  const versionsDir = await getVersionsDir()
  const versionDir = await joinPath([versionsDir, version])
  if (!(await fs.existsSync(versionDir))) await fs.mkdir(versionDir)

  const archivePath = await joinPath([versionDir, MLX_ASSET_NAME])
  const taskId = `mlx-server-${version}`.replace(/[^a-zA-Z0-9-]/g, '-')

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
          downloadType: 'Engine',
        })
      }
    )

    if (!downloadCompleted) {
      events.emit(DownloadEvent.onFileDownloadStopped, {
        modelId: taskId,
        downloadType: 'Engine',
      })
      throw new Error('Download cancelled')
    }

    await invoke('decompress', { path: archivePath, outputDir: versionDir })
    await fs.rm(archivePath)

    const binaryPath = await joinPath([versionDir, 'mlx-server'])
    if (!(await fs.existsSync(binaryPath))) {
      throw new Error('mlx-server binary not found in archive after extraction')
    }

    events.emit(DownloadEvent.onFileDownloadSuccess, {
      modelId: taskId,
      downloadType: 'Engine',
    })
    return binaryPath
  } catch (e) {
    events.emit(DownloadEvent.onFileDownloadError, {
      modelId: taskId,
      downloadType: 'Engine',
    })
    // Clean up partial download directory
    if (await fs.existsSync(versionDir)) await fs.rm(versionDir)
    throw e
  }
}

/** Switch the active binary to the given installed version. */
export async function activateVersion(version: string): Promise<void> {
  const binaryPath = await getVersionBinaryPath(version)
  if (!(await fs.existsSync(binaryPath))) {
    throw new Error(`Version ${version} is not installed`)
  }
  await setMlxCustomBinaryPath(binaryPath)
}

/** Remove an installed version from disk. */
export async function removeVersion(version: string): Promise<void> {
  const versionsDir = await getVersionsDir()
  const versionDir = await joinPath([versionsDir, version])
  if (await fs.existsSync(versionDir)) await fs.rm(versionDir)
}

/**
 * Install from a local .tar.gz archive.
 * The version label is derived from the filename, falling back to a timestamp.
 */
export async function installFromArchive(
  archivePath: string
): Promise<{ version: string; binaryPath: string }> {
  const versionsDir = await getVersionsDir()

  // Try to parse a version tag from the filename (e.g. mlx-server-v0.1.0-arm64.tar.gz)
  const filename = archivePath.split('/').pop() ?? ''
  const tagMatch = filename.match(/v\d+\.\d+[\.\d]*/)?.[0]
  const version = tagMatch ?? `custom-${Date.now()}`

  const versionDir = await joinPath([versionsDir, version])
  if (!(await fs.existsSync(versionDir))) await fs.mkdir(versionDir)

  await invoke('decompress', { path: archivePath, outputDir: versionDir })

  const binaryPath = await joinPath([versionDir, 'mlx-server'])
  if (!(await fs.existsSync(binaryPath))) {
    throw new Error('mlx-server binary not found in the provided archive')
  }

  return { version, binaryPath }
}

// ---------------------------------------------------------------------------
// Dropdown option builders
// ---------------------------------------------------------------------------

export function buildDropdownOptions(
  releases: MlxRelease[],
  activeVersion: string
): { value: string; name: string }[] {
  const options = releases.map((r) => ({
    value: r.version,
    name: r.installed
      ? `${r.version} (installed)`
      : `${r.version} — click to download`,
  }))

  // Always include the bundled fallback
  options.push({ value: BUNDLED_VERSION, name: 'Bundled (app default)' })

  // If the active version isn't in the list (e.g., a custom install), prepend it
  if (activeVersion && !options.some((o) => o.value === activeVersion)) {
    options.unshift({ value: activeVersion, name: `${activeVersion} (installed)` })
  }

  return options
}
