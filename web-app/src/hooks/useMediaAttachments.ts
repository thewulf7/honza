import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { isPlatformTauri } from '@/lib/platform/utils'
import { useChatAttachments } from '@/hooks/useChatAttachments'
import {
  Attachment,
  createImageAttachment,
  createAudioAttachment,
} from '@/types/attachment'
import type { ServiceHub } from '@/services'

// ---- pure helpers -----------------------------------------------------------

function getFileTypeFromExtension(fileName: string): string {
  switch (fileName.toLowerCase().split('.').pop()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    default:
      return ''
  }
}

async function hashBase64(base64: string): Promise<string> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function decodeAudioDuration(dataUrl: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    try {
      const audio = new Audio()
      audio.preload = 'metadata'
      audio.onloadedmetadata = () => {
        const d = audio.duration
        resolve(Number.isFinite(d) && d > 0 ? d : undefined)
      }
      audio.onerror = () => resolve(undefined)
      audio.src = dataUrl
    } catch {
      resolve(undefined)
    }
  })
}

// ---- hook -------------------------------------------------------------------

type Options = {
  attachmentsKey: string
  currentThreadId: string | undefined
  hasMmproj: boolean
  audioSupported: boolean
  setAttachmentsForThread: (
    key: string,
    updater: (prev: Attachment[]) => Attachment[]
  ) => void
  serviceHub: ServiceHub
  onError: (msg: string) => void
  onClearError: () => void
  focusInput: () => void
}

export function useMediaAttachments({
  attachmentsKey,
  currentThreadId,
  hasMmproj,
  audioSupported,
  setAttachmentsForThread,
  serviceHub,
  onError,
  onClearError,
  focusInput,
}: Options) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const dropAcceptsAnything = hasMmproj || audioSupported

  // ---- image processing -------------------------------------------------------

  const processImageFiles = useCallback(
    async (files: File[]) => {
      const maxSize = 10 * 1024 * 1024
      const oversizedFiles: string[] = []
      const invalidTypeFiles: string[] = []
      const allowedTypes = ['image/jpg', 'image/jpeg', 'image/png']
      const validFiles: Array<{ file: File; mimeType: string }> = []

      for (const file of Array.from(files)) {
        if (file.size > maxSize) {
          oversizedFiles.push(file.name)
          continue
        }
        const mimeType = getFileTypeFromExtension(file.name) || file.type
        if (!allowedTypes.includes(mimeType)) {
          invalidTypeFiles.push(file.name)
          continue
        }
        validFiles.push({ file, mimeType })
      }

      const preparedFiles: Attachment[] = []
      for (const { file, mimeType: actualType } of validFiles) {
        await new Promise<void>((resolve) => {
          const reader = new FileReader()
          reader.onload = () => {
            const result = reader.result
            if (typeof result === 'string') {
              preparedFiles.push(
                createImageAttachment({
                  name: file.name,
                  size: file.size,
                  mimeType: actualType,
                  base64: result.split(',')[1],
                  dataUrl: result,
                })
              )
            }
            resolve()
          }
          reader.readAsDataURL(file)
        })
      }

      for (const att of preparedFiles) {
        if (att.base64) att.contentHash = await hashBase64(att.base64)
      }

      const currentAttachments = useChatAttachments.getState().getAttachments(attachmentsKey)
      const existingImageHashes = new Set<string>()
      const existingImageNames = new Set<string>()
      for (const a of currentAttachments) {
        if (a.type !== 'image') continue
        if (a.contentHash) existingImageHashes.add(a.contentHash)
        else if (a.base64) existingImageHashes.add(await hashBase64(a.base64))
        else existingImageNames.add(a.name)
      }

      const duplicates: string[] = []
      const newFiles: Attachment[] = []
      const seenHashesInBatch = new Set<string>()
      for (const att of preparedFiles) {
        const hash = att.contentHash
        if (
          (hash && (existingImageHashes.has(hash) || seenHashesInBatch.has(hash))) ||
          existingImageNames.has(att.name)
        ) {
          duplicates.push(att.name)
          continue
        }
        if (hash) seenHashesInBatch.add(hash)
        newFiles.push(att)
      }

      setAttachmentsForThread(attachmentsKey, (prev) =>
        newFiles.length > 0 ? [...prev, ...newFiles] : prev
      )

      if (currentThreadId && newFiles.length > 0) {
        void (async () => {
          for (const img of newFiles) {
            const matchImg = (a: Attachment) =>
              a.type === 'image' &&
              (img.contentHash ? a.contentHash === img.contentHash : a.name === img.name)
            try {
              setAttachmentsForThread(attachmentsKey, (prev) =>
                prev.map((a) => (matchImg(a) ? { ...a, processing: true } : a))
              )
              const result = await serviceHub.uploads().ingestImage(currentThreadId, img)
              if (result?.id) {
                setAttachmentsForThread(attachmentsKey, (prev) =>
                  prev.map((a) =>
                    matchImg(a) ? { ...a, processing: false, processed: true, id: result.id } : a
                  )
                )
              } else {
                throw new Error('No ID returned from image ingestion')
              }
            } catch (error) {
              console.error('Failed to ingest image:', error)
              setAttachmentsForThread(attachmentsKey, (prev) => prev.filter((a) => !matchImg(a)))
              toast.error(`Failed to ingest ${img.name}`, {
                description: error instanceof Error ? error.message : String(error),
              })
            }
          }
        })()
      }

      if (duplicates.length > 0) {
        toast.warning('Some images already attached', {
          description: `${duplicates.join(', ')} ${duplicates.length === 1 ? 'is' : 'are'} already in the list`,
        })
      }

      const errors: string[] = []
      if (oversizedFiles.length > 0) {
        errors.push(
          `File${oversizedFiles.length > 1 ? 's' : ''} too large (max 10MB): ${oversizedFiles.join(', ')}`
        )
      }
      if (invalidTypeFiles.length > 0) {
        errors.push(
          `Invalid file type${invalidTypeFiles.length > 1 ? 's' : ''} (only JPEG, JPG, PNG allowed): ${invalidTypeFiles.join(', ')}`
        )
      }
      if (errors.length > 0) {
        onError(errors.join(' | '))
        if (fileInputRef.current) fileInputRef.current.value = ''
      } else {
        onClearError()
      }
    },
    [attachmentsKey, currentThreadId, setAttachmentsForThread, serviceHub, onError, onClearError]
  )

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files && files.length > 0) {
        void processImageFiles(Array.from(files))
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
      focusInput()
    },
    [processImageFiles, focusInput]
  )

  // ---- audio processing -------------------------------------------------------

  const processAudioFiles = useCallback(
    async (files: File[]) => {
      const maxBytes = 25 * 1024 * 1024
      const oversized: string[] = []
      const invalid: string[] = []
      const prepared: Attachment[] = []

      for (const file of Array.from(files)) {
        const lower = file.name.toLowerCase()
        const ext = lower.split('.').pop()
        const isWav = file.type === 'audio/wav' || file.type === 'audio/x-wav' || ext === 'wav'
        const isMp3 = file.type === 'audio/mpeg' || file.type === 'audio/mp3' || ext === 'mp3'
        if (!isWav && !isMp3) { invalid.push(file.name); continue }
        if (file.size > maxBytes) { oversized.push(file.name); continue }

        const fmt: 'wav' | 'mp3' = isWav ? 'wav' : 'mp3'
        const mimeType = fmt === 'wav' ? 'audio/wav' : 'audio/mpeg'
        const dataUrl: string = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const r = reader.result
            if (typeof r === 'string') resolve(r)
            else reject(new Error('read failed'))
          }
          reader.onerror = () => reject(reader.error ?? new Error('read failed'))
          reader.readAsDataURL(file)
        })
        prepared.push(
          createAudioAttachment({
            name: file.name,
            base64: dataUrl.split(',')[1] ?? '',
            dataUrl,
            mimeType,
            audioFormat: fmt,
            size: file.size,
            durationSec: await decodeAudioDuration(dataUrl),
          })
        )
      }

      const current = useChatAttachments.getState().getAttachments(attachmentsKey)
      const existingNames = new Set(current.filter((a) => a.type === 'audio').map((a) => a.name))
      const duplicates: string[] = []
      const newOnes: Attachment[] = []
      for (const att of prepared) {
        if (existingNames.has(att.name)) { duplicates.push(att.name); continue }
        newOnes.push(att)
      }

      if (newOnes.length > 0) {
        setAttachmentsForThread(attachmentsKey, (prev) => [...prev, ...newOnes])
      }
      if (duplicates.length > 0) {
        toast.warning('Some audio files already attached', {
          description: `${duplicates.join(', ')} ${duplicates.length === 1 ? 'is' : 'are'} already in the list`,
        })
      }
      const errors: string[] = []
      if (oversized.length > 0) {
        errors.push(`Audio file${oversized.length > 1 ? 's' : ''} too large (max 25MB): ${oversized.join(', ')}`)
      }
      if (invalid.length > 0) {
        errors.push(`Invalid audio type${invalid.length > 1 ? 's' : ''} (only WAV, MP3 allowed): ${invalid.join(', ')}`)
      }
      if (errors.length > 0) {
        onError(errors.join(' | '))
        if (audioInputRef.current) audioInputRef.current.value = ''
      }
    },
    [attachmentsKey, setAttachmentsForThread, onError]
  )

  const handleAudioFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files && files.length > 0) {
        void processAudioFiles(Array.from(files))
        if (audioInputRef.current) audioInputRef.current.value = ''
      }
      focusInput()
    },
    [processAudioFiles, focusInput]
  )

  // ---- file pickers -----------------------------------------------------------

  const openAudioPicker = useCallback(async () => {
    if (isPlatformTauri()) {
      try {
        const selected = await serviceHub.dialog().open({
          multiple: true,
          filters: [{ name: 'Audio', extensions: ['wav', 'mp3'] }],
        })
        if (selected) {
          const paths = Array.isArray(selected) ? selected : [selected]
          const files: File[] = []
          for (const path of paths) {
            try {
              const { convertFileSrc } = await import('@tauri-apps/api/core')
              const response = await fetch(convertFileSrc(path))
              if (!response.ok) throw new Error(response.statusText)
              const blob = await response.blob()
              const fileName = path.split(/[\\/]/).filter(Boolean).pop() || 'audio'
              const ext = fileName.toLowerCase().split('.').pop()
              files.push(new File([blob], fileName, { type: ext === 'mp3' ? 'audio/mpeg' : 'audio/wav' }))
            } catch (error) {
              console.error('Failed to read audio file:', error)
              toast.error('Failed to read audio file', {
                description: error instanceof Error ? error.message : String(error),
              })
            }
          }
          if (files.length > 0) await processAudioFiles(files)
        }
      } catch (error) {
        console.error('Failed to open audio dialog:', error)
      }
      focusInput()
    } else {
      audioInputRef.current?.click()
    }
  }, [serviceHub, processAudioFiles, focusInput])

  const openImagePicker = useCallback(async () => {
    if (isPlatformTauri()) {
      try {
        const selected = await serviceHub.dialog().open({
          multiple: true,
          filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }],
        })
        if (selected) {
          const paths = Array.isArray(selected) ? selected : [selected]
          const files: File[] = []
          for (const path of paths) {
            try {
              const { convertFileSrc } = await import('@tauri-apps/api/core')
              const response = await fetch(convertFileSrc(path))
              if (!response.ok) throw new Error(`Failed to fetch file: ${response.statusText}`)
              const blob = await response.blob()
              const fileName = path.split(/[\\/]/).filter(Boolean).pop() || 'image'
              const ext = fileName.toLowerCase().split('.').pop()
              const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg'
              files.push(new File([blob], fileName, { type: mimeType }))
            } catch (error) {
              console.error('Failed to read file:', error)
              toast.error('Failed to read file', {
                description: error instanceof Error ? error.message : String(error),
              })
            }
          }
          if (files.length > 0) await processImageFiles(files)
        }
      } catch (error) {
        console.error('Failed to open file dialog:', error)
      }
      focusInput()
    } else {
      fileInputRef.current?.click()
    }
  }, [serviceHub, processImageFiles, focusInput])

  // ---- drag and drop ----------------------------------------------------------

  const handleDragEnterOrOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (dropAcceptsAnything) setIsDragOver(true)
    },
    [dropAcceptsAnything]
  )

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const relatedTarget = e.relatedTarget as Node | null
    if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)
      if (!dropAcceptsAnything) return
      if (!e.dataTransfer) { console.warn('No dataTransfer available in drop event'); return }

      const dropped = Array.from(e.dataTransfer.files ?? [])
      if (dropped.length === 0) return

      const isAudioFile = (f: File) => {
        const ext = f.name.toLowerCase().split('.').pop()
        return (
          f.type === 'audio/wav' || f.type === 'audio/x-wav' ||
          f.type === 'audio/mpeg' || f.type === 'audio/mp3' ||
          ext === 'wav' || ext === 'mp3'
        )
      }

      const audioOnes = audioSupported ? dropped.filter(isAudioFile) : []
      const otherOnes = dropped.filter((f) => !audioOnes.includes(f))

      if (otherOnes.length > 0 && hasMmproj) {
        const dt = new DataTransfer()
        otherOnes.forEach((f) => dt.items.add(f))
        handleFileChange({ target: { files: dt.files } } as React.ChangeEvent<HTMLInputElement>)
      }
      if (audioOnes.length > 0) void processAudioFiles(audioOnes)
    },
    [dropAcceptsAnything, audioSupported, hasMmproj, handleFileChange, processAudioFiles]
  )

  // ---- paste ------------------------------------------------------------------

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      if (audioSupported) {
        const items = e.clipboardData?.items
        if (items) {
          const audioFiles: File[] = []
          for (const item of Array.from(items)) {
            if (['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3'].includes(item.type)) {
              const f = item.getAsFile()
              if (f) audioFiles.push(f)
            }
          }
          if (audioFiles.length > 0) {
            e.preventDefault()
            await processAudioFiles(audioFiles)
            return
          }
        }
      }

      if (hasMmproj) {
        const items = e.clipboardData?.items
        let hasProcessedImage = false

        if (items) {
          const imageItems = Array.from(items).filter((item) => item.type.startsWith('image/'))
          if (imageItems.length > 0) {
            e.preventDefault()
            const files = imageItems.map((item) => item.getAsFile()).filter(Boolean) as File[]
            if (files.length > 0) {
              handleFileChange({ target: { files } } as unknown as React.ChangeEvent<HTMLInputElement>)
              hasProcessedImage = true
            }
          }
        }

        if (!hasProcessedImage && navigator.clipboard && 'read' in navigator.clipboard) {
          try {
            const clipboardContents = await navigator.clipboard.read()
            const files: File[] = []
            for (const item of clipboardContents) {
              for (const type of item.types.filter((t) => t.startsWith('image/'))) {
                try {
                  const blob = await item.getType(type)
                  files.push(new File([blob], `pasted-image-${Date.now()}.${type.split('/')[1] || 'png'}`, { type }))
                } catch (error) {
                  console.error('Error reading clipboard item:', error)
                }
              }
            }
            if (files.length > 0) {
              e.preventDefault()
              handleFileChange({ target: { files } } as unknown as React.ChangeEvent<HTMLInputElement>)
            }
          } catch (error) {
            console.error('Clipboard API access failed:', error)
          }
        }
      }
    },
    [audioSupported, hasMmproj, processAudioFiles, handleFileChange]
  )

  return {
    fileInputRef,
    audioInputRef,
    isDragOver,
    dropAcceptsAnything,
    processImageFiles,
    processAudioFiles,
    handleFileChange,
    handleAudioFileChange,
    openImagePicker,
    openAudioPicker,
    handleDragEnterOrOver,
    handleDragLeave,
    handleDrop,
    handlePaste,
  }
}
