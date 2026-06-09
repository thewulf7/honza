import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useDiscoverStore, type DiscoverEntry } from '@/hooks/useDiscoverStore'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  IconBolt,
  IconCheck,
  IconClock,
  IconDownload,
  IconLoader2,
  IconRefresh,
  IconSparkles,
} from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import type { CatalogModel } from '@/services/models/types'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.discover as any)({
  component: DiscoverContent,
})

// ── Types ─────────────────────────────────────────────────────────────────────

type SortKey = 'overall' | 'quality' | 'speed' | 'fit' | 'context' | 'tps'

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'overall', label: 'Overall' },
  { key: 'quality', label: 'Quality' },
  { key: 'speed', label: 'Speed' },
  { key: 'fit', label: 'Fit' },
  { key: 'context', label: 'Context' },
  { key: 'tps', label: 't/s' },
]

function sortValue(entry: DiscoverEntry, key: SortKey): number {
  const bd = entry.score.breakdown
  switch (key) {
    case 'overall': return entry.score.overall ?? 0
    case 'quality': return bd?.quality ?? 0
    case 'speed':   return bd?.speed ?? 0
    case 'fit':     return bd?.fit ?? 0
    case 'context': return bd?.context ?? 0
    case 'tps':     return entry.score.estimated_tps ?? 0
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fitLevelBg(level: string, active = false) {
  if (active) {
    switch (level) {
      case 'Perfect': return 'bg-green-600 text-white dark:bg-green-500'
      case 'Good':    return 'bg-blue-600 text-white dark:bg-blue-500'
      case 'Marginal':return 'bg-amber-600 text-white dark:bg-amber-500'
      default:        return 'bg-red-600 text-white dark:bg-red-500'
    }
  }
  switch (level) {
    case 'Perfect': return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'
    case 'Good':    return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400'
    case 'Marginal':return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
    default:        return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400'
  }
}

function fitLevelTextColor(level: string) {
  switch (level) {
    case 'Perfect': return 'text-green-600 dark:text-green-400'
    case 'Good':    return 'text-blue-600 dark:text-blue-400'
    case 'Marginal':return 'text-amber-600 dark:text-amber-400'
    default:        return 'text-red-600 dark:text-red-400'
  }
}

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ── Components ────────────────────────────────────────────────────────────────

function ScoreBar({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  const pct = Math.min(100, Math.max(0, Math.round(value)))
  const barColor = pct >= 70 ? 'bg-green-500' : pct >= 40 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={cn('w-14 shrink-0', highlight ? 'text-foreground font-medium' : 'text-muted-foreground')}>
        {label}
      </span>
      <div className="h-1.5 flex-1 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={cn('w-6 text-right tabular-nums', highlight ? 'text-foreground font-semibold' : '')}>
        {pct}
      </span>
    </div>
  )
}

function ModelCard({
  entry,
  isInstalled,
  sortKey,
  onDownload,
}: {
  entry: DiscoverEntry
  isInstalled: boolean
  sortKey: SortKey
  onDownload: (model: CatalogModel) => void
}) {
  const { model, score } = entry
  const bd = score.breakdown
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
            {bd?.use_case && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {bd.use_case}
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
                <IconBolt size={10} />{bd.run_mode}
              </span>
            )}
            {score.estimated_tps > 0 && (
              <span className={cn(sortKey === 'tps' && 'text-foreground font-semibold')}>
                ~{Math.round(score.estimated_tps)} t/s
              </span>
            )}
            {bd?.memory_required_gb != null && <span>{bd.memory_required_gb.toFixed(1)} GB</span>}
            {bd?.utilization_pct != null && <span>{Math.round(bd.utilization_pct)}% util</span>}
            {bd?.best_quant && <span className="font-mono">{bd.best_quant}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {score.overall != null && (
            <div className="text-right">
              <div className={`text-xl font-bold tabular-nums ${fitLevelTextColor(bd?.fit_level ?? '')}`}>
                {Math.round(sortValue(entry, sortKey))}
              </div>
              {sortKey !== 'overall' && (
                <div className="text-[10px] text-muted-foreground">{SORT_OPTIONS.find(o => o.key === sortKey)?.label}</div>
              )}
            </div>
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
          <ScoreBar label="Quality" value={bd.quality} highlight={sortKey === 'quality'} />
          <ScoreBar label="Speed"   value={bd.speed}   highlight={sortKey === 'speed'} />
          <ScoreBar label="Fit"     value={bd.fit}     highlight={sortKey === 'fit'} />
          <ScoreBar label="Context" value={bd.context} highlight={sortKey === 'context'} />
        </div>
      )}
    </div>
  )
}

function Chip({
  label,
  active,
  colorClass,
  onClick,
}: {
  label: string
  active: boolean
  colorClass?: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'text-xs px-2.5 py-1 rounded-full border font-medium transition-colors whitespace-nowrap',
        active
          ? colorClass ?? 'bg-foreground text-background border-foreground'
          : 'bg-background text-muted-foreground border-border hover:border-foreground/40 hover:text-foreground'
      )}
    >
      {label}
    </button>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

function DiscoverContent() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { providers } = useModelProvider()
  const { top20, phase, scored, total, cachedAt, scan } = useDiscoverStore()

  const [sortKey, setSortKey] = useState<SortKey>('overall')
  const [fitFilter, setFitFilter] = useState<string>('all')
  const [modeFilter, setModeFilter] = useState<string>('all')
  const [useCaseFilter, setUseCaseFilter] = useState<string>('all')

  const installedModelIds = new Set(
    (providers.find(p => p.provider === 'llamacpp')?.models ?? []).flatMap(m => {
      const lastSlash = m.id.lastIndexOf('/')
      return lastSlash >= 0 ? [m.id, m.id.slice(lastSlash + 1)] : [m.id]
    })
  )

  // Derive unique filter values from the result set
  const fitLevels = useMemo(
    () => [...new Set(top20.map(e => e.score.breakdown?.fit_level).filter(Boolean) as string[])],
    [top20]
  )
  const runModes = useMemo(
    () => [...new Set(top20.map(e => e.score.breakdown?.run_mode).filter(Boolean) as string[])],
    [top20]
  )
  const useCases = useMemo(
    () => [...new Set(top20.map(e => e.score.breakdown?.use_case).filter(Boolean) as string[])],
    [top20]
  )

  const filtered = useMemo(() => {
    let list = top20
    if (fitFilter !== 'all') list = list.filter(e => e.score.breakdown?.fit_level === fitFilter)
    if (modeFilter !== 'all') list = list.filter(e => e.score.breakdown?.run_mode === modeFilter)
    if (useCaseFilter !== 'all') list = list.filter(e => e.score.breakdown?.use_case === useCaseFilter)
    return [...list].sort((a, b) => sortValue(b, sortKey) - sortValue(a, sortKey))
  }, [top20, fitFilter, modeFilter, useCaseFilter, sortKey])

  const handleDownload = (model: CatalogModel) => {
    navigate({ to: route.hub.model, params: { modelId: model.model_name } })
  }

  const progressPct = total > 0 ? Math.round((scored / total) * 100) : 0
  const isScanning = phase === 'scanning'
  const cacheAge = cachedAt ? Date.now() - cachedAt : null

  return (
    <div className="flex flex-col h-svh w-full">
      <div className="flex flex-col h-full w-full rounded-xl border bg-white dark:bg-neutral-900/50 dark:border-neutral-700">
        <HeaderPage>
          <div className="pr-3 py-3 h-10 w-full flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <IconSparkles size={16} className="text-muted-foreground shrink-0" />
              <span className="font-medium text-sm">{t('common:discover')}</span>
              {cacheAge !== null && !isScanning && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <IconClock size={11} />
                  {formatAge(cacheAge)}
                </span>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => scan()}
              disabled={isScanning}
              className="gap-1.5 shrink-0"
            >
              {isScanning ? (
                <>
                  <IconLoader2 size={14} className="animate-spin" />
                  {total > 0 ? `${scored}/${total}` : 'Scanning…'}
                </>
              ) : (
                <>
                  <IconRefresh size={14} />
                  Rescan
                </>
              )}
            </Button>
          </div>
        </HeaderPage>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="flex flex-col gap-4 w-full xl:w-4/6 mx-auto">

            {/* Progress bar */}
            {isScanning && total > 0 && (
              <div className="space-y-1">
                <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">Scored {scored} of {total} models…</p>
              </div>
            )}

            {/* Filters — shown once we have data */}
            {top20.length > 0 && (
              <div className="space-y-2 pb-1">
                {/* Sort */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-muted-foreground shrink-0 w-10">Sort:</span>
                  {SORT_OPTIONS.map(o => (
                    <Chip
                      key={o.key}
                      label={o.label}
                      active={sortKey === o.key}
                      onClick={() => setSortKey(o.key)}
                    />
                  ))}
                </div>

                {/* Fit Level */}
                {fitLevels.length > 1 && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted-foreground shrink-0 w-10">Fit:</span>
                    <Chip label="All" active={fitFilter === 'all'} onClick={() => setFitFilter('all')} />
                    {fitLevels.map(level => (
                      <Chip
                        key={level}
                        label={level}
                        active={fitFilter === level}
                        colorClass={fitLevelBg(level, true)}
                        onClick={() => setFitFilter(fitFilter === level ? 'all' : level)}
                      />
                    ))}
                  </div>
                )}

                {/* Run Mode */}
                {runModes.length > 1 && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted-foreground shrink-0 w-10">Mode:</span>
                    <Chip label="All" active={modeFilter === 'all'} onClick={() => setModeFilter('all')} />
                    {runModes.map(mode => (
                      <Chip
                        key={mode}
                        label={mode}
                        active={modeFilter === mode}
                        onClick={() => setModeFilter(modeFilter === mode ? 'all' : mode)}
                      />
                    ))}
                  </div>
                )}

                {/* Use Case */}
                {useCases.length > 1 && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted-foreground shrink-0 w-10">Use:</span>
                    <Chip label="All" active={useCaseFilter === 'all'} onClick={() => setUseCaseFilter('all')} />
                    {useCases.map(uc => (
                      <Chip
                        key={uc}
                        label={uc}
                        active={useCaseFilter === uc}
                        onClick={() => setUseCaseFilter(useCaseFilter === uc ? 'all' : uc)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Results */}
            {filtered.length > 0 && (
              <div className="space-y-3">
                {filtered.map(entry => (
                  <ModelCard
                    key={entry.model.model_name}
                    entry={entry}
                    isInstalled={entry.variant ? installedModelIds.has(entry.variant.model_id) : false}
                    sortKey={sortKey}
                    onDownload={handleDownload}
                  />
                ))}
              </div>
            )}

            {/* Empty states */}
            {phase === 'idle' && top20.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
                <IconSparkles size={40} className="text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground max-w-xs">
                  Scanning catalog against your hardware in the background…
                </p>
              </div>
            )}
            {isScanning && top20.length === 0 && (
              <div className="flex items-center justify-center py-20 gap-2 text-sm text-muted-foreground">
                <IconLoader2 size={16} className="animate-spin" />
                Scoring models for your hardware…
              </div>
            )}
            {phase === 'done' && filtered.length === 0 && top20.length > 0 && (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No models match the current filters.
              </p>
            )}
            {phase === 'done' && top20.length === 0 && (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No models could be scored. Check your internet connection and try rescanning.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
