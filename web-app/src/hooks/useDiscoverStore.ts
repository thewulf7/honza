import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { localStorageKey, CACHE_EXPIRY_MS } from '@/constants/localStorage'
import { getServiceHub } from '@/hooks/useServiceHub'
import { selectBestGgufVariant } from '@/lib/modelQuantization'
import type { CatalogModel, ModelQuant, ModelScore } from '@/services/models/types'

export interface DiscoverEntry {
  model: CatalogModel
  variant: ModelQuant | undefined
  score: ModelScore
}

type ScanPhase = 'idle' | 'scanning' | 'done'

interface DiscoverState {
  top20: DiscoverEntry[]
  phase: ScanPhase
  scored: number
  total: number
  cachedAt: number | null
  hwFingerprint: string | null

  scan(): Promise<void>
  initIfStale(): void
}

const TOP_N = 20
const BATCH = 8

export const useDiscoverStore = create<DiscoverState>()(
  persist(
    (set, get) => ({
      top20: [],
      phase: 'idle',
      scored: 0,
      total: 0,
      cachedAt: null,
      hwFingerprint: null,

      scan: async () => {
        if (get().phase === 'scanning') return
        set({ phase: 'scanning', scored: 0, total: 0 })

        try {
          const serviceHub = getServiceHub()
          const catalog = await serviceHub.models().fetchModelCatalog()
          const scoreable = catalog.filter(m => (m.quants?.length ?? 0) > 0)
          set({ total: scoreable.length })

          const acc: DiscoverEntry[] = []
          let hwFp: string | null = null

          for (let i = 0; i < scoreable.length; i += BATCH) {
            const batch = scoreable.slice(i, i + BATCH)
            const batchResults = await Promise.all(
              batch.map(async model => {
                try {
                  const variant = selectBestGgufVariant(model.quants)
                  const score = await serviceHub.models().getHubModelScore(model, variant)
                  if (!hwFp && score.hardware_fingerprint) hwFp = score.hardware_fingerprint
                  return { model, variant, score } satisfies DiscoverEntry
                } catch {
                  return null
                } finally {
                  set(s => ({ scored: s.scored + 1 }))
                }
              })
            )

            for (const r of batchResults) {
              if (r && r.score.status === 'ready' && (r.score.overall ?? 0) > 0) {
                acc.push(r)
              }
            }
          }

          const top20 = acc
            .sort((a, b) => (b.score.overall ?? 0) - (a.score.overall ?? 0))
            .slice(0, TOP_N)

          set({ top20, cachedAt: Date.now(), hwFingerprint: hwFp })
        } catch (e) {
          console.error('[Discover] catalog scan failed', e)
        }

        set({ phase: 'done' })
      },

      initIfStale: () => {
        const { phase, cachedAt, top20, hwFingerprint, scan } = get()
        if (phase === 'scanning') return
        const age = cachedAt ? Date.now() - cachedAt : Infinity
        const stale = age > CACHE_EXPIRY_MS || top20.length === 0

        if (stale) {
          scan()
          return
        }

        // Also rescan if hardware fingerprint changed
        try {
          const serviceHub = getServiceHub()
          serviceHub.models().getHubModelScore(
            // score a tiny sentinel to get the current fingerprint
            { model_name: '__fp__', description: '', downloads: 0 },
            undefined
          ).then(s => {
            if (s.hardware_fingerprint && hwFingerprint && s.hardware_fingerprint !== hwFingerprint) {
              scan()
            }
          }).catch(() => {/* ignore – fingerprint check is best-effort */})
        } catch { /* getServiceHub might not be ready yet */ }

        // Cache is fresh — just mark done so the UI shows results
        if (phase === 'idle') set({ phase: 'done' })
      },
    }),
    {
      name: localStorageKey.discoverCache,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        top20: state.top20,
        cachedAt: state.cachedAt,
        hwFingerprint: state.hwFingerprint,
      }),
    }
  )
)
