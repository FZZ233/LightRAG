import { useState } from 'react'
import { CirclePlus, LoaderCircle, Share2, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  createEntity,
  createRelation,
  deleteEntity,
  deleteRelation
} from '@/api/lightrag'
import Button from '@/components/ui/Button'
import Input from '@/components/ui/Input'
import Textarea from '@/components/ui/Textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/Dialog'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/AlertDialog'
import { errorMessage } from '@/lib/utils'
import { useBackendState } from '@/stores/state'
import { useGraphStore } from '@/stores/graph'
import { useSettingsStore } from '@/stores/settings'
import { normalizeEntityName } from '@/utils/entityName'

type SelectedGraphElement =
  | { type: 'entity'; entityName: string }
  | { type: 'relation'; sourceEntity: string; targetEntity: string }
  | null

const refreshGraph = (nextLabel?: string) => {
  const graphState = useGraphStore.getState()
  const settingsState = useSettingsStore.getState()

  graphState.clearSelection()
  graphState.setGraphDataFetchAttempted(false)
  graphState.setLastSuccessfulQueryLabel('')
  if (nextLabel) settingsState.setQueryLabel(nextLabel)
  graphState.incrementGraphDataVersion()
  settingsState.triggerSearchLabelDropdownRefresh()
}

const GraphCrudControls = () => {
  const { t } = useTranslation()
  const pipelineBusy = useBackendState.use.pipelineBusy()
  const selectedNode = useGraphStore.use.selectedNode()
  const selectedEdge = useGraphStore.use.selectedEdge()
  const rawGraph = useGraphStore.use.rawGraph()
  const queryLabel = useSettingsStore.use.queryLabel()

  const [entityDialogOpen, setEntityDialogOpen] = useState(false)
  const [relationDialogOpen, setRelationDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [isMutating, setIsMutating] = useState(false)

  const [entityName, setEntityName] = useState('')
  const [entityType, setEntityType] = useState('')
  const [entityDescription, setEntityDescription] = useState('')

  const [sourceEntity, setSourceEntity] = useState('')
  const [targetEntity, setTargetEntity] = useState('')
  const [relationDescription, setRelationDescription] = useState('')
  const [relationKeywords, setRelationKeywords] = useState('')

  let selectedElement: SelectedGraphElement = null
  if (selectedEdge && rawGraph) {
    const edge = rawGraph.getEdge(selectedEdge, true)
    if (edge) {
      const sourceNode = rawGraph.getNode(edge.source)
      const targetNode = rawGraph.getNode(edge.target)
      selectedElement = {
        type: 'relation',
        sourceEntity: String(sourceNode?.properties.entity_id ?? edge.source),
        targetEntity: String(targetNode?.properties.entity_id ?? edge.target)
      }
    }
  }

  if (!selectedElement && selectedNode) {
    const node = rawGraph?.getNode(selectedNode)
    selectedElement = {
      type: 'entity',
      entityName: String(node?.properties.entity_id ?? selectedNode)
    }
  }

  const openEntityDialog = () => {
    setEntityName('')
    setEntityType('')
    setEntityDescription('')
    setEntityDialogOpen(true)
  }

  const openRelationDialog = () => {
    if (selectedElement?.type === 'relation') {
      setSourceEntity(selectedElement.sourceEntity)
      setTargetEntity(selectedElement.targetEntity)
    } else {
      setSourceEntity(selectedElement?.type === 'entity' ? selectedElement.entityName : '')
      setTargetEntity('')
    }
    setRelationDescription('')
    setRelationKeywords('')
    setRelationDialogOpen(true)
  }

  const handleCreateEntity = async () => {
    const normalizedName = normalizeEntityName(entityName.trim())
    const description = entityDescription.trim()

    if (!normalizedName) {
      toast.error(t('graphPanel.propertiesView.actions.errors.entityNameRequired'))
      return
    }
    if (!description) {
      toast.error(t('graphPanel.propertiesView.actions.errors.descriptionRequired'))
      return
    }

    setIsMutating(true)
    try {
      const response = await createEntity(normalizedName, {
        entity_type: entityType.trim() || 'UNKNOWN',
        description
      })
      const createdName = String(response.data?.entity_name ?? normalizedName)
      setEntityDialogOpen(false)
      refreshGraph(createdName)
      toast.success(t('graphPanel.propertiesView.actions.success.entityCreated'))
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setIsMutating(false)
    }
  }

  const handleCreateRelation = async () => {
    const source = sourceEntity.trim()
    const target = targetEntity.trim()
    const description = relationDescription.trim()

    if (!source || !target) {
      toast.error(t('graphPanel.propertiesView.actions.errors.relationEndpointsRequired'))
      return
    }
    if (source === target) {
      toast.error(t('graphPanel.propertiesView.actions.errors.selfRelation'))
      return
    }
    if (!description) {
      toast.error(t('graphPanel.propertiesView.actions.errors.descriptionRequired'))
      return
    }

    setIsMutating(true)
    try {
      await createRelation(source, target, {
        description,
        keywords: relationKeywords.trim(),
        weight: 1
      })
      setRelationDialogOpen(false)
      refreshGraph(source)
      toast.success(t('graphPanel.propertiesView.actions.success.relationCreated'))
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setIsMutating(false)
    }
  }

  const handleDelete = async () => {
    if (!selectedElement) return

    setIsMutating(true)
    try {
      if (selectedElement.type === 'entity') {
        await deleteEntity(selectedElement.entityName)
        const nextLabel = queryLabel === selectedElement.entityName ? '*' : (queryLabel || '*')
        refreshGraph(nextLabel)
        toast.success(t('graphPanel.propertiesView.actions.success.entityDeleted'))
      } else {
        await deleteRelation(selectedElement.sourceEntity, selectedElement.targetEntity)
        refreshGraph(queryLabel || selectedElement.sourceEntity)
        toast.success(t('graphPanel.propertiesView.actions.success.relationDeleted'))
      }
      setDeleteDialogOpen(false)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setIsMutating(false)
    }
  }

  const lockedTooltip = pipelineBusy
    ? t('graphPanel.propertiesView.editLockedByPipeline')
    : undefined
  const deleteTooltip = lockedTooltip ?? (selectedElement
    ? t('graphPanel.propertiesView.actions.deleteSelection')
    : t('graphPanel.propertiesView.actions.selectToDelete'))

  return (
    <>
      <div className="bg-background/60 flex rounded-md border backdrop-blur-lg">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 rounded-none"
          aria-label={t('graphPanel.propertiesView.actions.createEntity')}
          tooltip={lockedTooltip ?? t('graphPanel.propertiesView.actions.createEntity')}
          disabled={pipelineBusy || isMutating}
          onClick={openEntityDialog}
        >
          <CirclePlus />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 rounded-none border-l"
          aria-label={t('graphPanel.propertiesView.actions.createRelation')}
          tooltip={lockedTooltip ?? t('graphPanel.propertiesView.actions.createRelation')}
          disabled={pipelineBusy || isMutating}
          onClick={openRelationDialog}
        >
          <Share2 />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 rounded-none border-l text-red-600 hover:text-red-700"
          aria-label={t('graphPanel.propertiesView.actions.deleteSelection')}
          tooltip={deleteTooltip}
          disabled={pipelineBusy || isMutating || !selectedElement}
          onClick={() => setDeleteDialogOpen(true)}
        >
          {isMutating ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
        </Button>
      </div>

      <Dialog open={entityDialogOpen} onOpenChange={setEntityDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('graphPanel.propertiesView.actions.createEntityTitle')}</DialogTitle>
            <DialogDescription>{t('graphPanel.propertiesView.actions.createEntityDescription')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <label className="grid gap-1.5 text-sm font-medium">
              {t('graphPanel.propertiesView.actions.entityName')}
              <Input value={entityName} onChange={(event) => setEntityName(event.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              {t('graphPanel.propertiesView.actions.entityType')}
              <Input value={entityType} onChange={(event) => setEntityType(event.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              {t('graphPanel.propertiesView.actions.description')}
              <Textarea
                className="min-h-28 resize-y"
                value={entityDescription}
                onChange={(event) => setEntityDescription(event.target.value)}
              />
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={isMutating} onClick={() => setEntityDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" disabled={isMutating} onClick={handleCreateEntity}>
              {isMutating && <LoaderCircle className="animate-spin" />}
              {t('graphPanel.propertiesView.actions.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={relationDialogOpen} onOpenChange={setRelationDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('graphPanel.propertiesView.actions.createRelationTitle')}</DialogTitle>
            <DialogDescription>{t('graphPanel.propertiesView.actions.createRelationDescription')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <label className="grid gap-1.5 text-sm font-medium">
              {t('graphPanel.propertiesView.actions.sourceEntity')}
              <Input value={sourceEntity} onChange={(event) => setSourceEntity(event.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              {t('graphPanel.propertiesView.actions.targetEntity')}
              <Input value={targetEntity} onChange={(event) => setTargetEntity(event.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              {t('graphPanel.propertiesView.actions.description')}
              <Textarea
                className="min-h-28 resize-y"
                value={relationDescription}
                onChange={(event) => setRelationDescription(event.target.value)}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              {t('graphPanel.propertiesView.actions.keywords')}
              <Input value={relationKeywords} onChange={(event) => setRelationKeywords(event.target.value)} />
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={isMutating} onClick={() => setRelationDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" disabled={isMutating} onClick={handleCreateRelation}>
              {isMutating && <LoaderCircle className="animate-spin" />}
              {t('graphPanel.propertiesView.actions.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('graphPanel.propertiesView.actions.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {selectedElement?.type === 'entity'
                ? t('graphPanel.propertiesView.actions.deleteEntityDescription', {
                  name: selectedElement.entityName
                })
                : t('graphPanel.propertiesView.actions.deleteRelationDescription', {
                  source: selectedElement?.sourceEntity ?? '',
                  target: selectedElement?.targetEntity ?? ''
                })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button type="button" variant="outline" disabled={isMutating} onClick={() => setDeleteDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" variant="destructive" disabled={isMutating} onClick={handleDelete}>
              {isMutating && <LoaderCircle className="animate-spin" />}
              {t('graphPanel.propertiesView.actions.delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export default GraphCrudControls
