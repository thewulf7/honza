import { describe, it, expect, vi, beforeEach } from 'vitest'

const writtenFiles: Record<string, string> = {}
const modelYamls: Record<string, unknown> = {}

vi.mock('@janhq/core', () => ({
  fs: {
    existsSync: vi.fn(async (p: string) => p === '/p/models' || p in modelYamls),
    mkdir: vi.fn(async () => undefined),
    readdirSync: vi.fn(async (dir: string) => {
      const prefix = `${dir}/`
      const children = new Set<string>()

      for (const key of Object.keys(modelYamls)) {
        if (!key.startsWith(prefix)) continue
        const remainder = key.slice(prefix.length)
        const next = remainder.split('/')[0]
        if (next.length > 0) children.add(next)
      }

      return Array.from(children)
    }),
    fileStat: vi.fn(async (p: string) => ({
      isDirectory:
        !p.endsWith('model.yml') &&
        Object.keys(modelYamls).some((key) => key.startsWith(`${p}/`)),
    })),
    writeFileSync: vi.fn(async (p: string, body: string) => {
      writtenFiles[p] = body
    }),
    mv: vi.fn(async (from: string, to: string) => {
      writtenFiles[to] = writtenFiles[from]
      delete writtenFiles[from]
    }),
    rm: vi.fn(async () => undefined),
  },
  joinPath: vi.fn(async (parts: string[]) => parts.join('/')),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (_cmd: string, args: { path: string }) => modelYamls[args.path]),
}))

import { generatePreset } from './preset'

const CONFIG = {} as any

beforeEach(() => {
  for (const k of Object.keys(writtenFiles)) delete writtenFiles[k]
  for (const k of Object.keys(modelYamls)) delete modelYamls[k]
})

function setupModel(id: string, yaml: Record<string, unknown>) {
  modelYamls[`/p/models/${id}/model.yml`] = {
    model_path: `models/${id}/model.gguf`,
    ...yaml,
  }
}

describe('generatePreset MTP emission', () => {
  it('emits cpu-moe settings for router-visible config and per-model overrides', async () => {
    setupModel('glm', {
      cpu_moe: false,
      n_cpu_moe: 2,
    })

    await generatePreset(
      '/p',
      '/jan',
      { cpu_moe: true, n_cpu_moe: 4 } as any,
      { supportsMtp: true }
    )

    const ini = writtenFiles['/p/router.preset.ini']
    expect(ini).toContain('[*]')
    expect(ini).toContain('cpu-moe = true')
    expect(ini).toContain('n-cpu-moe = 4')
    expect(ini).toContain('[glm]')
    expect(ini).toContain('cpu-moe = false')
    expect(ini).toContain('n-cpu-moe = 2')
  })

  it('walks nested model directories when building the preset', async () => {
    setupModel('org/glm', {
      cpu_moe: true,
      n_cpu_moe: 3,
    })

    await generatePreset('/p', '/jan', CONFIG, { supportsMtp: true })

    const ini = writtenFiles['/p/router.preset.ini']
    expect(ini).toContain('[org/glm]')
    expect(ini).toContain('model = /jan/models/org/glm/model.gguf')
    expect(ini).toContain('cpu-moe = true')
    expect(ini).toContain('n-cpu-moe = 3')
  })

  it('emits spec-type = draft-mtp when mtp is on, layers > 0, and backend supports it', async () => {
    setupModel('glm', {
      mtp: true,
      mtp_layers: 1,
      spec_draft_n_max: 8,
      spec_draft_n_min: 0,
      spec_draft_p_min: 0.8,
      spec_draft_p_split: 0.1,
    })
    await generatePreset('/p', '/jan', CONFIG, { supportsMtp: true })
    const ini = writtenFiles['/p/router.preset.ini']
    expect(ini).toContain('spec-type = draft-mtp')
    expect(ini).toContain('spec-draft-n-max = 8')
    expect(ini).toContain('spec-draft-n-min = 0')
    expect(ini).toContain('spec-draft-p-min = 0.8')
    expect(ini).toContain('spec-draft-p-split = 0.1')
  })

  it('emits spec-draft-p-split when within valid range', async () => {
    setupModel('glm', {
      mtp: true,
      mtp_layers: 1,
      spec_draft_p_split: 0.25,
    })
    await generatePreset('/p', '/jan', CONFIG, { supportsMtp: true })
    const ini = writtenFiles['/p/router.preset.ini']
    expect(ini).toContain('spec-draft-p-split = 0.25')
  })

  it('omits MTP lines when backend does not support MTP', async () => {
    setupModel('glm', { mtp: true, mtp_layers: 1, spec_draft_n_max: 8 })
    await generatePreset('/p', '/jan', CONFIG, { supportsMtp: false })
    const ini = writtenFiles['/p/router.preset.ini']
    expect(ini).not.toContain('spec-type')
    expect(ini).not.toContain('spec-draft')
  })

  it('omits MTP lines when model has no MTP heads (mtp_layers = 0)', async () => {
    setupModel('llama', { mtp: true, mtp_layers: 0 })
    await generatePreset('/p', '/jan', CONFIG, { supportsMtp: true })
    const ini = writtenFiles['/p/router.preset.ini']
    expect(ini).not.toContain('spec-type')
  })

  it('omits MTP lines when mtp flag is off even if heads exist', async () => {
    setupModel('glm', { mtp: false, mtp_layers: 1 })
    await generatePreset('/p', '/jan', CONFIG, { supportsMtp: true })
    const ini = writtenFiles['/p/router.preset.ini']
    expect(ini).not.toContain('spec-type')
  })

  it('skips out-of-range spec tunables', async () => {
    setupModel('glm', {
      mtp: true,
      mtp_layers: 1,
      spec_draft_n_max: -5,
      spec_draft_p_min: 1.5,
      spec_draft_p_split: 2.0,
    })
    await generatePreset('/p', '/jan', CONFIG, { supportsMtp: true })
    const ini = writtenFiles['/p/router.preset.ini']
    expect(ini).toContain('spec-type = draft-mtp')
    expect(ini).not.toContain('spec-draft-n-max')
    expect(ini).not.toContain('spec-draft-p-min')
    expect(ini).not.toContain('spec-draft-p-split')
  })
})
