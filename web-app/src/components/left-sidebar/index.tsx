import { DownloadManagement } from '@/containers/DownloadManegement'
import { NavChats } from './NavChats'
import { NavCowork } from './NavCowork'
import { NavMain } from './NavMain'
import { NavProjects } from './NavProjects'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useSidebarMode } from '@/hooks/useSidebarMode'
import { useTranslation } from '@/i18n/react-i18next-compat'

import {
  Sidebar,
  SidebarContent,
  SidebarTrigger,
  SidebarHeader,
  SidebarRail,
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { MessageCircleIcon } from '@/components/animated-icon/message-circle'
import { BotIcon } from '@/components/animated-icon/bot'
import { Workflow } from 'lucide-react'

export function LeftSidebar() {
  const { t } = useTranslation()
  const { open: isLeftPanelOpen } = useLeftPanel()
  const { mode, setMode } = useSidebarMode()

  return (
    <div className="relative z-50">
      <Sidebar variant="floating" collapsible="offcanvas">
        <SidebarHeader className="flex px-1">
          <div className={cn("flex items-center w-full justify-between", IS_MACOS && "justify-end")}>
            {!IS_MACOS && <span className="ml-2 font-medium font-studio">Buro</span>}
            <div>
              {isLeftPanelOpen && <DownloadManagement />}
              <SidebarTrigger className="text-muted-foreground rounded-full hover:bg-sidebar-foreground/8! -mt-0.5 relative z-50 ml-0.5" />
            </div>
          </div>

          {/* Chat / Cowork / Agents toggle */}
          <div className="flex mx-1 mt-1 mb-0.5 p-0.5 bg-sidebar-foreground/6 rounded-lg">
            <button
              type="button"
              aria-pressed={mode === 'chat'}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 py-1 text-xs font-medium rounded-md transition-all',
                mode === 'chat'
                  ? 'bg-background shadow-sm text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setMode('chat')}
            >
              <MessageCircleIcon size={14} />
              {t('common:chats')}
            </button>
            <button
              type="button"
              aria-pressed={mode === 'cowork'}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 py-1 text-xs font-medium rounded-md transition-all',
                mode === 'cowork'
                  ? 'bg-background shadow-sm text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setMode('cowork')}
            >
              <Workflow size={14} />
              {t('common:cowork')}
            </button>
            <button
              type="button"
              aria-pressed={mode === 'agents'}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 py-1 text-xs font-medium rounded-md transition-all',
                mode === 'agents'
                  ? 'bg-background shadow-sm text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setMode('agents')}
            >
              <BotIcon size={14} />
              {t('common:agents')}
            </button>
          </div>

          <NavMain />
        </SidebarHeader>
        <SidebarContent className="mask-b-from-95% mask-t-from-98%">
          {mode === 'cowork' ? (
            <NavCowork />
          ) : (
            <>
              <NavProjects />
              <NavChats />
            </>
          )}
        </SidebarContent>
        <SidebarRail />
      </Sidebar>
    </div>
  )
}
