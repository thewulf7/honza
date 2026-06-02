import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuAction,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  FolderIcon,
  ClockIcon,
  ActivityIcon,
  SendIcon,
  SlidersIcon,
  MoreHorizontal,
  Trash2,
  CheckIcon,
  CircleIcon,
  CircleDotIcon,
} from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { route } from '@/constants/routes'
import { useCoworkTasks, CoworkTask, CoworkTaskStatus } from '@/hooks/useCoworkTasks'

function StatusDot({ status }: { status: CoworkTaskStatus }) {
  if (status === 'running') {
    return <CircleDotIcon size={8} className="text-blue-500 shrink-0" />
  }
  if (status === 'completed') {
    return <CircleIcon size={8} className="text-muted-foreground/40 shrink-0" />
  }
  return <CircleIcon size={8} className="text-muted-foreground shrink-0" />
}

function TaskItem({ task }: { task: CoworkTask }) {
  const { updateTask, deleteTask } = useCoworkTasks()

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild>
        <Link to={route.cowork} search={{ taskId: task.id } as any}>
          <StatusDot status={task.status} />
          <span className="truncate">{task.title}</span>
        </Link>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction showOnHover className="hover:bg-sidebar-foreground/8">
            <MoreHorizontal size={14} />
            <span className="sr-only">More</span>
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-44">
          {task.status !== 'completed' && (
            <DropdownMenuItem onSelect={() => updateTask(task.id, { status: 'completed' })}>
              <CheckIcon className="text-muted-foreground" />
              <span>Mark complete</span>
            </DropdownMenuItem>
          )}
          {task.status === 'completed' && (
            <DropdownMenuItem onSelect={() => updateTask(task.id, { status: 'pending' })}>
              <CircleIcon className="text-muted-foreground" />
              <span>Reopen</span>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => deleteTask(task.id)}>
            <Trash2 />
            <span>Delete</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}

export function NavCowork() {
  const { t } = useTranslation()
  const { tasks } = useCoworkTasks()

  const dispatchTasks = tasks.filter(
    (t) => t.status === 'pending' || t.status === 'running'
  )
  const recentTasks = tasks.filter((t) => t.status === 'completed')

  const navItems = [
    { icon: FolderIcon, label: t('common:projects.title'), onClick: () => {} },
    { icon: ClockIcon, label: t('common:scheduled'), onClick: () => {} },
    { icon: ActivityIcon, label: t('common:liveArtifacts'), onClick: () => {} },
    {
      icon: SendIcon,
      label: t('common:dispatch'),
      badge: t('common:experimental'),
      onClick: () => {},
    },
    { icon: SlidersIcon, label: t('common:customize'), onClick: () => {} },
  ]

  return (
    <>
      <SidebarGroup className="group-data-[collapsible=icon]:hidden pt-0">
        <SidebarMenu>
          {navItems.map((item) => (
            <SidebarMenuItem key={item.label}>
              <SidebarMenuButton onClick={item.onClick}>
                <item.icon size={16} className="text-foreground/70" />
                <span>{item.label}</span>
                {item.badge && (
                  <span className="ml-auto text-[10px] font-medium bg-muted text-muted-foreground px-1.5 py-0.5 rounded-sm">
                    {item.badge}
                  </span>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroup>

      {dispatchTasks.length > 0 && (
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>{t('common:dispatch')}</SidebarGroupLabel>
          <SidebarMenu>
            {dispatchTasks.map((task) => (
              <TaskItem key={task.id} task={task} />
            ))}
          </SidebarMenu>
        </SidebarGroup>
      )}

      {recentTasks.length > 0 && (
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>{t('common:recents')}</SidebarGroupLabel>
          <SidebarMenu>
            {recentTasks.map((task) => (
              <TaskItem key={task.id} task={task} />
            ))}
          </SidebarMenu>
        </SidebarGroup>
      )}

      {tasks.length === 0 && (
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <p className="px-3 py-2 text-xs text-muted-foreground">
            No tasks yet. Click &ldquo;New task&rdquo; to get started.
          </p>
        </SidebarGroup>
      )}
    </>
  )
}
