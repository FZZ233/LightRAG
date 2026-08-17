import { useTabVisibility } from '@/contexts/useTabVisibility'
import { useTranslation } from 'react-i18next'

// Placeholder page for the new "custom" tab. Replace this component with your
// real feature, and update the `header.custom` label in src/locales/*.json.
export default function CustomView() {
  const { t } = useTranslation()
  const { isTabVisible } = useTabVisibility()
  const isCustomTabVisible = isTabVisible('custom')

  return (
    <div className={`size-full ${isCustomTabVisible ? '' : 'hidden'}`}>
      <div className="flex h-full w-full items-center justify-center bg-background p-8">
        <div className="max-w-md text-center">
          <h1 className="mb-2 text-xl font-bold">{t('header.custom')}</h1>
          <p className="text-sm text-muted-foreground">
            Replace this placeholder with your feature.
          </p>
        </div>
      </div>
    </div>
  )
}
