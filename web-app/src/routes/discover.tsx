import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useHardware } from '@/hooks/useHardware'
import { useModelProvider } from '@/hooks/useModelProvider'
import { selectBestGgufVariant } from '@/lib/modelQuantization'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  IconCheck,
  IconCpu,
  IconDownload,
  IconLoader2,
  IconSparkles,
  IconZip,
} from '@tabler/icons-react'
import { useCallback, useState } from 'react'
import type { CatalogModel, ModelQuant, ModelScore } from '@/services/models/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.discover as any)({
  component: DiscoverContent,
})

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase = 'idle' | 'scanning' | 'done'

interface ScoredModel {
  model: CatalogModel
  variant: ModelQuant | undefined
  score: ModelScore
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fitLevelColor(level: string) {
  switch (level) {
    case 'Perfect': return 'text-green-600 dark:text-green-400'
    case 'Good': return 'text-blue-600 dark:text-blue-400'
    case 'Marginal': return 'text-amber-600 dark:text-amber-400'
    default: return 'text-red-600 dark:text-red-400'
  }
}

function fitLevelBg(level: string) {
  switch (level) {
    case 'Perfect': return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'
    case 'Good': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400'
    case 'Marginal': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
    default: return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400'
  }
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  const pct = Math.min(100, Math.max(0, Math.round(value)))
  const barColor = pct >= 70 ? 'bg-green-500' : pct >= 40 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-6 text-right tabular-nums">{pct}</span>
    </div>
  )
}

function CatalogModelCard({
  item,
  installedModelIds,
  onDownload,
}: {
  item: ScoredModel
  installedModelIds: Set<string>
  onDownload: (model: CatalogModel) => void
}) {
  const { model, variant, score } = item
  const bd = score.breakdown
  const isInstalled = variant ? installedModelIds.has(variant.model_id) : false
  const displayName = model.display_name ?? model.model_name.split('/').pop() ?? model.model_name

  return (
    <div className="rounded-lg border bg-background p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold truncate">{displayName}</span>
            {model.developer && (
              <span className="text-xs text-muted-foreground">{model.developer}</span>
            )}
            {bd?.fit_level && (
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${fitLevelBg(bd.fit_level)}`}>
                {bd.fit_level}
              </span>
            )}
            {isInstalled && (
              <span className="flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                <IconCheck size={10} /> installed
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
            {bd?.run_mode && (
              <span className="flex items-center gap-1">
                <IconZip size={10} />{bd.run_mode}
              </span>
            )}
            {score.estimated_tps > 0 && <span>~{Math.round(score.estimated_tps)} t/s</span>}
            {bd?.memory_required_gb != null && <span>{bd.memory_required_gb.toFixed(1)} GB</span>}
            {bd?.best_quant && <span className="font-mono">{bd.best_quant}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {score.overall != null && (
            <span className={`text-xl font-bold tabular-nums ${fitLevelColor(bd?.fit_level ?? '')}`}>
              {Math.round(score.overall)}
            </span>
          )}
          {!isInstalled && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() => onDownload(model)}
            >
              <IconDownload size={12} />
              Download
            </Button>
          )}
        </div>
      </div>

      {bd && (
        <div className="space-y-1.5">
          <ScoreBar label="Quality" value={bd.quality} />
          <ScoreBar label="Speed" value={bd.speed} />
          <ScoreBar label="Fit" value={bd.fit} />
          <ScoreBar label="Context" value={bd.context} />
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

function DiscoverContent() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const navigate = useNavigate()
  const { providers } = useModelProvider()
  const { hardwareData } = useHardware()

  const [phase, setPhase] = useState<Phase>('idle')
  const [scored, setScored] = useState(0)
  const [total, setTotal] = useState(0)
  const [results, setResults] = useState<ScoredModel[]>([])

  const installedModelIds = new Set(
    (providers.find(p => p.provider === 'llamacpp')?.models ?? []).flatMap(m => {
      const lastSlash = m.id.lastIndexOf('/')
      return lastSlash >= 0 ? [m.id, m.id.slice(lastSlash + 1)] : [m.id]
    })
  )

  const runScan = useCallback(async () => {
    setPhase('scanning')
    setScored(0)
    setTotal(0)
    setResults([])
    try {
      const catalog = await serviceHub.models().fetchModelCatalog()
      const scoreable = catalog.filter(m => (m.quants?.length ?? 0) > 0)
      setTotal(scoreable.length)

      const acc: ScoredModel[] = []
      const BATCH = 8
      for (let i = 0; i < scoreable.length; i += BATCH) {
        const batch = scoreable.slice(i, i + BATCH)
        const batchResults = await Promise.all(
          batch.map(async model => {
            try {
              const variant = selectBestGgufVariant(model.quants)
              const score = await serviceHub.models().getHubModelScore(model, variant)
              return { model, variant, score } satisfies ScoredModel
            } catch {
              return null
            } finally {
              setScored(n => n + 1)
            }
          })
        )
        for (const r of batchResults) {
          if (r && r.score.status === 'ready' && (r.score.overall ?? 0) > 0) {
            acc.push(r)
            setResults([...acc].sort((a, b) => (b.score.overall ?? 0) - (a.score.overall ?? 0)))
          }
        }
      }
    } catch (e) {
      console.error('Catalog scan failed', e)
    }
    setPhase('done')
  }, [serviceHub])

  const handleDownload = useCallback(
    (model: CatalogModel) => {
      navigate({ to: route.hub.model, params: { modelId: model.model_name } })
    },
    [navigate]
  )

  const progressPct = total > 0 ? Math.round((scored / total) * 100) : 0

  const gpuLabel = hardwareData.gpus?.length > 0
    ? `${hardwareData.gpus[0].name}${hardwareData.gpus[0].total_memory ? ' · ' + Math.round(hardwareData.gpus[0].total_memory / 1024) + ' GB VRAM' : ''}`
    : null
  const cpuLabel = hardwareData.cpu?.name
    ? `${hardwareData.cpu.name}${hardwareData.cpu.core_count ? ' · ' + hardwareData.cpu.core_count + ' cores' : ''}`
    : null
  const ramLabel = hardwareData.total_memory
    ? `${Math.round(hardwareData.total_memory / 1024)} GB RAM`
    : null

  return (
    <div className="flex flex-col h-svh w-full">
      <div className="flex flex-col h-full w-full rounded-xl border bg-white dark:bg-neutral-900/50 dark:border-neutral-700">
        <HeaderPage>
          <div className="pr-3 py-3 h-10 w-full flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <IconSparkles size={16} className="text-muted-foreground shrink-0" />
              <span className="font-medium text-sm">{t('common:discover')}</span>
            </div>
            <Button
              size="sm"
              onClick={runScan}
              disabled={phase === 'scanning'}
              className="gap-1.5 shrink-0"
            >
              {phase === 'scanning' ? (
                <>
                  <IconLoader2 size={14} className="animate-spin" />
                  {total > 0 ? `${scored}/${total}` : 'Scanning…'}
                </>
              ) : (
                <>
                  <IconSparkles size={14} />
                  {phase === 'done' ? 'Re-scan' : 'Scan for me'}
                </>
              )}
            </Button>
          </div>
        </HeaderPage>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="flex flex-col gap-4 w-full xl:w-4/6 mx-auto">

            {/* Hardware context */}
            {(gpuLabel || cpuLabel || ramLabel) && (
              <div className="flex items-center gap-2 flex-wrap">
                {gpuLabel && (
                  <div className="flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs text-muted-foreground">
                    <IconZip size={11} />{gpuLabel}
                  </div>
                )}
                {cpuLabel && (
                  <div className="flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs text-muted-foreground">
                    <IconCpu size={11} />{cpuLabel}
                  </div>
                )}
                {ramLabel && (
                  <div className="flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs text-muted-foreground">
                    {ramLabel}
                  </div>
                )}
              </div>
            )}

            {/* Progress bar */}
            {phase === 'scanning' && total > 0 && (
              <div className="space-y-1">
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Scored {scored} of {total} models…
                </p>
              </div>
            )}

            {/* Results */}
            {results.length > 0 && (
              <div className="space-y-3">
                {results.map(item => (
                  <CatalogModelCard
                    key={item.model.model_name}
                    item={item}
                    installedModelIds={installedModelIds}
                    onDownload={handleDownload}
                  />
                ))}
              </div>
            )}

            {/* Empty states */}
            {phase === 'idle' && (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
                <IconSparkles size={40} className="text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground max-w-xs">
                  Scan your hardware to discover which catalog models fit best — scored by quality, speed, and memory fit.
                </p>
              </div>
            )}
            {phase === 'done' && results.length === 0 && (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No models could be scored. Check your internet connection.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
