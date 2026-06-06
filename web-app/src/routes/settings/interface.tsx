import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { Card, CardItem } from '@/containers/Card'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ThemeSwitcher } from '@/containers/ThemeSwitcher'
import { FontSizeSwitcher } from '@/containers/FontSizeSwitcher'
import { AccentColorPicker } from '@/containers/AccentColorPicker'
import { NotificationPositionSwitcher } from '@/containers/NotificationPositionSwitcher'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import SettingsIntegrationPage from '@/containers/SettingsIntegrationPage'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.interface as any)({
  component: InterfaceSettings,
})

function InterfaceSettings() {
  const { t } = useTranslation()
  const { resetInterface, showTokenSpeed, setShowTokenSpeed } =
    useInterfaceSettings()

  return (
    <SettingsIntegrationPage>
      {/* Interface */}
      <Card title={t('settings:interface.title')}>
        <CardItem
          title={t('settings:interface.theme')}
          description={t('settings:interface.themeDesc')}
          actions={<ThemeSwitcher />}
        />
        <CardItem
          title={t('settings:interface.fontSize')}
          description={t('settings:interface.fontSizeDesc')}
          actions={<FontSizeSwitcher />}
        />
        <CardItem
          title="Accent color"
          description="Customize the accent color of the application."
          className="flex-col sm:flex-row items-start sm:items-center sm:justify-between gap-y-2"
          actions={<AccentColorPicker />}
        />
        <CardItem
          title={t('settings:interface.notificationPosition')}
          description={t('settings:interface.notificationPositionDesc')}
          actions={<NotificationPositionSwitcher />}
        />
        <CardItem
          title={t('settings:interface.showTokenSpeed')}
          description={t('settings:interface.showTokenSpeedDesc')}
          actions={
            <Switch
              checked={showTokenSpeed}
              onCheckedChange={setShowTokenSpeed}
            />
          }
        />
        <CardItem
          title={t('settings:interface.resetToDefault')}
          description={t('settings:interface.resetToDefaultDesc')}
          actions={
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                resetInterface()
                toast.success(
                  t('settings:interface.resetInterfaceSuccess'),
                  {
                    id: 'reset-interface',
                    description: t(
                      'settings:interface.resetInterfaceSuccessDesc'
                    ),
                  }
                )
              }}
            >
              {t('common:reset')}
            </Button>
          }
        />
      </Card>
    </SettingsIntegrationPage>
  )
}
