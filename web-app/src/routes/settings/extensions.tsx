import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { Card, CardItem } from '@/containers/Card'
import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { ExtensionManager } from '@/lib/extension'
import { useTranslation } from '@/i18n/react-i18next-compat'
import SettingsIntegrationPage from '@/containers/SettingsIntegrationPage'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.extensions as any)({
  component: ExtensionsContent,
})

function ExtensionsContent() {
  const { t } = useTranslation()
  const extensions = ExtensionManager.getInstance().listExtensions()
  return (
    <SettingsIntegrationPage>
      <Card
        header={
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-foreground font-studio font-medium text-base">
              {t('settings:extensions.title')}
            </h1>
          </div>
        }
      >
        {extensions.map((item, i) => {
          return (
            <CardItem
              key={i}
              title={
                <div className="flex items-center gap-x-2">
                  <h1 className="text-foreground font-studio font-medium text-base">
                    {item.productName ?? item.name}
                  </h1>
                  <div className="bg-foreground/10 px-1 py-0.5 rounded text-foreground/70 text-xs">
                    v{item.version}
                  </div>
                </div>
              }
              description={
                <RenderMarkdown
                  content={item.description ?? ''}
                  components={{
                    a: ({ ...props }) => (
                      <a
                        {...props}
                        target="_blank"
                        rel="noopener noreferrer"
                      />
                    ),
                    p: ({ ...props }) => (
                      <p {...props} className="mb-0!" />
                    ),
                  }}
                />
              }
            />
          )
        })}
      </Card>
    </SettingsIntegrationPage>
  )
}
