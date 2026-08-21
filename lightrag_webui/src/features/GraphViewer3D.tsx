import { useEffect, useLayoutEffect, useCallback, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import ForceGraph3D from 'react-force-graph-3d'
import SpriteText from 'three-spritetext'
import { GraphSearchOption, OptionItem } from '@react-sigma/graph-search'
import { ChevronDown, ChevronUp, Filter, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import GraphLabels from '@/components/graph/GraphLabels'
import GraphCrudControls from '@/components/graph/GraphCrudControls'
import GraphSearch from '@/components/graph/GraphSearch'
import PropertiesView from '@/components/graph/PropertiesView'
import Legend from '@/components/graph/Legend'
import LegendButton from '@/components/graph/LegendButton'
import Settings from '@/components/graph/Settings'
import SettingsDisplay from '@/components/graph/SettingsDisplay'
import ViewModeToggle from '@/components/graph/ViewModeToggle'
import ZoomControl3D from '@/components/graph/ZoomControl3D'
import Button from '@/components/ui/Button'
import Checkbox from '@/components/ui/Checkbox'

import { useSettingsStore } from '@/stores/settings'
import { useGraphStore } from '@/stores/graph'
import { LABEL_RENDER_LIMIT, minNodeSize, maxNodeSize } from '@/lib/constants'

// --- 共享的 WebGL 资源（模块级单例） ---
// three-forcegraph 在移除节点或连线时会释放对象的材质/纹理（展开/裁剪、可见性切换、重新摘要）。
// 由于这些资源在多个对象之间共享，因此将 dispose() 设为空操作，避免一次移除操作释放
// 图谱其他部分仍在使用的资源。

const LINK_DISTANCE = 52
const CHARGE_STRENGTH = -48
const LABEL_OFFSET = 1.5
const MAX_UI_LEVEL = 4
const NODE_VISUAL_SIZE_MIN = 8
const NODE_VISUAL_SIZE_MAX = 42
const LABEL_TEXT_HEIGHT_MIN = 3.8
const LABEL_TEXT_HEIGHT_MAX = 5.5
const INITIAL_DEPTH_MIN = LINK_DISTANCE * 2
const INITIAL_DEPTH_RATIO = 0.72
const THREE_D_LABEL_RENDER_LIMIT = 300
const THREE_D_PERFORMANCE_NODE_LIMIT = 500
const THREE_D_PERFORMANCE_EDGE_LIMIT = 1000
const THREE_D_PERFORMANCE_COOLDOWN_TICKS = 30
const GALAXY_LABEL_COLOR = '#F7FBFF'
const GALAXY_DIM_COLOR = '#34383D'
const GALAXY_LINK_COLOR = '#91A7D8'
const GALAXY_LINK_ACTIVE_COLOR = '#FFFFFF'
// const GALAXY_LEVEL_COLORS = ['#F7FAFC', '#FF4FA3', '#22E6E1', '#F0F21B', '#9CA3AA']
const GALAXY_LEVEL_COLORS = ['#7c81f9', '#fa459d', '#0ef7fb', '#e8f22d', '#7c81f9']


// 保持初始深度在多次渲染之间稳定，避免展开或裁剪图谱时节点跳到新的随机位置。
function hashNodeId(id: string): number {
  let hash = 2166136261
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 4294967295
}

function getInitialDepth(id: string, index: number, depthScale: number): number {
  const phase = (hashNodeId(id) + index * 0.61803398875) % 1
  return (phase * 2 - 1) * depthScale
}

function normalizeNodeSize(size: number): number {
  const range = Math.max(1, maxNodeSize - minNodeSize)
  return Math.max(0, Math.min(1, (size - minNodeSize) / range))
}

function getNodeVisualScale(size: number): number {
  const normalized = Math.pow(normalizeNodeSize(size), 1.25)
  return NODE_VISUAL_SIZE_MIN + normalized * (NODE_VISUAL_SIZE_MAX - NODE_VISUAL_SIZE_MIN)
}

function getNodeLabelHeight(size: number): number {
  const normalized = Math.pow(normalizeNodeSize(size), 0.8)
  return LABEL_TEXT_HEIGHT_MIN + normalized * (LABEL_TEXT_HEIGHT_MAX - LABEL_TEXT_HEIGHT_MIN)
}

type GraphEndpoint = string | { id?: string }

function getEndpointId(endpoint: GraphEndpoint): string {
  return typeof endpoint === 'object' ? (endpoint.id ?? '') : endpoint
}

// 先按照参考项目计算有向拓扑深度；对于知识图谱中常见的环和孤立分量，
// 再从已分层邻居或分量内连接数最高的节点开始补充广度层级。
function computeNodeLevels(
  nodes: Array<{ id: string }>,
  links: Array<{ source: GraphEndpoint; target: GraphEndpoint }>
): Map<string, number> {
  const nodeIds = new Set(nodes.map((node) => node.id))
  const inDegree = new Map<string, number>()
  const outgoing = new Map<string, Set<string>>()
  const neighbors = new Map<string, Set<string>>()

  nodeIds.forEach((id) => {
    inDegree.set(id, 0)
    outgoing.set(id, new Set())
    neighbors.set(id, new Set())
  })

  links.forEach((link) => {
    const source = getEndpointId(link.source)
    const target = getEndpointId(link.target)
    if (!nodeIds.has(source) || !nodeIds.has(target) || source === target) return
    if (!outgoing.get(source)!.has(target)) {
      outgoing.get(source)!.add(target)
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1)
    }
    neighbors.get(source)!.add(target)
    neighbors.get(target)!.add(source)
  })

  const remainingInDegree = new Map(inDegree)
  const levels = new Map<string, number>()
  const queue = [...nodeIds].filter((id) => remainingInDegree.get(id) === 0).sort()

  queue.forEach((id) => levels.set(id, 0))
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]
    const currentLevel = levels.get(current) ?? 0
    outgoing.get(current)?.forEach((next) => {
      levels.set(next, Math.max(levels.get(next) ?? 0, currentLevel + 1))
      const nextInDegree = (remainingInDegree.get(next) ?? 0) - 1
      remainingInDegree.set(next, nextInDegree)
      if (nextInDegree === 0) queue.push(next)
    })
  }

  const unresolved = new Set([...nodeIds].filter((id) => !levels.has(id)))
  while (unresolved.size > 0) {
    let seed: string | null = null
    let seedLevel = 0
    let closestLevel = Number.POSITIVE_INFINITY

    unresolved.forEach((id) => {
      neighbors.get(id)?.forEach((neighbor) => {
        const neighborLevel = levels.get(neighbor)
        if (neighborLevel !== undefined && neighborLevel + 1 < closestLevel) {
          seed = id
          seedLevel = neighborLevel + 1
          closestLevel = seedLevel
        }
      })
    })

    if (seed === null) {
      seed = [...unresolved].sort((left, right) => {
        const degreeDelta = (neighbors.get(right)?.size ?? 0) - (neighbors.get(left)?.size ?? 0)
        return degreeDelta || left.localeCompare(right)
      })[0]
      seedLevel = 0
    }

    levels.set(seed, seedLevel)
    unresolved.delete(seed)
    const componentQueue = [seed]
    for (let cursor = 0; cursor < componentQueue.length; cursor++) {
      const current = componentQueue[cursor]
      const nextLevel = (levels.get(current) ?? 0) + 1
      neighbors.get(current)?.forEach((next) => {
        if (!unresolved.has(next)) return
        levels.set(next, nextLevel)
        unresolved.delete(next)
        componentQueue.push(next)
      })
    }
  }

  return levels
}

type RgbColor = { r: number; g: number; b: number }

function parseHexColor(color: string): RgbColor {
  const hex = color.replace('#', '')
  const value = Number.parseInt(hex.length === 3 ? hex.split('').map((part) => part + part).join('') : hex, 16)
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255
  }
}

function mixColor(source: RgbColor, target: RgbColor, amount: number): RgbColor {
  return {
    r: Math.round(source.r + (target.r - source.r) * amount),
    g: Math.round(source.g + (target.g - source.g) * amount),
    b: Math.round(source.b + (target.b - source.b) * amount)
  }
}

function rgba(color: RgbColor, alpha: number): string {
  return `rgba(${color.r},${color.g},${color.b},${alpha})`
}

const nodeTextures = new Map<string, THREE.Texture>()
const spriteMaterials = new Map<string, THREE.SpriteMaterial>()

// 每个级别只缓存一张纹理，纹理内直接绘制高光、暗面和外发光。
// 节点仍是单个精灵，不增加球体几何和额外光源。
function getNodeTexture(color: string): THREE.Texture {
  const cached = nodeTextures.get(color)
  if (cached) return cached

  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const cx = size / 2
  const cy = size / 2
  const outer = size / 2
  const coreRadius = outer * 0.72
  const baseColor = parseHexColor(color)
  const white = { r: 255, g: 255, b: 255 }
  const black = { r: 0, g: 0, b: 0 }
  const highlightColor = mixColor(baseColor, white, 0.48)
  const brightColor = mixColor(baseColor, white, 0.16)
  const shadowColor = mixColor(baseColor, black, 0.38)
  const edgeColor = mixColor(baseColor, black, 0.55)

  const halo = ctx.createRadialGradient(cx, cy, coreRadius * 0.72, cx, cy, outer)
  halo.addColorStop(0, rgba(baseColor, 0.38))
  halo.addColorStop(0.42, rgba(baseColor, 0.24))
  halo.addColorStop(0.72, rgba(baseColor, 0.1))
  halo.addColorStop(1, rgba(baseColor, 0))
  ctx.fillStyle = halo
  ctx.beginPath()
  ctx.arc(cx, cy, outer, 0, Math.PI * 2)
  ctx.fill()

  const surface = ctx.createRadialGradient(
    cx - coreRadius * 0.3,
    cy - coreRadius * 0.32,
    coreRadius * 0.04,
    cx + coreRadius * 0.08,
    cy + coreRadius * 0.1,
    coreRadius * 1.08
  )
  surface.addColorStop(0, rgba(highlightColor, 1))
  surface.addColorStop(0.28, rgba(brightColor, 1))
  surface.addColorStop(0.58, rgba(baseColor, 1))
  surface.addColorStop(0.84, rgba(shadowColor, 1))
  surface.addColorStop(1, rgba(edgeColor, 1))
  ctx.fillStyle = surface
  ctx.beginPath()
  ctx.arc(cx, cy, coreRadius, 0, Math.PI * 2)
  ctx.fill()

  const specular = ctx.createRadialGradient(
    cx - coreRadius * 0.32,
    cy - coreRadius * 0.35,
    0,
    cx - coreRadius * 0.32,
    cy - coreRadius * 0.35,
    coreRadius * 0.42
  )
  specular.addColorStop(0, 'rgba(255,255,255,0.48)')
  specular.addColorStop(0.35, 'rgba(255,255,255,0.18)')
  specular.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, coreRadius, 0, Math.PI * 2)
  ctx.clip()
  ctx.fillStyle = specular
  ctx.fillRect(0, 0, size, size)
  ctx.restore()

  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  texture.dispose = () => undefined
  nodeTextures.set(color, texture)
  return texture
}

function getSpriteMaterial(color: string): THREE.SpriteMaterial {
  const key = color
  let material = spriteMaterials.get(key)
  if (!material) {
    material = new THREE.SpriteMaterial({
      map: getNodeTexture(color),
      color: new THREE.Color('#FFFFFF'),
      transparent: true,
      opacity: 0.98,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.NormalBlending
    })
    material.dispose = () => undefined
    spriteMaterials.set(key, material)
  }
  return material
}

const GraphViewer3D = () => {
  const { t } = useTranslation()
  const fgRef = useRef<any>(null)
  // const didAutoFitRef = useRef(false)

  const sigmaGraph = useGraphStore.use.sigmaGraph()
  const graphNodeCount = useGraphStore.use.graphNodeCount()
  const graphEdgeCount = useGraphStore.use.graphEdgeCount()
  const graphDataVersion = useGraphStore.use.graphDataVersion()
  const isPerformanceMode =
    graphNodeCount > THREE_D_PERFORMANCE_NODE_LIMIT || graphEdgeCount > THREE_D_PERFORMANCE_EDGE_LIMIT

  const selectedNode = useGraphStore.use.selectedNode()
  const focusedNode = useGraphStore.use.focusedNode()
  const selectedEdge = useGraphStore.use.selectedEdge()
  const focusedEdge = useGraphStore.use.focusedEdge()
  const moveToSelectedNode = useGraphStore.use.moveToSelectedNode()

  const showPropertyPanel = useSettingsStore.use.showPropertyPanel()
  const showNodeSearchBar = useSettingsStore.use.showNodeSearchBar()
  const showLegend = useSettingsStore.use.showLegend()
  const showNodeLabel = useSettingsStore.use.showNodeLabel()
  const enableNodeDrag = useSettingsStore.use.enableNodeDrag()
  const enableHideUnselectedEdges = useSettingsStore.use.enableHideUnselectedEdges()
  const [selectedLevels, setSelectedLevels] = useState<number[]>([])
  const [isLevelFilterCollapsed, setIsLevelFilterCollapsed] = useState(false)

  const dimColor = GALAXY_DIM_COLOR
  const linkColor = useCallback(
    (link: any) =>
      link.__graphId === (selectedEdge ?? focusedEdge)
        ? GALAXY_LINK_ACTIVE_COLOR
        : GALAXY_LINK_COLOR,
    [focusedEdge, selectedEdge]
  )
  // 高分屏的渲染像素密度会大幅增加 GPU 填充量；大图模式使用标准密度以保持帧率。
  useEffect(() => {
    const renderer = fgRef.current?.renderer()
    if (!renderer) return
    renderer.setPixelRatio(isPerformanceMode ? 1 : Math.min(2, window.devicePixelRatio))
  }, [isPerformanceMode])

  // 3D 文字标签会为每个节点创建额外的纹理；大图中提前关闭，避免占用 GPU 和主线程。
  const showLabels = showNodeLabel && graphNodeCount <= Math.min(LABEL_RENDER_LIMIT, THREE_D_LABEL_RENDER_LIMIT)
  const showLabelsRef = useRef(showLabels)
  useEffect(() => {
    showLabelsRef.current = showLabels
  }, [showLabels])

  // 数据转换：graphology 图谱 -> react-force-graph 的 { nodes, links }。
  // 依赖响应式的数量/版本镜像，而不只是 sigmaGraph，因为展开/裁剪会原地修改图谱，
  // 不会替换图谱实例。
  const graphData = useMemo(() => {
    if (!sigmaGraph) return { nodes: [], links: [] }
    const planarNodes = sigmaGraph.mapNodes((id: string, attrs: any) => {
      return {
        id,
        label: (attrs.label as string) ?? id,
        size: (attrs.size as number) ?? 10,
        x: (attrs.x as number) ?? 0,
        y: (attrs.y as number) ?? 0,
        z: typeof attrs.z === 'number' && Number.isFinite(attrs.z) ? attrs.z : undefined
      }
    })
    const planarExtent = planarNodes.reduce(
      (extent, node) => Math.max(extent, Math.abs(node.x), Math.abs(node.y)),
      0
    )
    const links = sigmaGraph.mapEdges(
      (id: string, attrs: any, source: string, target: string) => ({
        source,
        target,
        label: (attrs.label as string) ?? '',
        weight: (attrs.originalWeight as number) ?? 1,
        // graphology 的边键等于 store 中的 dynamicId，用于将边的悬停/点击选择结果
        // 写回 PropertiesView。
        __graphId: id
      })
    )
    const levelMap = computeNodeLevels(planarNodes, links)
    const depthScale = Math.max(INITIAL_DEPTH_MIN, planarExtent * INITIAL_DEPTH_RATIO)
    const nodes = planarNodes.map((node, index) => {
      const level = levelMap.get(node.id) ?? 0
      return {
        ...node,
        level,
        uiLevel: Math.min(level, MAX_UI_LEVEL),
        color: GALAXY_LEVEL_COLORS[Math.min(level, MAX_UI_LEVEL)],
        z: node.z ?? getInitialDepth(node.id, index, depthScale)
      }
    })
    return { nodes, links }
    // graphology 在展开/裁剪/重命名时会原地修改图谱，因此数量/版本镜像是刷新此 memo
    // 缓存所必需的依赖项。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigmaGraph, graphNodeCount, graphEdgeCount, graphDataVersion])

  const levelCounts = useMemo(() => {
    const counts = Array.from({ length: MAX_UI_LEVEL + 1 }, () => 0)
    graphData.nodes.forEach((node: any) => {
      counts[node.uiLevel ?? 0]++
    })
    return counts
  }, [graphData])

  const nodeLevelById = useMemo(
    () => new Map(graphData.nodes.map((node: any) => [node.id, node.uiLevel ?? 0])),
    [graphData]
  )
  const selectedLevelSet = useMemo(
    () => new Set(selectedLevels.filter((level) => levelCounts[level] > 0)),
    [levelCounts, selectedLevels]
  )

  const toggleLevel = useCallback((level: number) => {
    setSelectedLevels((levels) => {
      const validLevels = levels.filter((item) => levelCounts[item] > 0)
      return validLevels.includes(level)
        ? validLevels.filter((item) => item !== level)
        : [...validLevels, level]
    })
  }, [levelCounts])

  const nodeVisibility = useCallback(
    (node: any) => selectedLevelSet.size === 0 || selectedLevelSet.has(node.uiLevel ?? 0),
    [selectedLevelSet]
  )
  // 统一 3D 初始视角。
  // 不使用 zoomToFit，避免首次进入时先小后又自动缩放。
  const INITIAL_CAMERA_DISTANCE = 500
  useEffect(() => {
    const fg = fgRef.current

    if (!fg || graphData.nodes.length === 0) return

    fg.cameraPosition(
      {
        x: 0,
        y: 0,
        z: INITIAL_CAMERA_DISTANCE
      },
      {
        x: 0,
        y: 0,
        z: 0
      },
      0
    )
  }, [graphData])

  // 大图模式不响应悬停状态，避免鼠标移动时遍历整张 3D 场景更新颜色。
  useEffect(() => {
    if (!isPerformanceMode) return
    useGraphStore.getState().setFocusedNode(null)
    useGraphStore.getState().setFocusedEdge(null)
  }, [isPerformanceMode])
  // 当前活动节点（选中或聚焦节点）的邻居集合，用于降低其他节点的亮度。
  const neighbors = useMemo(() => {
    const set = new Set<string>()
    const active = selectedNode ?? focusedNode
    if (active && sigmaGraph) {
      sigmaGraph.neighbors(active).forEach((n: string) => set.add(n))
    }
    return set
  }, [selectedNode, focusedNode, sigmaGraph])

  const linkVisibility = useCallback(
    (link: any) => {
      const src = getEndpointId(link.source)
      const tgt = getEndpointId(link.target)
      if (
        selectedLevelSet.size > 0 &&
        (!selectedLevelSet.has(nodeLevelById.get(src) ?? -1) ||
          !selectedLevelSet.has(nodeLevelById.get(tgt) ?? -1))
      ) {
        return false
      }
      if (!enableHideUnselectedEdges || !selectedNode) return true
      return src === selectedNode || tgt === selectedNode
    },
    [enableHideUnselectedEdges, nodeLevelById, selectedLevelSet, selectedNode]
  )

  useEffect(() => {
    fgRef.current?.refresh()
  }, [selectedLevelSet])

  // 用单个面向屏幕的柔光精灵表现节点，避免线框球体带来的机械感和额外几何开销。
  const nodeThreeObject = useCallback((node: any) => {
    const baseColor = node.color ?? '#5D6D7E'
    const group = new THREE.Group()
    const scale = getNodeVisualScale(node.size ?? 10)
    const sprite = new THREE.Sprite(getSpriteMaterial(baseColor))
    sprite.scale.set(scale, scale, 1)
    sprite.renderOrder = 20 // 让发光节点绘制在连线之上
    group.add(sprite)
    let label: SpriteText | null = null
    if (showLabelsRef.current) {
      label = new SpriteText(
        node.label ?? node.id,
        getNodeLabelHeight(node.size ?? 10),
        GALAXY_LABEL_COLOR
      )
      label.position.y = scale * 0.5 + LABEL_OFFSET
      label.renderOrder = 30
      label.fontWeight = '500'
      label.padding = 0
      label.material.depthTest = false
      label.material.depthWrite = false
      group.add(label)
    }
    group.userData = { type: 'glowNode', nodeId: node.id, baseColor, sprite, label }
    return group
  }, [])

  // 自定义节点不会经过库的 accessor 颜色更新流程，因此需要在这里自行处理变暗颜色。
  // 遍历当前场景可以适应展开/裁剪过程中对象的动态添加和移除。
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    const activeNode = selectedNode ?? focusedNode
    fg.scene().traverse((obj: any) => {
      const ud = obj.userData
      if (!ud || !ud.type) return
      if (ud.type === 'glowNode') {
        const isDim = !!activeNode && ud.nodeId !== activeNode && !neighbors.has(ud.nodeId)
        const nodeColor = isDim ? dimColor : ud.baseColor
        const spriteMaterial = getSpriteMaterial(nodeColor)
        const sprite = ud.sprite
        if (sprite && sprite.material !== spriteMaterial) sprite.material = spriteMaterial
        if (ud.label) {
          ud.label.color = GALAXY_LABEL_COLOR
          ud.label.material.opacity = isDim ? 0.3 : 1
        }
      }
    })
  }, [selectedNode, focusedNode, neighbors, dimColor])

  // 拉开节点间距：d3-force-3d 默认的连线距离较短（30），排斥力较弱（-60），会使图谱过于拥挤。
  // 在模拟开始前调整这两个参数。useLayoutEffect 会在触发布局的防抖 digest 之前执行，
  // 并且刻意不重新加热模拟：重新加热会在 state.layout 赋值前设置 engineRunning=true，
  // 从而导致 tick 循环崩溃（"Cannot read properties of undefined (reading 'tick')"）。
  useLayoutEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    const linkForce = fg.d3Force('link')
    if (linkForce?.distance) linkForce.distance(LINK_DISTANCE)
    const chargeForce = fg.d3Force('charge')
    if (chargeForce?.strength) chargeForce.strength(CHARGE_STRENGTH)
  }, [])

  const onSearchFocus = useCallback((value: GraphSearchOption | null) => {
    if (value === null) useGraphStore.getState().setFocusedNode(null)
    else if (value.type === 'nodes') useGraphStore.getState().setFocusedNode(value.id)
  }, [])

  const onSearchSelect = useCallback((value: GraphSearchOption | null) => {
    if (value === null) {
      useGraphStore.getState().setSelectedNode(null)
    } else if (value.type === 'nodes') {
      useGraphStore.getState().setSelectedNode(value.id, true)
    }
  }, [])

  const searchInitSelectedNode = useMemo(
    (): OptionItem | null => (selectedNode ? { type: 'nodes', id: selectedNode } : null),
    [selectedNode]
  )

  // 在收到请求时将相机聚焦到选中节点（例如通过搜索选中节点）。
  useEffect(() => {
    if (!moveToSelectedNode) return
    if (selectedNode && fgRef.current) {
      const node = graphData.nodes.find((n: any) => n.id === selectedNode)
      if (node) {
        fgRef.current.cameraPosition(
          { x: node.x, y: node.y, z: (node.z ?? 0) + 200 },
          { x: node.x, y: node.y, z: node.z ?? 0 },
          1000
        )
      }
    }
    useGraphStore.getState().setMoveToSelectedNode(false)
  }, [moveToSelectedNode, selectedNode, graphData])

  return (
    <div className="relative h-full w-full overflow-hidden">
      <ForceGraph3D
        ref={fgRef}
        graphData={graphData}
        numDimensions={3}
        backgroundColor="rgba(0,0,0,0)"
        nodeVal="size"
        nodeThreeObject={nodeThreeObject}
        nodeVisibility={nodeVisibility}
        nodeLabel={isPerformanceMode ? undefined : (n: any) => n.label}
        linkVisibility={linkVisibility}
        linkColor={linkColor}
        linkOpacity={0.5}
        linkCurvature={0}
        linkLabel={isPerformanceMode ? undefined : (l: any) => l.label}
        enableNodeDrag={enableNodeDrag}
        d3AlphaDecay={isPerformanceMode ? 0.1 : 0.0228}
        d3VelocityDecay={isPerformanceMode ? 0.6 : 0.4}
        cooldownTicks={isPerformanceMode ? THREE_D_PERFORMANCE_COOLDOWN_TICKS : 150}
        warmupTicks={isPerformanceMode || (sigmaGraph && sigmaGraph.order > 2000) ? 0 : 30}
        onNodeHover={isPerformanceMode ? undefined : (n: any) => useGraphStore.getState().setFocusedNode(n?.id ?? null)}
        onNodeClick={(n: any) => useGraphStore.getState().setSelectedNode(n.id)}
        onLinkHover={isPerformanceMode ? undefined : (l: any) => useGraphStore.getState().setFocusedEdge(l?.__graphId ?? null)}
        onLinkClick={(l: any) => useGraphStore.getState().setSelectedEdge(l.__graphId)}
        onBackgroundClick={() => useGraphStore.getState().clearSelection()}
        onNodeDragEnd={(n: any) => {
          n.fx = n.x
          n.fy = n.y
          n.fz = n.z
        }}
      />

      <div className="absolute top-2 left-2 flex items-start gap-2">
        <GraphLabels />
        <GraphCrudControls />
        {showNodeSearchBar && (
          <GraphSearch value={searchInitSelectedNode} onFocus={onSearchFocus} onChange={onSearchSelect} />
        )}
        <ViewModeToggle />
      </div>

      <div className="absolute bottom-2 left-2 flex flex-col rounded-xl border border-white/15 bg-black/75 text-cyan-50 shadow-lg backdrop-blur-lg">
        <ZoomControl3D fgRef={fgRef} />
        <LegendButton />
        <Settings />
      </div>

      <div
        className={`absolute right-2 bottom-2 z-10 max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border border-white/15 bg-black/85 text-cyan-50 shadow-lg backdrop-blur-md ${
          isLevelFilterCollapsed ? 'w-auto' : 'w-[19rem]'
        }`}
      >
        <div className="flex h-10 items-center gap-2 px-2">
          <Filter className="size-4 text-cyan-300" />
          <span className="text-sm font-medium">
            {t('graphPanel.levelFilter.title', '节点级别')}
          </span>
          {selectedLevelSet.size > 0 && (
            <span className="flex min-w-5 items-center justify-center rounded-full bg-cyan-300 px-1.5 text-xs font-medium text-[#071426]">
              {selectedLevelSet.size}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {selectedLevelSet.size > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 text-cyan-100 hover:bg-white/10 hover:text-white"
                tooltip={t('graphPanel.levelFilter.clear', '清除级别筛选')}
                onClick={() => setSelectedLevels([])}
              >
                <RotateCcw />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-cyan-100 hover:bg-white/10 hover:text-white"
              tooltip={t(
                isLevelFilterCollapsed
                  ? 'graphPanel.levelFilter.expand'
                  : 'graphPanel.levelFilter.collapse',
                isLevelFilterCollapsed ? '展开级别筛选' : '收起级别筛选'
              )}
              onClick={() => setIsLevelFilterCollapsed((collapsed) => !collapsed)}
            >
              {isLevelFilterCollapsed ? <ChevronUp /> : <ChevronDown />}
            </Button>
          </div>
        </div>

        {!isLevelFilterCollapsed && (
          <div className="grid grid-cols-5 gap-1 border-t border-white/10 p-2">
            {levelCounts.map((count, level) => {
              const selected = selectedLevelSet.has(level)
              const checkboxId = `graph-level-filter-${level}`
              return (
                <label
                  key={level}
                  htmlFor={checkboxId}
                  title={t('graphPanel.levelFilter.nodeCount', '{{count}} 个节点', { count })}
                  className={`flex min-w-0 cursor-pointer flex-col items-center gap-1 rounded px-1 py-1.5 text-xs transition-colors ${
                    selected ? 'bg-cyan-300/15 text-white' : 'text-cyan-100/75 hover:bg-white/5'
                  } ${count === 0 ? 'pointer-events-none opacity-35' : ''}`}
                >
                  <Checkbox
                    id={checkboxId}
                    checked={selected}
                    disabled={count === 0}
                    onCheckedChange={() => toggleLevel(level)}
                    className="data-[state=checked]:text-black"
                    style={{
                      borderColor: GALAXY_LEVEL_COLORS[level],
                      backgroundColor: selected ? GALAXY_LEVEL_COLORS[level] : undefined
                    }}
                  />
                  <span className="whitespace-nowrap">
                    {t('graphPanel.levelFilter.level', '{{level}} 级', { level: level + 1 })}
                  </span>
                  <span className="text-[10px] text-cyan-100/50">{count}</span>
                </label>
              )
            })}
          </div>
        )}
      </div>

      {showPropertyPanel && (
        <div className="absolute top-2 right-2 z-10">
          <PropertiesView />
        </div>
      )}

      {showLegend && (
        <div className="absolute right-2 bottom-32 z-0">
          <Legend className="border border-white/15 bg-black/75 text-cyan-50 shadow-lg backdrop-blur-lg" />
        </div>
      )}

      <SettingsDisplay />
    </div>
  )
}

export default GraphViewer3D
