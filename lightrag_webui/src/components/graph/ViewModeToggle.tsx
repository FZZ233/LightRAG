import Button from '@/components/ui/Button'
import { BoxIcon, OrbitIcon } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings'
import { useTranslation } from 'react-i18next'
import { controlButtonVariant } from '@/lib/constants'
import { cn } from '@/lib/utils'

const ViewModeToggle = () => {
  const graphViewMode = useSettingsStore.use.graphViewMode()
  const setGraphViewMode = useSettingsStore.use.setGraphViewMode()
  const { t } = useTranslation()

  return (
    <div className="bg-background/60 flex items-center rounded-xl border-1 backdrop-blur-lg">
      <Button
        variant={controlButtonVariant}
        size="icon"
        onClick={() => setGraphViewMode('2d')}
        tooltip={t('graphPanel.view2dTooltip', '2D View')}
        className={cn(graphViewMode === '2d' && 'bg-accent text-accent-foreground')}
      >
        <BoxIcon />
      </Button>
      <Button
        variant={controlButtonVariant}
        size="icon"
        onClick={() => setGraphViewMode('3d')}
        tooltip={t('graphPanel.view3dTooltip', '3D View')}
        className={cn(graphViewMode === '3d' && 'bg-accent text-accent-foreground')}
      >
        <OrbitIcon />
      </Button>
    </div>
  )
}

export default ViewModeToggle
