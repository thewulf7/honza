import TextareaAutosize from 'react-textarea-autosize'
import { invoke } from '@tauri-apps/api/core'
import { cn, getModelDisplayName } from '@/lib/utils'
import { usePrompt } from '@/hooks/usePrompt'
import { useThreads } from '@/hooks/useThreads'
import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react'
import { Button } from '@/components/ui/button'
import { AvatarEmoji } from '@/containers/AvatarEmoji'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { ArrowRight, PlusIcon } from 'lucide-react'
import {
  IconPhoto,
  IconMusic,
  IconTool,
  IconCodeCircle2,
  IconPlayerStopFilled,
  IconX,
  IconPaperclip,
  IconLoader2,
  IconWorld,
  IconBrandChrome,
  IconUser,
  IconFolderCode,
} from '@tabler/icons-react'
import { generateId } from 'ai'
import { useMessageQueue } from '@/stores/message-queue-store'
import { QueuedMessageChip } from '@/containers/QueuedMessageBubble'
import { SamplerPopover } from '@/containers/SamplerPopover'
import { useCodexSettings } from '@/hooks/useCodexSettings'
import { useClaudeCodeModel } from '@/hooks/useClaudeCodeModel'
import { useHermesSettings } from '@/hooks/useHermesSettings'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'

import { useAppState } from '@/hooks/useAppState'
import { MovingBorder } from './MovingBorder'
import type { ChatStatus } from 'ai'
import { useRouter } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  TEMPORARY_CHAT_ID,
  TEMPORARY_CHAT_QUERY_ID,
  SESSION_STORAGE_KEY,
  SESSION_STORAGE_PREFIX,
} from '@/constants/chat'
import { defaultModel } from '@/lib/models'
import { useAssistant } from '@/hooks/useAssistant'
import DropdownToolsAvailable from '@/containers/DropdownToolsAvailable'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTools } from '@/hooks/useTools'
import { TokenCounter } from '@/components/TokenCounter'
import { useMessages } from '@/hooks/useMessages'
import { useShallow } from 'zustand/react/shallow'
import { McpExtensionToolLoader } from './McpExtensionToolLoader'
import {
  ExtensionTypeEnum,
  MCPExtension,
  fs,
  VectorDBExtension,
} from '@janhq/core'
import { ExtensionManager } from '@/lib/extension'
import { useAttachments } from '@/hooks/useAttachments'
import { toast } from 'sonner'
import { useAttachmentIngestionPrompt } from '@/hooks/useAttachmentIngestionPrompt'
import {
  NEW_THREAD_ATTACHMENT_KEY,
  useChatAttachments,
} from '@/hooks/useChatAttachments'

import {
  Attachment,
  createDocumentAttachment,
} from '@/types/attachment'
import JanBrowserExtensionDialog from '@/containers/dialogs/JanBrowserExtensionDialog'
import { useJanBrowserExtension } from '@/hooks/useJanBrowserExtension'
import { AssistantsMenu } from '@/components/AssistantsMenu'
import { Badge } from '@/components/ui/badge'
import { getLastUsedAgent, localStorageKey } from '@/constants/localStorage'
import { AttachmentThumbnailsRow } from '@/containers/AttachmentThumbnailsRow'
import { CodexBehaviorToolbar } from '@/containers/CodexBehaviorToolbar'
import {
  CodexReasoningDropdown,
  LlamacppReasoningDropdown,
} from '@/containers/ReasoningDropdown'
import { useCodexBehaviorState } from '@/hooks/useCodexBehaviorState'
import { useMediaAttachments } from '@/hooks/useMediaAttachments'
import DropdownAgent from '@/containers/DropdownAgent'
import DropdownModelProvider from '@/containers/DropdownModelProvider'

type ChatInputProps = {
  className?: string
  showSpeedToken?: boolean
  model?: ThreadModel
  initialMessage?: boolean
  projectId?: string
  onSubmit?: (
    text: string,
    files?: Array<{ type: string; mediaType: string; url: string }>
  ) => void
  onStop?: () => void
  chatStatus?: ChatStatus
  agentId?: string
  onAgentChange?: (agentId: string) => void
}

const getAgentWorkingDirectory = () => {
  try {
    return localStorage.getItem(localStorageKey.agentWorkingDirectory) ?? ''
  } catch {
    return ''
  }
}

const setAgentWorkingDirectory = (path: string) => {
  try {
    if (path) {
      localStorage.setItem(localStorageKey.agentWorkingDirectory, path)
    } else {
      localStorage.removeItem(localStorageKey.agentWorkingDirectory)
    }
  } catch {
    // ignore storage errors
  }
}

const getDirectoryLabel = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path


const ChatInput = memo(function ChatInput({
  className,
  initialMessage,
  projectId,
  model,
  onSubmit,
  onStop,
  chatStatus,
  agentId: agentIdProp,
  onAgentChange,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [isFocused, setIsFocused] = useState(false)
  const serviceHub = useServiceHub()
  const abortControllers = useAppState((state) => state.abortControllers)
  const tools = useAppState((state) => state.tools)
  const cancelToolCall = useAppState((state) => state.cancelToolCall)
  const prompt = usePrompt((state) => state.prompt)
  const setPrompt = usePrompt((state) => state.setPrompt)
  const addToHistory = usePrompt((state) => state.addToHistory)
  const navigateHistory = usePrompt((state) => state.navigateHistory)
  const currentThreadId = useThreads((state) => state.currentThreadId)
  const currentThread = useThreads((state) => state.getCurrentThread())
  const updateCurrentThreadAssistant = useThreads(
    (state) => state.updateCurrentThreadAssistant
  )
  const { t } = useTranslation()
  const spellCheckChatInput = useGeneralSetting(
    (state) => state.spellCheckChatInput
  )
  const tokenCounterCompact = useGeneralSetting(
    (state) => state.tokenCounterCompact
  )
  useTools()
  const router = useRouter()
  const createThread = useThreads((state) => state.createThread)
  const { 
    loading,
    currentAssistant,
    setCurrentAssistant,
    assistants
  } = useAssistant()

  // Get current thread messages for token counting
  const threadMessages = useMessages(
    useShallow((state) =>
      currentThreadId ? state.messages[currentThreadId] : []
    )
  )

  const maxRows = 10
  const ATTACHMENT_AUTO_INLINE_FALLBACK_BYTES = 512 * 1024

  const selectedModel = useModelProvider((state) => state.selectedModel)
  const selectedProvider = useModelProvider((state) => state.selectedProvider)
  const [message, setMessage] = useState('')
  const [dropdownToolsAvailable, setDropdownToolsAvailable] = useState(false)
  const [tooltipShown, setTooltipShown] = useState<
    'tools' | 'assistants' | false
  >(false)
  const activeModels = useAppState(useShallow((state) => state.activeModels))
  const wasPointerDown = useRef(false)

  const [workingDirectory, setWorkingDirectory] = useState(getAgentWorkingDirectory)

  const hasMmproj = useMemo(
    () => !!selectedModel?.capabilities?.includes('vision'),
    [selectedModel?.capabilities]
  )

  // Check if selected model is currently loaded/active
  const isModelActive = selectedModel?.id ? activeModels.includes(selectedModel.id) : false
  const [selectedAssistantId, setSelectedAssistantId] = useState<
    string | undefined
  >(loading ? undefined : currentAssistant?.id || '')

  useEffect(() => {
    setSelectedAssistantId(currentAssistant?.id || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])

  const avatar = currentThread
    ? assistants.find((a) => a.id === currentThread?.assistants?.[0]?.id)
        ?.avatar ||
      currentThread?.assistants?.[0]?.avatar ||
      ''
    : assistants.find((a) => a.id === selectedAssistantId)?.avatar || ''

  const assistantCount = assistants?.length || 0

  const { settings: codexSettings } = useCodexSettings()
  const { models: claudeModels } = useClaudeCodeModel()
  const { settings: hermesSettings } = useHermesSettings()
  const allProviders = useModelProvider((state) => state.providers)

  const localSelectedAgentId = agentIdProp ?? getLastUsedAgent()
  const localSelectedAgentType: AgentType =
    localSelectedAgentId === 'claude' ? 'claude' :
    localSelectedAgentId === 'hermes' ? 'hermes' :
    'codex'

  const modelLookup = useMemo(
    () => new Map(
      allProviders.flatMap((provider) =>
        provider.models.map((model) => [model.id, getModelDisplayName(model as never)])
      )
    ),
    [allProviders]
  )

  const contextBadges = useMemo(() => {
    const items: string[] = []

    if (localSelectedAgentType === 'codex') {
      const codexModel = codexSettings.model
      if (codexModel) {
        items.push(modelLookup.get(codexModel) ?? codexModel)
      }
      items.push(...codexSettings.mcpServerNames)
    }

    if (localSelectedAgentType === 'claude') {
      const claudeRoleKeys = ['medium', 'small', 'big'] as const
      claudeRoleKeys.forEach((roleKey) => {
        const modelId = claudeModels[roleKey]
        if (modelId) {
          items.push(modelLookup.get(modelId) ?? modelId)
        }
      })
    }

    if (localSelectedAgentType === 'hermes') {
      if (hermesSettings.model) items.push(hermesSettings.model)
      if (hermesSettings.provider) items.push(hermesSettings.provider)
    }

    return [...new Set(items.filter(Boolean))]
  }, [
    claudeModels,
    codexSettings.mcpServerNames,
    codexSettings.model,
    hermesSettings.model,
    hermesSettings.provider,
    modelLookup,
    localSelectedAgentType,
  ])

  // Jan Browser Extension hook
  const {
    hasConfig: hasJanBrowserMCPConfig,
    isActive: janBrowserMCPActive,
    isLoading: isJanBrowserMCPLoading,
    dialogOpen: extensionDialogOpen,
    dialogState: extensionDialogState,
    toggleBrowser: handleBrowseClick,
    handleCancel: handleExtensionDialogCancel,
    setDialogOpen: setExtensionDialogOpen,
  } = useJanBrowserExtension()

  // Check if model supports browser feature (requires both vision and tools)
  const modelSupportsBrowser = useMemo(() => {
    const capabilities = selectedModel?.capabilities || []
    return capabilities.includes('vision') && capabilities.includes('tools')
  }, [selectedModel?.capabilities])

  // Auto-disable browser feature when model doesn't support it
  useEffect(() => {
    if (janBrowserMCPActive && !modelSupportsBrowser) {
      handleBrowseClick()
    }
  }, [janBrowserMCPActive, modelSupportsBrowser, handleBrowseClick])

  const attachmentsEnabled = useAttachments((s) => s.enabled)
  const parsePreference = useAttachments((s) => s.parseMode)
  const maxFileSizeMB = useAttachments((s) => s.maxFileSizeMB)

  // Derived: any document currently processing (ingestion in progress)
  const attachmentsKey = currentThreadId ?? NEW_THREAD_ATTACHMENT_KEY
  const attachments = useChatAttachments(
    useCallback(
      (state) => state.getAttachments(attachmentsKey),
      [attachmentsKey]
    )
  )
  const setAttachmentsForThread = useChatAttachments(
    (state) => state.setAttachments
  )
  const clearAttachmentsForThread = useChatAttachments(
    (state) => state.clearAttachments
  )
  const transferAttachments = useChatAttachments(
    (state) => state.transferAttachments
  )
  const ingestingDocs = attachments.some(
    (a) => a.type === 'document' && a.processing
  )
  const ingestingAny = attachments.some((a) => a.processing)
  const hasSendableMedia = attachments.some(
    (a) => (a.type === 'image' || a.type === 'audio') && !!a.dataUrl
  )

  // Queued messages for this thread (shown as chips in the input area)
  const queuedMessages = useMessageQueue(
    useShallow((s) => s.getQueue(currentThreadId ?? ''))
  )
  const queueLength = queuedMessages.length

  const removeQueuedMessage = useCallback(
    (id: string) => {
      useMessageQueue.getState().removeMessage(currentThreadId ?? '', id)
    },
    [currentThreadId]
  )

  const lastTransferredThreadId = useRef<string | null>(null)

  useEffect(() => {
    if (
      currentThreadId &&
      lastTransferredThreadId.current !== currentThreadId
    ) {
      transferAttachments(NEW_THREAD_ATTACHMENT_KEY, currentThreadId)
      lastTransferredThreadId.current = currentThreadId
    }
  }, [currentThreadId, transferAttachments])

  // Check if there are active MCP servers
  const hasActiveMCPServers =
    tools.filter((tool) => tool.server !== 'Jan Browser MCP').length > 0

  // Get MCP extension and its custom component
  const extensionManager = ExtensionManager.getInstance()
  const mcpExtension = extensionManager.get<MCPExtension>(ExtensionTypeEnum.MCP)
  const MCPToolComponent = mcpExtension?.getToolComponent?.()

  const buildFilesFromAttachments = (atts: typeof attachments) => [
    ...atts
      .filter((att) => att.type === 'image' && att.dataUrl)
      .map((att) => ({
        type: 'file' as const,
        mediaType: att.mimeType ?? 'image/jpeg',
        url: att.dataUrl!,
      })),
    ...atts
      .filter((att) => att.type === 'audio' && att.dataUrl)
      .map((att) => ({
        type: 'file' as const,
        mediaType: att.audioFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav',
        url: att.dataUrl!,
      })),
  ]

  const handleSendMessage = async (prompt: string) => {
    if (!selectedModel) {
      setMessage('Please select a model to start chatting.')
      return
    }
    if (!prompt.trim() && !hasSendableMedia) {
      return
    }
    if (ingestingAny) {
      toast.info('Please wait for attachments to finish processing')
      return
    }

    setMessage('')
    addToHistory(prompt)

    // Use onSubmit prop if available (AI SDK), otherwise create thread and navigate
    if (onSubmit) {
      // When the model is still streaming, queue the message for later
      if (isStreaming && currentThreadId) {
        useMessageQueue.getState().enqueue(currentThreadId, {
          id: generateId(),
          text: prompt,
          createdAt: Date.now(),
        })
        setPrompt('')
        return
      }

      const files = buildFilesFromAttachments(attachments)

      onSubmit(prompt, files.length > 0 ? files : undefined)
      setPrompt('')
      clearAttachmentsForThread(attachmentsKey)
    } else {
      // No onSubmit provided - create a new thread and navigate to it
      // Store the initial message in sessionStorage for the thread page to read
      const isTemporaryChat = window.location.search.includes(
        `${TEMPORARY_CHAT_QUERY_ID}=true`
      )

      const files = buildFilesFromAttachments(attachments)

      const messagePayload = {
        text: prompt,
        files: files.length > 0 ? files : [],
      }

      if (isTemporaryChat) {
        // For temporary chat, store message and navigate to temporary thread
        sessionStorage.setItem(
          SESSION_STORAGE_KEY.INITIAL_MESSAGE_TEMPORARY,
          JSON.stringify(messagePayload)
        )
        sessionStorage.setItem('temp-chat-nav', 'true')
      
        router.navigate({
          to: route.threadsDetail,
          params: { threadId: TEMPORARY_CHAT_ID },
        })
      } else {
        // Get project metadata and assistant if projectId is provided
        let projectMetadata:
          | { id: string; name: string; updated_at: number }
          | undefined
        let projectAssistantId: string | undefined

        if (projectId) {
          try {
            const project = await serviceHub
              .projects()
              .getProjectById(projectId)
            if (project) {
              projectMetadata = {
                id: project.id,
                name: project.name,
                updated_at: project.updated_at,
              }
              projectAssistantId = project.assistantId
            }
          } catch (e) {
            console.warn('Failed to fetch project metadata:', e)
          }
        }

        // Only use assistant when chatting via project with an assigned assistant
        // When no projectId, use the selected assistant from dropdown (if any)
        const assistant = projectAssistantId
          ? assistants.find((a) => a.id === projectAssistantId)
          : assistants.find((a) => a.id === selectedAssistantId)

        setCurrentAssistant(assistant)

        const newThread = await createThread(
          {
            id: selectedModel?.id ?? defaultModel(selectedProvider),
            provider: selectedProvider,
          },
          prompt, // Use prompt as thread title
          assistant,
          projectMetadata
        )

        // Store the initial message for the new thread
        sessionStorage.setItem(
          `${SESSION_STORAGE_PREFIX.INITIAL_MESSAGE}${newThread.id}`,
          JSON.stringify(messagePayload)
        )

        router.navigate({
          to: route.threadsDetail,
          params: { threadId: newThread.id },
        })
      }

      setPrompt('')
      // Don't clear attachments here — document attachments stored under
      // NEW_THREAD_ATTACHMENT_KEY need to survive until the thread detail
      // page transfers and processes them.  The thread detail page's
      // processAndSendMessage already calls clearAttachmentsForThread after
      // processing is complete.
    }
  }

  useEffect(() => {
    const handleFocusIn = () => {
      if (document.activeElement === textareaRef.current) {
        setIsFocused(true)
      }
    }

    const handleFocusOut = () => {
      if (document.activeElement !== textareaRef.current) {
        setIsFocused(false)
      }
    }

    document.addEventListener('focusin', handleFocusIn)
    document.addEventListener('focusout', handleFocusOut)

    return () => {
      document.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('focusout', handleFocusOut)
    }
  }, [])

  // Focus when component mounts
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [])

  useEffect(() => {
    if (tooltipShown && dropdownToolsAvailable) {
      setTooltipShown(false)
    }
  }, [dropdownToolsAvailable, tooltipShown])

  // Focus when thread changes
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [currentThreadId])

  // Focus when streaming content finishes
  useEffect(() => {
    if (chatStatus !== 'submitted' && textareaRef.current) {
      // Small delay to ensure UI has updated
      setTimeout(() => {
        textareaRef.current?.focus()
      }, 10)
    }
  }, [chatStatus])

  const { codexBehavior, saveCodexBehaviorField } = useCodexBehaviorState({
    localSelectedAgentType,
    configFilePath: codexSettings.configFilePath,
  })

  const stopStreaming = useCallback(
    (threadId: string) => {
      // Use onStop prop if available (AI SDK), otherwise use legacy abort
      if (onStop) {
        onStop()
      } else {
        abortControllers[threadId]?.abort()
      }
      cancelToolCall?.()
      // Escalate: if the llama.cpp model is still processing after the HTTP
      // abort, force-unload it so generation actually stops. KV cache is lost.
      const modelId = selectedModel?.id
      if (selectedProvider === 'llamacpp' && modelId) {
        setTimeout(() => {
          invoke('plugin:llamacpp|force_stop_model', { modelId }).catch((e) => {
            console.warn('force_stop_model failed:', e)
          })
        }, 500)
      }
    },
    [abortControllers, cancelToolCall, onStop, selectedModel?.id, selectedProvider]
  )

  const audioSupported = !!selectedModel?.capabilities?.includes('audio')

  const {
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
  } = useMediaAttachments({
    attachmentsKey,
    currentThreadId,
    hasMmproj,
    audioSupported,
    setAttachmentsForThread,
    serviceHub,
    onError: setMessage,
    onClearError: () => setMessage(''),
    focusInput: () => textareaRef.current?.focus(),
  })

  const processNewDocumentAttachments = useCallback(
    async (docs: Attachment[]) => {
      if (!docs.length) return

      // Only collect the user's inline-vs-embeddings preference via the
      // dialog.  Actual ingestion is always deferred to send time
      // (processAttachmentsForSend inside processAndSendMessage).
      const docsNeedingPrompt = docs.filter((doc) => {
        if (doc.processed || doc.injectionMode) return false
        const preference = doc.parseMode ?? parsePreference
        return preference === 'prompt' || preference === 'auto'
      })

      if (docsNeedingPrompt.length > 0) {
        const choices = new Map<string, 'inline' | 'embeddings'>()
        for (let i = 0; i < docsNeedingPrompt.length; i++) {
          const doc = docsNeedingPrompt[i]
          const choice = await useAttachmentIngestionPrompt
            .getState()
            .showPrompt(
              doc,
              ATTACHMENT_AUTO_INLINE_FALLBACK_BYTES,
              i,
              docsNeedingPrompt.length
            )

          if (!choice) {
            // User cancelled — remove all pending docs
            setAttachmentsForThread(attachmentsKey, (prev) =>
              prev.filter(
                (att) =>
                  !docsNeedingPrompt.some(
                    (d) => d.path && att.path && d.path === att.path
                  )
              )
            )
            return
          }

          if (doc.path) {
            choices.set(doc.path, choice)
          }
        }

        // Persist each document's chosen mode so processAttachmentsForSend
        // can pick it up at send time.
        if (choices.size > 0) {
          setAttachmentsForThread(attachmentsKey, (prev) =>
            prev.map((att) => {
              const mode = att.path ? choices.get(att.path) : undefined
              return mode ? { ...att, parseMode: mode } : att
            })
          )
        }
      }
    },
    [
      ATTACHMENT_AUTO_INLINE_FALLBACK_BYTES,
      attachmentsKey,
      parsePreference,
      setAttachmentsForThread,
    ]
  )

  const handleAttachDocsIngest = async () => {
    try {
      if (!attachmentsEnabled) {
        toast.info('Attachments are disabled in Settings')
        return
      }
      const selection = await serviceHub.dialog().open({
        multiple: true,
        filters: [
          {
            name: 'Documents & Code',
            extensions: [
              // Documents
              'pdf',
              'docx',
              'txt',
              'md',
              'csv',
              'xlsx',
              'xls',
              'ods',
              'pptx',
              'html',
              'htm',
              // JavaScript / TypeScript
              'js',
              'mjs',
              'cjs',
              'ts',
              'mts',
              'cts',
              'jsx',
              'tsx',
              // Python
              'py',
              'pyw',
              'pyi',
              // C / C++
              'c',
              'h',
              'cpp',
              'cc',
              'cxx',
              'hpp',
              'hh',
              // Systems languages
              'rs',
              'go',
              'swift',
              'zig',
              // JVM languages
              'java',
              'kt',
              'kts',
              'scala',
              'groovy',
              // Scripting languages
              'rb',
              'php',
              'lua',
              'pl',
              'r',
              'jl',
              // .NET
              'cs',
              'fs',
              'vb',
              'xaml',
              'csproj',
              'sln',
              // CUDA
              'cu',
              'cuh',
              // Shaders
              'hlsl',
              'glsl',
              'cg',
              'shader',
              // Shell
              'sh',
              'bash',
              'zsh',
              'fish',
              'ps1',
              'bat',
              'cmd',
              'vbs',
              // More languages
              'asm',
              's',
              'm',
              'mm',
              'pas',
              'pp',
              'erl',
              'hrl',
              'ex',
              'exs',
              'clj',
              'cljs',
              'hs',
              'lhs',
              'ml',
              'mli',
              'f',
              'f90',
              // Web
              'css',
              'scss',
              'sass',
              'less',
              'vue',
              'svelte',
              'astro',
              'php',
              'asp',
              'aspx',
              'jsp',
              // Data / config formats
              'json',
              'jsonc',
              'yaml',
              'yml',
              'toml',
              'xml',
              'ini',
              'cfg',
              'conf',
              'env',
              'properties',
              'dockerfile',
              'makefile',
              'cmake',
              'lock',
              // Query / markup
              'sql',
              'graphql',
              'gql',
              'tex',
              'rst',
              'adoc',
              'textile',
              // Misc text
              'log',
              'diff',
              'patch',
              'gitignore',
            ],
          },
          {
            name: 'All Files',
            extensions: ['*'],
          },
        ],
      })
      if (!selection) return
      const paths = Array.isArray(selection) ? selection : [selection]
      if (!paths.length) return

      // Prepare attachments with file sizes
      const preparedAttachments: Attachment[] = []
      for (const p of paths) {
        const name = p.split(/[\\/]/).pop() || p
        const fileType = name.split('.').pop()?.toLowerCase()
        let size: number | undefined = undefined
        try {
          const stat = await fs.fileStat(p)
          size = stat?.size ? Number(stat.size) : undefined
        } catch (e) {
          console.warn('Failed to read file size for', p, e)
        }
        preparedAttachments.push(
          createDocumentAttachment({
            name,
            path: p,
            fileType,
            size,
            parseMode: parsePreference,
          })
        )
      }

      const maxFileSizeBytes =
        typeof maxFileSizeMB === 'number' && maxFileSizeMB > 0
          ? maxFileSizeMB * 1024 * 1024
          : undefined

      if (maxFileSizeBytes !== undefined) {
        const hasOversized = preparedAttachments.some(
          (att) => typeof att.size === 'number' && att.size > maxFileSizeBytes
        )
        if (hasOversized) {
          toast.error('File too large', {
            description: `One or more files exceed the ${maxFileSizeMB}MB limit`,
          })
          return
        }
      }

      let duplicates: string[] = []
      let newDocAttachments: Attachment[] = []

      setAttachmentsForThread(attachmentsKey, (currentAttachments) => {
        const existingPaths = new Set(
          currentAttachments
            .filter((a) => a.type === 'document' && a.path)
            .map((a) => a.path)
        )

        duplicates = []
        newDocAttachments = []

        for (const att of preparedAttachments) {
          if (existingPaths.has(att.path)) {
            duplicates.push(att.name)
            continue
          }
          newDocAttachments.push(att)
        }

        return newDocAttachments.length > 0
          ? [...currentAttachments, ...newDocAttachments]
          : currentAttachments
      })

      if (duplicates.length > 0) {
        toast.warning('Files already attached', {
          description: `${duplicates.join(', ')} ${duplicates.length === 1 ? 'is' : 'are'} already in the list`,
        })
      }

      if (newDocAttachments.length > 0) {
        await processNewDocumentAttachments(newDocAttachments)
      }
    } catch (e) {
      console.error('Failed to attach documents:', e)
      const desc = e instanceof Error ? e.message : JSON.stringify(e)
      toast.error('Failed to attach documents', { description: desc })
    }
  }

  const handleRemoveAttachment = async (indexToRemove: number) => {
    const attachmentToRemove = attachments[indexToRemove]

    // If attachment was ingested (has an ID), delete it from the backend
    if (attachmentToRemove?.id && currentThreadId) {
      try {
        if (attachmentToRemove.type === 'document') {
          const vectorDBExtension = ExtensionManager.getInstance().get(
            ExtensionTypeEnum.VectorDB
          ) as VectorDBExtension | undefined

          if (vectorDBExtension?.deleteFile) {
            await vectorDBExtension.deleteFile(
              currentThreadId,
              attachmentToRemove.id
            )
          }
        }
      } catch (error) {
        console.error('Failed to delete attachment from backend:', error)
        toast.error('Failed to remove attachment', {
          description: error instanceof Error ? error.message : String(error),
        })
        return
      }
    }

    setAttachmentsForThread(attachmentsKey, (prev) =>
      prev.filter((_, index) => index !== indexToRemove)
    )
  }

  const handleSelectWorkingDirectory = async () => {
    try {
      const selectedPath = await serviceHub.dialog().open({
        multiple: false,
        directory: true,
        defaultPath: workingDirectory || undefined,
      })

      if (typeof selectedPath === 'string' && selectedPath !== workingDirectory) {
        setWorkingDirectory(selectedPath)
        setAgentWorkingDirectory(selectedPath)
      }
    } catch (error) {
      console.error('Failed to select working directory:', error)
    }
  }


  const isStreaming = chatStatus === 'submitted' || chatStatus === 'streaming'

  return (
    <div className="relative">
      <div className="relative">
        <div
          className={cn(
            'relative overflow-hidden p-0.5 rounded-3xl'
          )}
        >
          {isStreaming && (
            <div className="absolute inset-0">
              <MovingBorder rx="10%" ry="10%">
                <div
                  className={cn(
                    'h-100 w-100 bg-[radial-gradient(var(--app-primary),transparent_60%)]'
                  )}
                />
              </MovingBorder>
            </div>
          )}

          <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
            <Button
              variant="outline"
              size="xs"
              className="h-7"
              onClick={() => void handleSelectWorkingDirectory()}
            >
              <IconFolderCode size={10} />
              {workingDirectory ? getDirectoryLabel(workingDirectory) : (
              <span className="text-xs text-muted-foreground">
                No folder selected
              </span>
            )}
            </Button>
            {agentIdProp !== undefined && (
              <DropdownAgent
                selectedAgentId={agentIdProp ?? getLastUsedAgent()}
                onSelectAgent={(id) => onAgentChange?.(id)}
              />
            )}
            <DropdownModelProvider model={model} />
            {contextBadges.map((item) => (
              <Badge
                key={item}
                variant="outline"
                className="border-input/70 bg-background/60 px-2.5 py-1 text-xs text-muted-foreground"
              >
                {item}
              </Badge>
            ))}
          </div>

          <div
            className={cn(
              'relative z-20 px-0 pb-10 border rounded-3xl border-input bg-white dark:bg-input/30',
              isFocused && 'ring-1 ring-ring/50',
              isDragOver && 'ring-2 ring-ring/50 border-primary'
            )}
            data-drop-zone={dropAcceptsAnything ? 'true' : undefined}
            onDragEnter={dropAcceptsAnything ? handleDragEnterOrOver : undefined}
            onDragLeave={dropAcceptsAnything ? handleDragLeave : undefined}
            onDragOver={dropAcceptsAnything ? handleDragEnterOrOver : undefined}
            onDrop={dropAcceptsAnything ? handleDrop : undefined}
          >
            <AttachmentThumbnailsRow
              attachments={attachments}
              onRemove={handleRemoveAttachment}
            />
            {queuedMessages.length > 0 && (
              <div className="flex flex-col gap-1 px-3 pt-2 pb-0">
                {queuedMessages.map((msg) => (
                  <QueuedMessageChip
                    key={msg.id}
                    message={msg}
                    onEdit={(queued) => {
                      // Put the text back in the input for editing, remove from queue
                      setPrompt(queued.text)
                      removeQueuedMessage(queued.id)
                      textareaRef.current?.focus()
                    }}
                    onRemove={removeQueuedMessage}
                  />
                ))}
              </div>
            )}
            <TextareaAutosize
              dir="auto"
              ref={textareaRef}
              minRows={2}
              rows={1}
              maxRows={10}
              value={prompt}
              data-testid={'chat-input'}
              onChange={(e) => {
                setPrompt(e.target.value)
              }}
              onKeyDown={(e) => {
                // e.keyCode 229 is for IME input with Safari
                const isComposing =
                  e.nativeEvent.isComposing || e.keyCode === 229
                if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
                  e.preventDefault()
                  // Submit prompt when Enter is pressed without Shift and prompt is not empty.
                  // If streaming, handleSendMessage will queue the message automatically.
                  if ((prompt.trim() || hasSendableMedia) && !ingestingAny) {
                    handleSendMessage(prompt)
                  }
                  // When Shift+Enter is pressed, a new line is added (default behavior)
                }
                // Navigate prompt history with Up/Down arrow keys
                if (e.key === 'ArrowUp' && !isComposing) {
                  const textarea = e.currentTarget
                  const cursorAtStart =
                    textarea.selectionStart === 0 &&
                    textarea.selectionEnd === 0
                  if (cursorAtStart || !prompt) {
                    e.preventDefault()
                    navigateHistory('up')
                  }
                }
                if (e.key === 'ArrowDown' && !isComposing) {
                  const textarea = e.currentTarget
                  const cursorAtEnd =
                    textarea.selectionStart === prompt.length &&
                    textarea.selectionEnd === prompt.length
                  if (cursorAtEnd) {
                    e.preventDefault()
                    navigateHistory('down')
                  }
                }
              }}
              onPaste={handlePaste}
              placeholder={t('common:placeholder.chatInput')}
              autoFocus
              spellCheck={spellCheckChatInput}
              data-gramm={spellCheckChatInput}
              data-gramm_editor={spellCheckChatInput}
              data-gramm_grammarly={spellCheckChatInput}
              className={cn(
                'bg-transparent pt-4 w-full shrink-0 border-none resize-none outline-0 px-4',
                (prompt.match(/\n/g)?.length ?? 0) + 1 < maxRows && 'scrollbar-hide',
                className
              )}
            />
          </div>
        </div>

        <div className="absolute z-20 bg-transparent bottom-0 w-full p-2 ">
          <div className="flex justify-between items-center w-full">
            <div className="px-1 flex items-center gap-1 flex-1 min-w-0">
              <div
                className={cn(
                  'px-1 flex items-center w-full gap-1',
                  isStreaming && 'opacity-50 pointer-events-none'
                )}
              >
                {/* Attachments dropdown */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="secondary" size="icon-sm" className='rounded-full mr-2 mb-1'>
                      <PlusIcon size={18} className="text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {hasMmproj && (
                      <DropdownMenuItem onClick={() => void openImagePicker()}>
                        <IconPhoto size={18} className="text-muted-foreground" />
                        <span>Add Images</span>
                        <input
                          type="file"
                          ref={fileInputRef}
                          className="hidden"
                          multiple
                          onChange={handleFileChange}
                        />
                      </DropdownMenuItem>
                    )}
                    {audioSupported && (
                      <DropdownMenuItem onClick={() => void openAudioPicker()}>
                        <IconMusic size={18} className="text-muted-foreground" />
                        <span>Add Audio</span>
                        <input
                          type="file"
                          ref={audioInputRef}
                          className="hidden"
                          multiple
                          accept="audio/wav,audio/mpeg,.wav,.mp3"
                          onChange={handleAudioFileChange}
                        />
                      </DropdownMenuItem>
                    )}
                    {/* RAG document attachments - desktop-only via dialog; shown when feature enabled */}
                    <DropdownMenuItem
                      onClick={handleAttachDocsIngest}
                      disabled={!selectedModel?.capabilities?.includes('tools')}
                    >
                      {ingestingDocs ? (
                        <IconLoader2
                          size={18}
                          className="text-muted-foreground animate-spin"
                        />
                      ) : (
                        <IconPaperclip
                          size={18}
                          className="text-muted-foreground"
                        />
                      )}
                      <span>
                        {ingestingDocs
                          ? 'Indexing documents…'
                          : 'Add documents or files'}
                      </span>
                    </DropdownMenuItem>
                    {/* Use Assistant - only show when no projectId */}
                    {!projectId && assistantCount < 2 && (
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <IconUser size={18} className="text-muted-foreground" />
                          <span>Use Assistant</span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="max-h-64 overflow-y-auto">
                          <AssistantsMenu
                            selectedAssistant={selectedAssistantId}
                            setSelectedAssistant={setSelectedAssistantId}
                            currentThread={currentThread}
                            updateCurrentThreadAssistant={
                              updateCurrentThreadAssistant
                            }
                            assistants={assistants}
                          />
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    )}
                    </DropdownMenuContent>
                </DropdownMenu>
                {!projectId && assistantCount >= 2 && (
                  <DropdownMenu>
                    <Tooltip
                      open={tooltipShown === 'assistants'}
                      onOpenChange={(newValue) =>
                        setTooltipShown(newValue ? 'assistants' : false)
                      }
                    >
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger
                          asChild
                          onPointerDown={() => {
                            wasPointerDown.current = true
                          }}
                          onKeyDown={() => {
                            wasPointerDown.current = false
                          }}
                        >
                          <Button
                            variant="secondary"
                            size="icon-sm"
                            className="rounded-full mr-2 mb-1"
                          >
                            {avatar && (
                              <AvatarEmoji
                                avatar={avatar}
                                imageClassName="w-4 h-4 object-contain"
                                textClassName="text-xs relative inline-block"
                              />
                            )}
                            {!avatar && (
                              <IconUser
                                size={18}
                                className="text-muted-foreground"
                              />
                            )}
                          </Button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{t('assistants')}</p>
                      </TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent
                      onCloseAutoFocus={(event) => {
                        if (wasPointerDown.current) {
                          event.preventDefault()
                        }
                      }}
                      align="start"
                    >
                      <AssistantsMenu
                        selectedAssistant={selectedAssistantId}
                        setSelectedAssistant={setSelectedAssistantId}
                        currentThread={currentThread}
                        updateCurrentThreadAssistant={
                          updateCurrentThreadAssistant
                        }
                        assistants={assistants}
                      />
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <SamplerPopover
                  providerId={selectedProvider}
                  modelId={selectedModel?.id}
                  assistantSwitcher={
                    !projectId
                      ? {
                          assistants,
                          currentThread,
                          selectedAssistantId,
                          setSelectedAssistantId,
                          updateCurrentThreadAssistant,
                        }
                      : undefined
                  }
                />
                {hasJanBrowserMCPConfig && modelSupportsBrowser && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={isJanBrowserMCPLoading}
                        className={cn(janBrowserMCPActive && "text-primary")}
                        onClick={
                          isJanBrowserMCPLoading
                            ? undefined
                            : handleBrowseClick
                        }
                      >
                        {isJanBrowserMCPLoading ? (
                          <IconLoader2
                            size={18}
                            className="text-primary animate-spin"
                          />
                        ) : (
                          <IconBrandChrome
                            size={18}
                            className={cn(
                              'text-muted-foreground',
                              janBrowserMCPActive && 'text-primary'
                            )}
                          />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>
                        {isJanBrowserMCPLoading
                          ? 'Starting...'
                          : janBrowserMCPActive
                            ? 'Browse (Active)'
                            : 'Browse'}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                )}

                {selectedModel?.capabilities?.includes('embeddings') && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                          variant="ghost"
                          size="icon-xs"
                        >
                        <IconCodeCircle2
                          size={18}
                          className="text-muted-foreground"
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('embeddings')}</p>
                    </TooltipContent>
                  </Tooltip>
                )}

                {selectedModel?.capabilities?.includes('tools') &&
                  hasActiveMCPServers &&
                  (MCPToolComponent ? (
                    // Use custom MCP component
                    <McpExtensionToolLoader
                      tools={tools}
                      hasActiveMCPServers={hasActiveMCPServers}
                      selectedModelHasTools={
                        selectedModel?.capabilities?.includes('tools') ?? false
                      }
                      initialMessage={initialMessage}
                      MCPToolComponent={MCPToolComponent}
                    />
                  ) : (
                    // Use default tools dropdown
                    <Tooltip
                      open={tooltipShown === 'tools'}
                      onOpenChange={(newValue) => newValue ? setTooltipShown('tools') : setTooltipShown(false)}
                    >
                      <TooltipTrigger
                        asChild
                        disabled={dropdownToolsAvailable}
                      >
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={(e) => {
                            setDropdownToolsAvailable(false)
                            e.stopPropagation()
                          }}
                        >
                          <DropdownToolsAvailable
                            initialMessage={initialMessage}
                            onOpenChange={(isOpen) => {
                              setDropdownToolsAvailable(isOpen)
                              if (isOpen) {
                                setTooltipShown(false)
                              }
                            }}
                          >
                            {() => {
                              return (
                                <div
                                  className={cn(
                                    'p-1 flex items-center justify-center rounded-sm transition-all duration-200 ease-in-out gap-1 cursor-pointer',
                                  )}
                                >
                                  <IconTool
                                    size={18}
                                    className={cn(
                                      'text-muted-foreground',
                                    )}
                                  />
                                </div>
                              )
                            }}
                          </DropdownToolsAvailable>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{t('tools')}</p>
                      </TooltipContent>
                    </Tooltip>
                  ))}

                {selectedModel?.capabilities?.includes('web_search') && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-xs">
                        <IconWorld
                          size={18}
                          className="text-muted-foreground"
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Web Search</p>
                    </TooltipContent>
                  </Tooltip>
                )}

                {selectedProvider === 'llamacpp' && (
                  localSelectedAgentType === 'codex'
                    ? (
                      <CodexReasoningDropdown
                        codexBehavior={codexBehavior}
                        saveField={saveCodexBehaviorField}
                      />
                    ) : (
                      <LlamacppReasoningDropdown
                        selectedModel={selectedModel}
                        selectedProvider={selectedProvider}
                      />
                    )
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {selectedProvider === 'llamacpp' &&
                tokenCounterCompact &&
                !initialMessage &&
                (threadMessages?.length > 0 || prompt.trim().length > 0) && (
                  <div className="flex-1 flex justify-center">
                    <TokenCounter
                      messages={threadMessages || []}
                      compact={true}
                    />
                  </div>
                )}

              {isStreaming ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="destructive"
                      size="icon-sm"
                      className="rounded-full mr-1 mb-1"
                      onClick={() => {
                        if (!currentThreadId) return
                        const queue = useMessageQueue.getState().getQueue(currentThreadId)
                        if (queue.length > 0) {
                          useMessageQueue.getState().clearQueue(currentThreadId)
                        } else {
                          stopStreaming(currentThreadId)
                        }
                      }}
                    >
                      <IconPlayerStopFilled />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{queueLength > 0 ? `Clear ${queueLength} queued message(s)` : 'Stop generating'}</p>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Button
                  variant="default"
                  size="icon-sm"
                  disabled={(!prompt.trim() && !hasSendableMedia) || ingestingAny}
                  data-test-id="send-message-button"
                  onClick={() => handleSendMessage(prompt)}
                  className="rounded-full mr-1 mb-1"
                >
                  <ArrowRight className="text-primary-fg" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      {localSelectedAgentType === 'codex' && (
        <CodexBehaviorToolbar
          codexBehavior={codexBehavior}
          saveField={saveCodexBehaviorField}
        />
      )}

      {message && (
        <div className="-mt-0.5 mx-2 pb-2 px-3 pt-1.5 rounded-b-lg text-xs text-destructive transition-all duration-200 ease-in-out">
          <div className="flex items-center gap-1 justify-between">
            {message}
            <IconX
              className="size-3 text-muted-foreground cursor-pointer"
              onClick={() => {
                setMessage('')
                // Reset file input to allow re-uploading the same file
                if (fileInputRef.current) {
                  fileInputRef.current.value = ''
                }
              }}
            />
          </div>
        </div>
      )}

      {selectedProvider === 'llamacpp' &&
        isModelActive &&
        !tokenCounterCompact &&
        !initialMessage &&
        (threadMessages?.length > 0 || prompt.trim().length > 0) && (
          <div className="flex-1 w-full flex justify-start px-2">
            <TokenCounter messages={threadMessages || []} />
          </div>
        )}

      <JanBrowserExtensionDialog
        open={extensionDialogOpen}
        onOpenChange={setExtensionDialogOpen}
        state={extensionDialogState}
        onCancel={handleExtensionDialogCancel}
      />
    </div>
  )
})

export default ChatInput
