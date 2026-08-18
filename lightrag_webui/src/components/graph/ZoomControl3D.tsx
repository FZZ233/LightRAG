import { useCallback, type RefObject } from 'react'
import Button from '@/components/ui/Button'
import { ZoomInIcon, ZoomOutIcon, FullscreenIcon } from 'lucide-react'
import { controlButtonVariant } from '@/lib/constants'
import { useTranslation } from 'react-i18next'

/**
 * Zoom controls for the 3D graph viewer. react-force-graph-3d has no `zoom()`
 * method, so zoom is implemented by scaling the camera distance from the scene
 * origin (where the force layout centers the graph), then re-aiming at origin.
 */
const ZoomControl3D = ({ fgRef }: { fgRef: RefObject<any> }) => {
  const { t } = useTranslation()

  const zoomBy = useCallback(
    (factor: number) => {
      const fg = fgRef.current
      if (!fg) return
      try {
        const cam = fg.camera()
        const { x, y, z } = cam.position
        const dist = Math.sqrt(x * x + y * y + z * z) || 1000
        const newDist = Math.max(20, dist * factor)
        const scale = newDist / dist
        fg.cameraPosition({ x: x * scale, y: y * scale, z: z * scale }, { x: 0, y: 0, z: 0 }, 300)
      } catch (error) {
        console.error('Error zooming 3D graph:', error)
      }
    },
    [fgRef]
  )

  const handleZoomIn = useCallback(() => zoomBy(1 / 1.5), [zoomBy])
  const handleZoomOut = useCallback(() => zoomBy(1.5), [zoomBy])
  const handleReset = useCallback(() => {
    fgRef.current?.zoomToFit(1000)
  }, [fgRef])

  return (
    <>
      <Button
        variant={controlButtonVariant}
        onClick={handleReset}
        tooltip={t('graphPanel.sideBar.zoomControl.resetZoom')}
        size="icon"
      >
        <FullscreenIcon />
      </Button>
      <Button
        variant={controlButtonVariant}
        onClick={handleZoomIn}
        tooltip={t('graphPanel.sideBar.zoomControl.zoomIn')}
        size="icon"
      >
        <ZoomInIcon />
      </Button>
      <Button
        variant={controlButtonVariant}
        onClick={handleZoomOut}
        tooltip={t('graphPanel.sideBar.zoomControl.zoomOut')}
        size="icon"
      >
        <ZoomOutIcon />
      </Button>
    </>
  )
}

export default ZoomControl3D
