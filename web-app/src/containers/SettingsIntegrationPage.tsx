import type { ReactNode } from 'react'

import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu from '@/containers/SettingsMenu'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

export default function SettingsIntegrationPage({
  children,
  footer,
  headerActions,
}: {
  children: ReactNode
  footer?: ReactNode
  headerActions?: ReactNode
}) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        <div
          className={cn(
            'flex items-center w-full',
            headerActions
              ? cn('justify-between mr-2 pr-3', !IS_MACOS && 'pr-30')
              : 'gap-2'
          )}
        >
          <span className="font-medium text-base font-studio">
            {t('common:settings')}
          </span>
          {headerActions}
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="p-4 pt-0 w-full overflow-y-auto">
          <div className="flex flex-col justify-between gap-4 gap-y-3 w-full">
            {children}
          </div>
        </div>
      </div>
      {footer}
    </div>
  )
}