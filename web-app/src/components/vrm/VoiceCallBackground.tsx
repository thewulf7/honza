import { useEffect, useRef } from 'react'

interface Orb {
  x: number
  y: number
  r: number
  vx: number
  vy: number
  hue: number
  hueSpeed: number
  alpha: number
  pulsePhase: number
  pulseSpeed: number
}

const ORB_COUNT = 6

function makeOrb(w: number, h: number): Orb {
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    r: 180 + Math.random() * 220,
    vx: (Math.random() - 0.5) * 0.3,
    vy: (Math.random() - 0.5) * 0.3,
    hue: 210 + Math.random() * 80,   // blue-to-purple range
    hueSpeed: (Math.random() - 0.5) * 0.05,
    alpha: 0.12 + Math.random() * 0.1,
    pulsePhase: Math.random() * Math.PI * 2,
    pulseSpeed: 0.003 + Math.random() * 0.004,
  }
}

/**
 * Full-canvas animated background for the voice call screen.
 * Renders soft drifting radial-gradient orbs in a deep navy base.
 * Entirely canvas-based — no extra deps.
 */
export function VoiceCallBackground({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let orbs: Orb[] = []

    function resize() {
      if (!canvas) return
      canvas.width = canvas.offsetWidth
      canvas.height = canvas.offsetHeight
      orbs = Array.from({ length: ORB_COUNT }, () => makeOrb(canvas.width, canvas.height))
    }

    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    resize()

    function draw() {
      if (!canvas || !ctx) return
      const { width: w, height: h } = canvas

      // Deep navy base
      ctx.fillStyle = '#06080f'
      ctx.fillRect(0, 0, w, h)

      for (const orb of orbs) {
        orb.pulsePhase += orb.pulseSpeed
        const pulse = 1 + 0.15 * Math.sin(orb.pulsePhase)
        const r = orb.r * pulse

        const grad = ctx.createRadialGradient(orb.x, orb.y, 0, orb.x, orb.y, r)
        grad.addColorStop(0, `hsla(${orb.hue}, 70%, 55%, ${orb.alpha})`)
        grad.addColorStop(1, `hsla(${orb.hue}, 60%, 40%, 0)`)

        ctx.beginPath()
        ctx.arc(orb.x, orb.y, r, 0, Math.PI * 2)
        ctx.fillStyle = grad
        ctx.fill()

        // Drift
        orb.x += orb.vx
        orb.y += orb.vy
        orb.hue += orb.hueSpeed

        // Bounce off edges (soft — use radius/2 so orbs stay partially visible)
        if (orb.x < -r / 2) orb.vx = Math.abs(orb.vx)
        if (orb.x > w + r / 2) orb.vx = -Math.abs(orb.vx)
        if (orb.y < -r / 2) orb.vy = Math.abs(orb.vy)
        if (orb.y > h + r / 2) orb.vy = -Math.abs(orb.vy)
      }

      // Subtle grid vignette overlay — gives depth
      const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, h * 0.85)
      vignette.addColorStop(0, 'rgba(0,0,0,0)')
      vignette.addColorStop(1, 'rgba(0,0,0,0.55)')
      ctx.fillStyle = vignette
      ctx.fillRect(0, 0, w, h)

      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 h-full w-full ${className ?? ''}`}
      style={{ display: 'block' }}
    />
  )
}
