import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import SettingsIntegrationPage from '@/containers/SettingsIntegrationPage'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useModelProvider } from '@/hooks/useModelProvider'
import { Button } from '@/components/ui/button'
import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconInfoCircle,
  IconLoader2,
  IconSparkles,
  IconWand,
} from '@tabler/icons-react'
import { useCallback, useRef, useState } from 'react'
import type { ConfigAnalysis, AdvisorSuggestion } from '@/services/models/types'
import { getModelDisplayName } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.model_optimizer as any)({
  component: ModelOptimizerContent,
})

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase = 'idle' | 'scanning' | 'done'

interface InstalledResult {
  modelId: string
  displayName: string
  analysis: ConfigAnalysis | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── InstalledModelCard ────────────────────────────────────────────────────────

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
      if (!res.ok || !res.body) {
        setExplanation('Could not reach the inference endpoint. Load a model first.')
        return
      }
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
          <span className="text-xs text-muted-foreground font-mono">
            {analysis.model.quantName} · {analysis.model.fileSizeMB}MB
          </span>
          {!hasSuggestions && (
            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <IconCheck size={12} /> Optimal
            </span>
          )}
        </div>
        {hasSuggestions && (
          <button
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded(v => !v)}
          >
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
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${severityBg(s.severity)}`}>
                      {s.severity}
                    </span>
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
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 h-7 text-xs"
                    onClick={() => handleApplySingle(s)}
                  >
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
              <Button
                variant="secondary"
                size="sm"
                className="text-xs gap-1.5"
                onClick={handleApplyAll}
                disabled={applyingAll}
              >
                {applyingAll && <IconLoader2 size={12} className="animate-spin" />}
                Apply all ({applySuggestions.length})
              </Button>
            )}
            {analysis.routerPort != null && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs gap-1.5"
                onClick={handleExplain}
                disabled={explaining}
              >
                {explaining ? <IconLoader2 size={12} className="animate-spin" /> : <IconSparkles size={12} />}
                {explaining ? 'Thinking…' : 'Explain with AI'}
              </Button>
            )}
          </div>

          {showExplanation && (
            <div className="rounded border bg-muted/50 p-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {explanation || (
                <span className="flex items-center gap-1">
                  <IconLoader2 size={12} className="animate-spin" /> Thinking…
                </span>
              )}
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
  const { providers } = useModelProvider()

  const [phase, setPhase] = useState<Phase>('idle')
  const [results, setResults] = useState<InstalledResult[]>([])

  const llamacpp = providers.find(p => p.provider === 'llamacpp')
  const installedModels = (llamacpp?.models ?? []).filter(m => {
    const hidden = (m as unknown as { hidden?: boolean }).hidden
    return !hidden && !m.id.startsWith('__system/')
  })

  const runAnalysis = useCallback(async () => {
    setPhase('scanning')
    setResults([])

    const analysisResults: InstalledResult[] = await Promise.all(
      installedModels.map(async m => {
        try {
          const analysis = await serviceHub.models().analyzeConfig(m.id)
          return { modelId: m.id, displayName: getModelDisplayName(m), analysis }
        } catch {
          return { modelId: m.id, displayName: m.id, analysis: null }
        }
      })
    )
    setResults(analysisResults)
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

  return (
    <SettingsIntegrationPage>
      <div className="space-y-6 py-4">
        <div className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Model Optimizer</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Analyses your downloaded models and suggests llama.cpp config improvements for your hardware.
            </p>
          </div>

          <Button
            onClick={runAnalysis}
            disabled={phase === 'scanning' || installedModels.length === 0}
            className="gap-2"
          >
            {phase === 'scanning' ? (
              <>
                <IconLoader2 size={16} className="animate-spin" />
                Analysing…
              </>
            ) : (
              <>
                <IconWand size={16} />
                {phase === 'done' ? 'Re-analyse' : 'Analyse Models'}
              </>
            )}
          </Button>

          {installedModels.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No local llamacpp models installed.
            </p>
          )}
        </div>

        {results.length > 0 && (
          <div className="space-y-3">
            {results.map(r => (
              <InstalledModelCard
                key={r.modelId}
                result={r}
                onApply={handleApply}
                onApplyAll={handleApplyAll}
              />
            ))}
          </div>
        )}

        {phase === 'idle' && installedModels.length > 0 && (
          <div className="rounded-lg border border-dashed p-8 text-center space-y-2">
            <IconWand size={32} className="mx-auto text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              Click <strong>Analyse Models</strong> to check your configs.
            </p>
          </div>
        )}
      </div>
    </SettingsIntegrationPage>
  )
}
