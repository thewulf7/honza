import React, { useEffect, useRef } from 'react'
import { VideoOff } from 'lucide-react'

interface LocalCameraPreviewProps {
  enabled: boolean
  className?: string
}

/**
 * Shows the user's local camera feed in a mirrored picture-in-picture preview.
 * Mounted inside VoiceCallOverlay, anchored to the top-right corner.
 *
 * - Calls getUserMedia only while `enabled` is true.
 * - Stops all tracks immediately when disabled or unmounted to release the camera.
 * - Video is mirrored horizontally (transform: scaleX(-1)) so it looks natural.
 */
export function LocalCameraPreview({ enabled, className }: LocalCameraPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  useEffect(() => {
    if (!enabled) {
      // Stop any active stream
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
        streamRef.current = null
      }
      if (videoRef.current) videoRef.current.srcObject = null
      return
    }

    let cancelled = false

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
        }
      })
      .catch((err) => {
        console.warn('[LocalCameraPreview] Camera access denied:', err)
      })

    return () => {
      cancelled = true
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
        streamRef.current = null
      }
    }
  }, [enabled])

  return (
    <div
      className={`relative overflow-hidden rounded-lg bg-neutral-900 shadow-lg ${className ?? ''}`}
      style={{ width: 240, height: 135 }}
    >
      {enabled ? (
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: 'scaleX(-1)', // mirror so user sees themselves naturally
          }}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <VideoOff className="text-neutral-500" size={32} />
        </div>
      )}
    </div>
  )
}
