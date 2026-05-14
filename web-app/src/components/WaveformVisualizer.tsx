import React, { useEffect, useRef } from 'react'

interface WaveformVisualizerProps {
  volumeLevel: number // 0–1
  active?: boolean
  className?: string
}

const BAR_COUNT = 20

/**
 * Animated audio waveform visualizer.
 * Renders BAR_COUNT vertical bars whose heights are driven by `volumeLevel`
 * with some randomized variation between bars for a natural look.
 */
export function WaveformVisualizer({ volumeLevel, active = true, className }: WaveformVisualizerProps) {
  const barsRef = useRef<(HTMLDivElement | null)[]>([])
  const rafRef = useRef<number>(0)
  const smoothedRef = useRef<number[]>(Array(BAR_COUNT).fill(0.05))
  const volumeRef = useRef(volumeLevel)

  useEffect(() => { volumeRef.current = volumeLevel }, [volumeLevel])

  useEffect(() => {
    function frame() {
      rafRef.current = requestAnimationFrame(frame)
      const vol = active ? volumeRef.current : 0

      for (let i = 0; i < BAR_COUNT; i++) {
        // Random variation per bar: center bars are taller, edges shorter
        const centerFactor = 1 - Math.abs((i / (BAR_COUNT - 1)) * 2 - 1) * 0.4
        const noise = 0.7 + Math.random() * 0.6
        const target = Math.max(0.04, vol * centerFactor * noise)

        // Lerp toward target (attack fast, decay slow)
        const lerp = target > smoothedRef.current[i] ? 0.35 : 0.12
        smoothedRef.current[i] += (target - smoothedRef.current[i]) * lerp

        const bar = barsRef.current[i]
        if (bar) {
          bar.style.transform = `scaleY(${smoothedRef.current[i]})`
        }
      }
    }

    rafRef.current = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(rafRef.current)
  }, [active])

  return (
    <div
      className={`flex items-center justify-center gap-[3px] ${className ?? ''}`}
      style={{ height: 48 }}
    >
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <div
          key={i}
          ref={(el) => { barsRef.current[i] = el }}
          style={{
            width: 3,
            height: '100%',
            borderRadius: 2,
            background: 'currentColor',
            transformOrigin: 'center',
            transform: 'scaleY(0.04)',
            transition: 'none',
          }}
        />
      ))}
    </div>
  )
}
