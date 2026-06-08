import { LucideIcon } from 'lucide-react'
import { route } from '@/constants/routes'

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { useTranslation } from '@/i18n/react-i18next-compat'

import { Link, useNavigate } from '@tanstack/react-router'
import { PlatformMetaKey } from '@/containers/PlatformMetaKey'
import React, { useRef } from 'react'
import {
  SearchIcon,
  type SearchIconHandle,
} from '@/components/animated-icon/search'
import {
  type FolderPlusIconHandle,
} from '@/components/animated-icon/folder-plus'
import {
  MessageCircleIcon,
  type MessageCircleIconHandle,
} from '@/components/animated-icon/message-circle'
import {
  SettingsIcon,
  type SettingsIconHandle,
} from '@/components/animated-icon/settings'
import { BlocksIcon, type BlocksIconHandle } from '../animated-icon/blocks'
import {
  type BotIconHandle,
} from '@/components/animated-icon/bot'
import AddProjectDialog from '@/containers/dialogs/AddProjectDialog'
import { SearchDialog } from '@/containers/dialogs/SearchDialog'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useProjectDialog } from '@/hooks/useProjectDialog'
import { PlatformShortcuts, ShortcutAction } from '@/lib/shortcuts'
import { SidebarMode } from '@/hooks/useSidebarMode'

type AnimatedIconHandle =
  | SearchIconHandle
  | FolderPlusIconHandle
  | MessageCircleIconHandle
  | SettingsIconHandle
  | BlocksIconHandle
  | BotIconHandle

type NavMainItem = {
  title: string
  url?: string
  type?: SidebarMode,
  icon?: LucideIcon | React.ComponentType<{ className?: string }>
  animatedIcon?: React.ForwardRefExoticComponent<
    {
      className?: string
      size?: number
    } & React.RefAttributes<AnimatedIconHandle>
  >
  isActive?: boolean
  shortcut?: React.ReactNode
  onClick?: () => void
}

const getNavMainItems = (
  onSearch: () => void,
  onNewChat: () => void,
): NavMainItem[] => [
  {
    title: 'common:newSession',
    animatedIcon: MessageCircleIcon,
    type: 'chat',
    onClick: onNewChat,
    shortcut: (
      <KbdGroup className="ml-auto scale-90 gap-0">
        <Kbd className="bg-transparent size-3">
          <PlatformMetaKey />
        </Kbd>
        <Kbd className="bg-transparent size-3 uppercase">{PlatformShortcuts[ShortcutAction.NEW_AGENT_CHAT].key}</Kbd>
      </KbdGroup>
    ),
  },
  {
    title: 'common:search',
    animatedIcon: SearchIcon,
    onClick: onSearch,
    shortcut: (
      <KbdGroup className="ml-auto scale-90 gap-0">
        <Kbd className="bg-transparent size-3">
          <PlatformMetaKey />
        </Kbd>
        <Kbd className="bg-transparent size-3 uppercase">{PlatformShortcuts[ShortcutAction.SEARCH].key} </Kbd>
      </KbdGroup>
    ),
  },
  {
    title: 'common:hub',
    url: route.hub.index,
    animatedIcon: BlocksIcon,
  },
  {
    title: 'common:settings',
    url: route.settings.general,
    animatedIcon: SettingsIcon,
  },
]

function NavMainItemWithAnimatedIcon({
  item,
  label,
}: {
  item: NavMainItem
  label: string
}) {
  const iconRef = useRef<AnimatedIconHandle>(null)
  const AnimatedIcon = item.animatedIcon!

  const content = (
    <>
      <AnimatedIcon ref={iconRef} className="text-foreground/70" size={16} />
      <span>{label}</span>
      {item.shortcut}
    </>
  )

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild={!!item.url}
        isActive={item.isActive}
        onMouseEnter={() => iconRef.current?.startAnimation()}
        onMouseLeave={() => iconRef.current?.stopAnimation()}
        onClick={item.onClick}
      >
        {item.url ? <Link to={item.url}>{content}</Link> : content}
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

export function NavMain() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { addFolder } = useThreadManagement()
  const { open: searchOpen, setOpen: setSearchOpen } = useSearchDialog()
  const { open: projectDialogOpen, setOpen: setProjectDialogOpen } =
    useProjectDialog()
  const navMainItems = getNavMainItems(
    () => setSearchOpen(true),
    () => {
      // useAgentMode.getState().removeThread(TEMPORARY_CHAT_ID)
      navigate({ to: route.home })
    },
  )

  const handleCreateProject = async (name: string, assistantId?: string) => {
    const newProject = await addFolder(name, assistantId)
    setProjectDialogOpen(false)
    navigate({
      to: '/project/$projectId',
      params: { projectId: newProject.id },
    })
  }

  return (
    <>
      <SidebarMenu>
        {navMainItems.map((item) => {
          if (item.animatedIcon) {
            return (
              <NavMainItemWithAnimatedIcon
                key={item.title}
                item={item}
                label={t(item.title)}
              />
            )
          }

          const Icon = item.icon
          return (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                asChild={!!item.url}
                isActive={item.isActive}
                onClick={item.onClick}
              >
                {item.url ? (
                  <Link to={item.url}>
                    {Icon && <Icon className="text-foreground/70" />}
                    <span>{t(item.title)}</span>
                    {item.shortcut}
                  </Link>
                ) : (
                  <>
                    {Icon && <Icon className="text-foreground/70" />}
                    <span>{t(item.title)}</span>
                    {item.shortcut}
                  </>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>

      <AddProjectDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
        editingKey={null}
        onSave={handleCreateProject}
      />

      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  )
}
