import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconCpu,
  IconInfoCircle,
  IconLoader2,
  IconSparkles,
  IconWand,
} from '@tabler/icons-react'
import { useCallback, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useServiceHub } from '@/hooks/useServiceHub'
import type { AdvisorSuggestion, ConfigAnalysis } from '@/services/models/types'

interface ConfigAdvisorPanelProps {
  modelId: string
  provider: ProviderObject
}

type Phase = 'idle' | 'loading' | 'done' | 'error'

function severityColor(s: AdvisorSuggestion['severity']) {
  switch (s) {
    case 'improvement': return 'text-green-600 dark:text-green-400'
    case 'warning': return 'text-amber-600 dark:text-amber-400'
    case 'info': return 'text-blue-600 dark:text-blue-400'
  }
}

function severityBadge(s: AdvisorSuggestion['severity']) {
  switch (s) {
    case 'improvement': return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'
    case 'warning': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
    case 'info': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400'
  }
}

function formatValue(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return 'default'
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  return String(v)
}

export function ConfigAdvisorPanel({ modelId, provider }: ConfigAdvisorPanelProps) {
  const serviceHub = useServiceHub()
  const [phase, setPhase] = useState<Phase>('idle')
  const [analysis, setAnalysis] = useState<ConfigAnalysis | null>(null)
  const [applied, setApplied] = useState<Set<string>>(new Set())
  const [applyingAll, setApplyingAll] = useState(false)
  const [open, setOpen] = useState(false)

  // AI explanation state
  const [explaining, setExplaining] = useState(false)
  const [explanation, setExplanation] = useState('')
  const [showExplanation, setShowExplanation] = useState(false)
  const explainAbortRef = useRef<AbortController | null>(null)

  // Only show for llamacpp models
  if (provider.provider !== 'llamacpp') return null

  const handleAnalyze = async () => {
    setPhase('loading')
    setOpen(true)
    setApplied(new Set())
    setExplanation('')
    setShowExplanation(false)
    try {
      const result = await serviceHub.models().analyzeConfig(modelId)
      setAnalysis(result)
      setPhase(result ? 'done' : 'error')
    } catch {
      setPhase('error')
    }
  }

  const buildPatch = useCallback(
    (suggestions: AdvisorSuggestion[]): Record<string, string | number | boolean | null> => {
      const patch: Record<string, string | number | boolean | null> = {}
      for (const s of suggestions) {
        if (s.canApply && s.suggestedValue !== null) {
          patch[s.yamlKey] = s.suggestedValue
        }
      }
      return patch
    },
    []
  )

  const applySingle = async (s: AdvisorSuggestion) => {
    if (!s.canApply || s.suggestedValue === null) return
    try {
      await serviceHub.models().applyAdvisorSuggestions(modelId, { [s.yamlKey]: s.suggestedValue })
      setApplied((prev) => new Set([...prev, s.yamlKey]))
    } catch (e) {
      console.error('Failed to apply suggestion', e)
    }
  }

  const applyAll = async () => {
    if (!analysis) return
    const applicableSuggestions = analysis.suggestions.filter(
      (s) => s.canApply && s.suggestedValue !== null && !applied.has(s.yamlKey)
    )
    if (applicableSuggestions.length === 0) return
    setApplyingAll(true)
    try {
      await serviceHub.models().applyAdvisorSuggestions(modelId, buildPatch(applicableSuggestions))
      setApplied((prev) => {
        const next = new Set(prev)
        for (const s of applicableSuggestions) next.add(s.yamlKey)
        return next
      })
    } catch (e) {
      console.error('Failed to apply all suggestions', e)
    } finally {
      setApplyingAll(false)
    }
  }

  const explainWithAI = async () => {
    if (!analysis || !analysis.routerPort) return
    if (explainAbortRef.current) explainAbortRef.current.abort()

    const ctrl = new AbortController()
    explainAbortRef.current = ctrl
    setExplaining(true)
    setExplanation('')
    setShowExplanation(true)

    const applicableSuggestions = analysis.suggestions.filter((s) => s.canApply)
    const prompt = buildExplainPrompt(analysis, applicableSuggestions)

    try {
      const res = await fetch(
        `http://localhost:${analysis.routerPort}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(analysis.routerApiKey
              ? { Authorization: `Bearer ${analysis.routerApiKey}` }
              : {}),
          },
          body: JSON.stringify({
            messages: [{ role: 'user', content: prompt }],
            stream: true,
            max_tokens: 400,
            temperature: 0.3,
          }),
          signal: ctrl.signal,
        }
      )

      if (!res.ok || !res.body) {
        setExplanation('Could not reach the inference endpoint. Make sure a model is loaded.')
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()

      outer: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        for (const line of text.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          const payload = trimmed.slice(6)
          if (payload === '[DONE]') break outer
          try {
            const chunk = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>
            }
            const content = chunk.choices?.[0]?.delta?.content ?? ''
            if (content) setExplanation((prev) => prev + content)
          } catch {
            /* skip malformed chunks */
          }
        }
      }
    } catch (e: unknown) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        setExplanation('Failed to get AI explanation. Is a model loaded?')
      }
    } finally {
      setExplaining(false)
    }
  }

  const pendingApplicable =
    analysis?.suggestions.filter((s) => s.canApply && !applied.has(s.yamlKey) && s.suggestedValue !== null).length ?? 0

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-xs"
          onClick={handleAnalyze}
          disabled={phase === 'loading'}
        >
          {phase === 'loading' ? (
            <IconLoader2 size={14} className="animate-spin" />
          ) : (
            <IconWand size={14} />
          )}
          {phase === 'loading' ? 'Analysing…' : 'Analyse Config'}
        </Button>

        {phase === 'done' && analysis && (
          <button
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
            {analysis.suggestions.length === 0
              ? 'No suggestions'
              : `${analysis.suggestions.length} suggestion${analysis.suggestions.length !== 1 ? 's' : ''}`}
          </button>
        )}

        {phase === 'error' && (
          <span className="text-xs text-destructive">Analysis failed</span>
        )}
      </div>

      {open && phase === 'done' && analysis && (
        <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm">
          {/* Hardware + model summary */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <IconCpu size={12} />
              {analysis.hardware.cpuName} · {analysis.hardware.cpuCores} cores
            </span>
            {analysis.hardware.hasGpu && analysis.hardware.gpus[0] && (
              <span>{analysis.hardware.gpus[0].name} · {analysis.hardware.gpus[0].vramMB}MB VRAM</span>
            )}
            <span>{analysis.model.quantName} · {analysis.model.fileSizeMB}MB</span>
            {analysis.model.trainedCtxLen > 0 && (
              <span>trained ctx {analysis.model.trainedCtxLen.toLocaleString()}</span>
            )}
          </div>

          {analysis.suggestions.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <IconCheck size={14} className="text-green-500" />
              Config looks optimal for this hardware.
            </div>
          ) : (
            <div className="space-y-2">
              {analysis.suggestions.map((s) => {
                const isApplied = applied.has(s.yamlKey)
                return (
                  <div
                    key={s.yamlKey}
                    className="flex items-start gap-3 rounded border bg-background px-3 py-2"
                  >
                    <div className="flex-1 space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{s.displayName}</span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${severityBadge(s.severity)}`}
                        >
                          {s.severity}
                        </span>
                        {isApplied && (
                          <span className="flex items-center gap-0.5 text-[10px] text-green-600">
                            <IconCheck size={10} /> applied
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <span className="font-mono">{formatValue(s.currentValue)}</span>
                        {s.suggestedValue !== null && (
                          <>
                            <span>→</span>
                            <span className={`font-mono font-semibold ${severityColor(s.severity)}`}>
                              {formatValue(s.suggestedValue)}
                            </span>
                          </>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground leading-normal">{s.reason}</p>
                    </div>
                    {s.canApply && !isApplied && s.suggestedValue !== null && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0 h-7 text-xs"
                        onClick={() => applySingle(s)}
                      >
                        Apply
                      </Button>
                    )}
                    {!s.canApply && (
                      <IconInfoCircle
                        size={14}
                        className="shrink-0 mt-0.5 text-muted-foreground"
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Actions row */}
          {(pendingApplicable > 0 || analysis.routerPort != null) && (
            <>
              <Separator />
              <div className="flex items-center gap-2 flex-wrap">
                {pendingApplicable > 0 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="text-xs gap-1.5"
                    onClick={applyAll}
                    disabled={applyingAll}
                  >
                    {applyingAll && <IconLoader2 size={12} className="animate-spin" />}
                    Apply all ({pendingApplicable})
                  </Button>
                )}
                {analysis.routerPort != null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs gap-1.5"
                    onClick={explainWithAI}
                    disabled={explaining}
                  >
                    {explaining ? (
                      <IconLoader2 size={12} className="animate-spin" />
                    ) : (
                      <IconSparkles size={12} />
                    )}
                    {explaining ? 'Explaining…' : 'Explain with AI'}
                  </Button>
                )}
              </div>
            </>
          )}

          {/* AI explanation */}
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

function buildExplainPrompt(analysis: ConfigAnalysis, suggestions: AdvisorSuggestion[]): string {
  const hw = analysis.hardware
  const m = analysis.model
  const hwDesc = [
    hw.hasGpu && hw.gpus[0] ? `GPU: ${hw.gpus[0].name} (${hw.gpus[0].vramMB}MB VRAM)` : 'CPU only',
    `CPU: ${hw.cpuName} (${hw.cpuCores} cores)`,
    `RAM: ${Math.round(hw.totalRamMB / 1024)}GB`,
  ].join(', ')

  const modelDesc = `${analysis.modelId} — ${m.quantName}, ${m.fileSizeMB}MB, ${m.nLayers || '?'} layers`

  const changeList = suggestions
    .map((s) => `• ${s.displayName}: ${formatValue(s.currentValue)} → ${formatValue(s.suggestedValue)}`)
    .join('\n')

  return `You are a llama.cpp performance advisor. Briefly explain (2–4 sentences total) why these configuration changes would improve inference on this hardware. Be concise and specific.

Hardware: ${hwDesc}
Model: ${modelDesc}

Suggested changes:
${changeList}

Explain the key benefits:`
}
