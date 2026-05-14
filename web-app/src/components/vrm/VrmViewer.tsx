import React, { useEffect, useImperativeHandle, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import type { VRM } from '@pixiv/three-vrm'
import { VrmLipSync } from './VrmLipSync'

export interface VrmViewerHandle {
  setPhoneme: (phoneme: string, weight: number) => void
  resetMouth: () => void
}

interface VrmViewerProps {
  vrmPath: string
  className?: string
}

const IDLE_BREATH_FREQ = 0.2 // Hz – gentle breathing
const IDLE_BREATH_AMP = 0.008 // chest bone oscillation amplitude

const VrmViewer = React.forwardRef<VrmViewerHandle, VrmViewerProps>(
  ({ vrmPath, className }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const vrmRef = useRef<VRM | null>(null)
    const lipSyncRef = useRef<VrmLipSync>(new VrmLipSync())
    const rafRef = useRef<number>(0)

    useImperativeHandle(ref, () => ({
      setPhoneme(phoneme, weight) {
        lipSyncRef.current.setTargetPhoneme(phoneme, weight)
      },
      resetMouth() {
        lipSyncRef.current.reset()
      },
    }))

    useEffect(() => {
      const canvas = canvasRef.current
      if (!canvas) return

      // ── Scene setup ────────────────────────────────────────────────────────
      const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
      renderer.setPixelRatio(window.devicePixelRatio)
      renderer.setSize(canvas.clientWidth, canvas.clientHeight)
      renderer.outputColorSpace = THREE.SRGBColorSpace

      const scene = new THREE.Scene()

      const camera = new THREE.PerspectiveCamera(
        30,
        canvas.clientWidth / canvas.clientHeight,
        0.1,
        20
      )
      // Frame roughly on the head/chest area
      camera.position.set(0, 1.35, 2.2)
      camera.lookAt(0, 1.1, 0)

      const dirLight = new THREE.DirectionalLight(0xffffff, 1.2)
      dirLight.position.set(1, 2, 2)
      scene.add(dirLight)
      scene.add(new THREE.AmbientLight(0xffffff, 0.6))

      // ── Load VRM ───────────────────────────────────────────────────────────
      const loader = new GLTFLoader()
      loader.register((parser) => new VRMLoaderPlugin(parser))

      let currentVrm: VRM | null = null

      if (vrmPath) {
        loader.load(
          vrmPath,
          (gltf) => {
            const vrm: VRM = gltf.userData.vrm
            VRMUtils.removeUnnecessaryVertices(gltf.scene)
            VRMUtils.combineSkeletons(gltf.scene)
            scene.add(vrm.scene)
            vrmRef.current = vrm
            currentVrm = vrm
            lipSyncRef.current.setVrm(vrm)
            vrm.scene.rotation.y = Math.PI // face camera
          },
          undefined,
          (err) => console.error('[VrmViewer] Failed to load VRM', err)
        )
      }

      // ── Resize observer ────────────────────────────────────────────────────
      const resizeObserver = new ResizeObserver(() => {
        if (!canvas) return
        renderer.setSize(canvas.clientWidth, canvas.clientHeight)
        camera.aspect = canvas.clientWidth / canvas.clientHeight
        camera.updateProjectionMatrix()
      })
      resizeObserver.observe(canvas)

      // ── Animation loop ─────────────────────────────────────────────────────
      const clock = new THREE.Clock()

      function animate() {
        rafRef.current = requestAnimationFrame(animate)
        const elapsed = clock.getElapsedTime()

        if (currentVrm) {
          // Idle breathing: oscillate chest bone on Y axis
          const breathOffset = Math.sin(elapsed * Math.PI * 2 * IDLE_BREATH_FREQ) * IDLE_BREATH_AMP
          const chest = currentVrm.humanoid?.getNormalizedBoneNode('chest')
          if (chest) chest.rotation.x = breathOffset

          // Lip sync update
          lipSyncRef.current.update()

          currentVrm.update(clock.getDelta())
        }

        renderer.render(scene, camera)
      }

      animate()

      return () => {
        cancelAnimationFrame(rafRef.current)
        resizeObserver.disconnect()
        if (currentVrm) {
          scene.remove(currentVrm.scene)
          VRMUtils.deepDispose(currentVrm.scene)
        }
        renderer.dispose()
      }
    }, [vrmPath])

    return (
      <canvas
        ref={canvasRef}
        className={className}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
    )
  }
)

VrmViewer.displayName = 'VrmViewer'

export { VrmViewer }
