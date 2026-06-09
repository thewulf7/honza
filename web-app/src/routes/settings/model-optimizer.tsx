import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import SettingsIntegrationPage from '@/containers/SettingsIntegrationPage'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useHardware } from '@/hooks/useHardware'
import { selectBestGgufVariant } from '@/lib/modelQuantization'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconCpu,
  IconDownload,
  IconInfoCircle,
  IconLoader2,
  IconSparkles,
  IconWand,
  IconZip,
} from '@tabler/icons-react'
import { useCallback, useRef, useState } from 'react'
import type { CatalogModel, ModelQuant, ModelScore, ConfigAnalysis, AdvisorSuggestion } from '@/services/models/types'
import { getModelDisplayName } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.model_optimizer as any)({
  component: ModelOptimizerContent,
})

// ── Types ────────────────────────────────────────────────────────────────────

type Phase = 'idle' | 'scanning' | 'done'

interface ScoredModel {
  model: CatalogModel
  variant: ModelQuant | undefined
  score: ModelScore
}

interface InstalledResult {
  modelId: string
  displayName: string
  analysis: ConfigAnalysis | null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function severityBg(s: AdvisorSuggestion['severity']) {
  switch (s) {
    case 'improvement': return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'
    case 'warning': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
    case 'info': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400'
  }
}

function formatVal(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return 'default'
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  return String(v)
}

// ── Sub-components ────────────────────────────────────────────────────────────

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
  onViewInHub,
}: {
  item: ScoredModel
  installedModelIds: Set<string>
  onViewInHub: (model: CatalogModel) => void
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
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                installed
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
            {bd?.run_mode && <span className="flex items-center gap-1"><IconZip size={10} />{bd.run_mode}</span>}
            {score.estimated_tps > 0 && <span>~{Math.round(score.estimated_tps)} t/s</span>}
            {bd?.memory_required_gb != null && <span>{bd.memory_required_gb.toFixed(1)}GB</span>}
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
              onClick={() => onViewInHub(model)}
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

function InstalledModelCard({
  result,
  onApply,
  onApplyAll,
}: {
  result: InstalledResult
  onApply: (modelId: string, yamlKey: string, value: string | number | boolean) => Promise<void>
  onApplyAll: (modelId: string, analysis: ConfigAnalysis) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(true)
  const [applied, setApplied] = useState<Set<string>>(new Set())
  const [applyingAll, setApplyingAll] = useState(false)
  const [explaining, setExplaining] = useState(false)
  const [explanation, setExplanation] = useState('')
  const [showExplanation, setShowExplanation] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const { analysis } = result

  if (!analysis) {
    return (
      <div className="rounded-lg border bg-background p-4">
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm">{result.displayName}</span>
          <span className="text-xs text-muted-foreground">Could not read config</span>
        </div>
      </div>
    )
  }

  const applySuggestions = analysis.suggestions.filter(
    s => s.canApply && s.suggestedValue !== null && !applied.has(s.yamlKey)
  )
  const hasSuggestions = analysis.suggestions.length > 0

  const handleApplySingle = async (s: AdvisorSuggestion) => {
    if (s.suggestedValue === null) return
    await onApply(result.modelId, s.yamlKey, s.suggestedValue as string | number | boolean)
    setApplied(prev => new Set([...prev, s.yamlKey]))
  }

  const handleApplyAll = async () => {
    setApplyingAll(true)
    try {
      await onApplyAll(result.modelId, analysis)
      setApplied(prev => {
        const next = new Set(prev)
        for (const s of applySuggestions) next.add(s.yamlKey)
        return next
      })
    } finally {
      setApplyingAll(false)
    }
  }

  const handleExplain = async () => {
    if (!analysis.routerPort) return
    if (abortRef.current) abortRef.current.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setExplaining(true)
    setExplanation('')
    setShowExplanation(true)

    const applicable = analysis.suggestions.filter(s => s.canApply)
    const hwDesc = [
      analysis.hardware.hasGpu && analysis.hardware.gpus[0]
        ? `GPU: ${analysis.hardware.gpus[0].name} (${analysis.hardware.gpus[0].vramMB}MB VRAM)`
        : 'CPU only',
      `CPU: ${analysis.hardware.cpuName} (${analysis.hardware.cpuCores} cores)`,
    ].join(', ')
    const changeList = applicable
      .map(s => `• ${s.displayName}: ${formatVal(s.currentValue)} → ${formatVal(s.suggestedValue)}`)
      .join('\n')
    const prompt = `You are a llama.cpp performance advisor. Briefly explain (2–4 sentences) why these config changes improve inference on this hardware. Be concise.

Hardware: ${hwDesc}
Model: ${result.displayName} (${analysis.model.quantName}, ${analysis.model.fileSizeMB}MB)

Suggested changes:
${changeList}

Explain:`

    try {
      const res = await fetch(`http://localhost:${analysis.routerPort}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(analysis.routerApiKey ? { Authorization: `Bearer ${analysis.routerApiKey}` } : {}),
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], stream: true, max_tokens: 350, temperature: 0.3 }),
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) { setExplanation('Could not reach the inference endpoint. Load a model first.'); return }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      outer: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of decoder.decode(value, { stream: true }).split('\n')) {
          const t = line.trim()
          if (!t.startsWith('data: ')) continue
          const payload = t.slice(6)
          if (payload === '[DONE]') break outer
          try {
            const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> }
            const c = chunk.choices?.[0]?.delta?.content ?? ''
            if (c) setExplanation(prev => prev + c)
          } catch { /* skip */ }
        }
      }
    } catch (e: unknown) {
      if ((e as { name?: string })?.name !== 'AbortError') setExplanation('Failed to get AI explanation.')
    } finally {
      setExplaining(false)
    }
  }

  return (
    <div className="rounded-lg border bg-background p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">{result.displayName}</span>
          <span className="text-xs text-muted-foreground font-mono">{analysis.model.quantName} · {analysis.model.fileSizeMB}MB</span>
          {!hasSuggestions && (
            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <IconCheck size={12} /> Optimal
            </span>
          )}
        </div>
        {hasSuggestions && (
          <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setExpanded(v => !v)}>
            {expanded ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
            {analysis.suggestions.length} suggestion{analysis.suggestions.length !== 1 ? 's' : ''}
          </button>
        )}
      </div>

      {expanded && hasSuggestions && (
        <div className="space-y-2">
          {analysis.suggestions.map(s => {
            const isApplied = applied.has(s.yamlKey)
            return (
              <div key={s.yamlKey} className="flex items-start gap-3 rounded border bg-muted/30 px-3 py-2">
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{s.displayName}</span>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${severityBg(s.severity)}`}>{s.severity}</span>
                    {isApplied && (
                      <span className="flex items-center gap-0.5 text-[10px] text-green-600 dark:text-green-400">
                        <IconCheck size={10} /> applied
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <span className="font-mono">{formatVal(s.currentValue)}</span>
                    {s.suggestedValue !== null && (
                      <>
                        <span>→</span>
                        <span className="font-mono font-semibold text-foreground">{formatVal(s.suggestedValue)}</span>
                      </>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground leading-normal">{s.reason}</p>
                </div>
                {s.canApply && !isApplied && s.suggestedValue !== null ? (
                  <Button variant="outline" size="sm" className="shrink-0 h-7 text-xs" onClick={() => handleApplySingle(s)}>
                    Apply
                  </Button>
                ) : !s.canApply ? (
                  <IconInfoCircle size={14} className="shrink-0 mt-0.5 text-muted-foreground" />
                ) : null}
              </div>
            )
          })}

          <div className="flex items-center gap-2 pt-1 flex-wrap">
            {applySuggestions.length > 0 && (
              <Button variant="secondary" size="sm" className="text-xs gap-1.5" onClick={handleApplyAll} disabled={applyingAll}>
                {applyingAll && <IconLoader2 size={12} className="animate-spin" />}
                Apply all ({applySuggestions.length})
              </Button>
            )}
            {analysis.routerPort != null && (
              <Button variant="ghost" size="sm" className="text-xs gap-1.5" onClick={handleExplain} disabled={explaining}>
                {explaining ? <IconLoader2 size={12} className="animate-spin" /> : <IconSparkles size={12} />}
                {explaining ? 'Thinking…' : 'Explain with AI'}
              </Button>
            )}
          </div>

          {showExplanation && (
            <div className="rounded border bg-muted/50 p-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {explanation || <span className="flex items-center gap-1"><IconLoader2 size={12} className="animate-spin" /> Thinking…</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

function ModelOptimizerContent() {
  const serviceHub = useServiceHub()
  const navigate = useNavigate()
  const { providers } = useModelProvider()
  const { hardwareData } = useHardware()

  const [phase, setPhase] = useState<Phase>('idle')
  const [scored, setScored] = useState(0)
  const [total, setTotal] = useState(0)
  const [catalogResults, setCatalogResults] = useState<ScoredModel[]>([])
  const [installedResults, setInstalledResults] = useState<InstalledResult[]>([])
  const [activeTab, setActiveTab] = useState<'catalog' | 'installed'>('catalog')

  const llamacpp = providers.find(p => p.provider === 'llamacpp')
  const installedModels = (llamacpp?.models ?? []).filter(m => {
    // Filter out hidden system models
    const hidden = (m as unknown as { hidden?: boolean }).hidden
    return !hidden && !m.id.startsWith('__system/')
  })

  const installedModelIds = new Set(
    installedModels.flatMap(m => {
      const id = m.id
      const lastSlash = id.lastIndexOf('/')
      return lastSlash >= 0 ? [id, id.slice(lastSlash + 1)] : [id]
    })
  )

  const runAnalysis = useCallback(async () => {
    setPhase('scanning')
    setScored(0)
    setTotal(0)
    setCatalogResults([])
    setInstalledResults([])

    await Promise.all([
      // Catalog scoring via llmfit
      (async () => {
        try {
          const catalog = await serviceHub.models().fetchModelCatalog()
          const scoreable = catalog.filter(m => (m.quants?.length ?? 0) > 0)
          setTotal(scoreable.length)

          const results: ScoredModel[] = []
          const BATCH = 8
          for (let i = 0; i < scoreable.length; i += BATCH) {
            const batch = scoreable.slice(i, i + BATCH)
            const batchResults = await Promise.all(
              batch.map(async model => {
                try {
                  const variant = selectBestGgufVariant(model.quants)
                  const score = await serviceHub.models().getHubModelScore(model, variant)
                  return { model, variant, score }
                } catch {
                  return null
                } finally {
                  setScored(n => n + 1)
                }
              })
            )
            for (const r of batchResults) {
              if (r && r.score.status === 'ready' && (r.score.overall ?? 0) > 0) {
                results.push(r)
                // Update sorted results incrementally
                setCatalogResults(
                  [...results].sort((a, b) => (b.score.overall ?? 0) - (a.score.overall ?? 0))
                )
              }
            }
          }
        } catch (e) {
          console.error('Catalog scoring failed', e)
        }
      })(),

      // Installed model config analysis (hybrid advisor)
      (async () => {
        if (installedModels.length === 0) return
        const results: InstalledResult[] = await Promise.all(
          installedModels.map(async m => {
            try {
              const analysis = await serviceHub.models().analyzeConfig(m.id)
              return {
                modelId: m.id,
                displayName: getModelDisplayName(m),
                analysis,
              }
            } catch {
              return { modelId: m.id, displayName: m.id, analysis: null }
            }
          })
        )
        setInstalledResults(results)
      })(),
    ])

    setPhase('done')
  }, [serviceHub, installedModels])

  const handleApply = useCallback(
    async (modelId: string, yamlKey: string, value: string | number | boolean) => {
      await serviceHub.models().applyAdvisorSuggestions(modelId, { [yamlKey]: value })
    },
    [serviceHub]
  )

  const handleApplyAll = useCallback(
    async (modelId: string, analysis: ConfigAnalysis) => {
      const patch: Record<string, string | number | boolean | null> = {}
      for (const s of analysis.suggestions) {
        if (s.canApply && s.suggestedValue !== null) {
          patch[s.yamlKey] = s.suggestedValue
        }
      }
      await serviceHub.models().applyAdvisorSuggestions(modelId, patch)
    },
    [serviceHub]
  )

  const navigateToHub = useCallback(
    (model: CatalogModel) => {
      navigate({ to: route.hub.model, params: { modelId: model.model_name } })
    },
    [navigate]
  )

  // Hardware summary line
  const gpuLabel = hardwareData.gpus?.length > 0
    ? `${hardwareData.gpus[0].name}${hardwareData.gpus[0].total_memory ? ' · ' + Math.round(hardwareData.gpus[0].total_memory / 1024) + 'GB VRAM' : ''}`
    : null
  const ramLabel = hardwareData.total_memory
    ? `${Math.round(hardwareData.total_memory / 1024)}GB RAM`
    : null
  const cpuLabel = hardwareData.cpu?.name

  const progressPct = total > 0 ? Math.round((scored / total) * 100) : 0

  return (
    <SettingsIntegrationPage>
      <div className="space-y-6 py-4">

        {/* Header + action */}
        <div className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Model Optimizer</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Scores every model in the catalog against your hardware using llmfit, then suggests config improvements for installed models.
            </p>
          </div>

          {/* Hardware pill row */}
          {(gpuLabel || ramLabel || cpuLabel) && (
            <div className="flex items-center gap-2 flex-wrap">
              {gpuLabel && (
                <div className="flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs text-muted-foreground">
                  <IconZip size={12} />
                  {gpuLabel}
                </div>
              )}
              {cpuLabel && (
                <div className="flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs text-muted-foreground">
                  <IconCpu size={12} />
                  {cpuLabel}
                  {hardwareData.cpu?.core_count ? ` · ${hardwareData.cpu.core_count} cores` : ''}
                </div>
              )}
              {ramLabel && (
                <div className="flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs text-muted-foreground">
                  {ramLabel}
                </div>
              )}
            </div>
          )}

          <Button
            onClick={runAnalysis}
            disabled={phase === 'scanning'}
            className="gap-2"
          >
            {phase === 'scanning' ? (
              <>
                <IconLoader2 size={16} className="animate-spin" />
                Scanning… {total > 0 ? `${scored}/${total}` : ''}
              </>
            ) : (
              <>
                <IconWand size={16} />
                {phase === 'done' ? 'Re-run Analysis' : 'Run Analysis'}
              </>
            )}
          </Button>

          {phase === 'scanning' && total > 0 && (
            <div className="h-1.5 w-full max-w-xs rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          )}
        </div>

        {/* Results */}
        {(phase === 'scanning' && catalogResults.length > 0 || phase === 'done') && (
          <>
            <Separator />

            {/* Tab switcher */}
            <div className="flex gap-1 border-b">
              {(['catalog', 'installed'] as const).map(tab => (
                <button
                  key={tab}
                  className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    activeTab === tab
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab === 'catalog'
                    ? `Catalog Picks${catalogResults.length > 0 ? ` (${catalogResults.length})` : ''}`
                    : `Installed Models${installedResults.length > 0 ? ` (${installedResults.length})` : ''}`}
                </button>
              ))}
            </div>

            {/* Catalog tab */}
            {activeTab === 'catalog' && (
              <div className="space-y-3">
                {phase === 'scanning' && catalogResults.length === 0 && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                    <IconLoader2 size={16} className="animate-spin" /> Scoring models…
                  </div>
                )}
                {catalogResults.map(item => (
                  <CatalogModelCard
                    key={item.model.model_name}
                    item={item}
                    installedModelIds={installedModelIds}
                    onViewInHub={navigateToHub}
                  />
                ))}
                {phase === 'done' && catalogResults.length === 0 && (
                  <p className="text-sm text-muted-foreground py-4">
                    No catalog models could be scored. Check your internet connection.
                  </p>
                )}
              </div>
            )}

            {/* Installed tab */}
            {activeTab === 'installed' && (
              <div className="space-y-3">
                {installedResults.length === 0 && phase === 'scanning' && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                    <IconLoader2 size={16} className="animate-spin" /> Analysing installed models…
                  </div>
                )}
                {installedResults.length === 0 && phase === 'done' && (
                  <p className="text-sm text-muted-foreground py-4">
                    No local llamacpp models installed. Download one from the Catalog tab.
                  </p>
                )}
                {installedResults.map(r => (
                  <InstalledModelCard
                    key={r.modelId}
                    result={r}
                    onApply={handleApply}
                    onApplyAll={handleApplyAll}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {phase === 'idle' && (
          <div className="rounded-lg border border-dashed p-8 text-center space-y-2">
            <IconWand size={32} className="mx-auto text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              Click <strong>Run Analysis</strong> to find the best models for your hardware and check config optimizations.
            </p>
          </div>
        )}
      </div>
    </SettingsIntegrationPage>
  )
}
