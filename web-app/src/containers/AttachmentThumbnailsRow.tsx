import { cn, formatBytes } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { IconMusic, IconPaperclip, IconX } from '@tabler/icons-react'
import type { Attachment } from '@/types/attachment'

type Props = {
  attachments: Attachment[]
  onRemove: (index: number) => void
}

export function AttachmentThumbnailsRow({ attachments, onRemove }: Props) {
  if (attachments.length === 0) return null

  return (
    <div className="flex flex-col gap-2 p-2 pb-0">
      <div className="flex gap-3 items-center">
        {attachments.map((att, idx) => {
          const isImage = att.type === 'image'
          const isAudio = att.type === 'audio'
          const ext = att.fileType || att.mimeType?.split('/')[1]
          const durLabel =
            isAudio && typeof att.durationSec === 'number'
              ? `${Math.floor(att.durationSec / 60)}:${Math.floor(att.durationSec % 60)
                  .toString()
                  .padStart(2, '0')}`
              : undefined

          return (
            <div key={`${att.type}-${idx}-${att.name}`} className="relative">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className={cn(
                      'relative border rounded-xl size-14 overflow-hidden',
                      'flex items-center justify-center'
                    )}
                  >
                    {isImage && att.dataUrl ? (
                      <img
                        className="object-cover w-full h-full"
                        src={att.dataUrl}
                        alt={att.name}
                      />
                    ) : isAudio ? (
                      <div className="flex flex-col items-center justify-center text-muted-foreground">
                        <IconMusic size={20} />
                        {durLabel && (
                          <span className="text-[10px] leading-none mt-0.5 tabular-nums opacity-70">
                            {durLabel}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center text-muted-foreground">
                        <IconPaperclip size={18} />
                        {ext && (
                          <span className="text-[10px] leading-none mt-0.5 uppercase opacity-70">
                            .{ext}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <div className="text-xs">
                    <div className="font-medium truncate max-w-52" title={att.name}>
                      {att.name}
                    </div>
                    <div className="opacity-70">
                      {isImage
                        ? att.mimeType || 'image'
                        : isAudio
                          ? att.audioFormat
                            ? `.${att.audioFormat}${durLabel ? ` · ${durLabel}` : ''}`
                            : 'audio'
                          : ext
                            ? `.${ext}`
                            : 'document'}
                      {att.size
                        ? ` · ${formatBytes(att.size, {
                            decimals: (_, unit) => (unit === 'B' ? 0 : 1),
                          })}`
                        : ''}
                    </div>
                    {isAudio && att.dataUrl && (
                      <audio controls src={att.dataUrl} className="mt-1 w-56" />
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>

              {!att.processing && (
                <div
                  className="absolute -top-1 -right-2.5 bg-destructive size-5 flex rounded-full items-center justify-center cursor-pointer"
                  onClick={() => onRemove(idx)}
                >
                  <IconX className="text-neutral-200" size={14} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
