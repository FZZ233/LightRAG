import { useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react'
import * as THREE from 'three'
import ForceGraph3D from 'react-force-graph-3d'
import SpriteText from 'three-spritetext'
import { GraphSearchOption, OptionItem } from '@react-sigma/graph-search'

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

import { useSettingsStore } from '@/stores/settings'
import { useGraphStore } from '@/stores/graph'
import useIsDarkMode from '@/hooks/useIsDarkMode'
import {
  edgeColorDarkTheme,
  edgeColorSelected,
  labelColorDarkTheme,
  labelColorLightTheme,
  LABEL_RENDER_LIMIT
} from '@/lib/constants'

// --- 共享的 WebGL 资源（模块级单例） ---
// three-forcegraph 在移除节点或连线时会释放对象的材质/纹理（展开/裁剪、可见性切换、重新摘要）。
// 由于这些资源在多个对象之间共享，因此将 dispose() 设为空操作，避免一次移除操作释放
// 图谱其他部分仍在使用的资源。

const NODE_GLOW_SCALE = 9
const LINK_DISTANCE = 60
const CHARGE_STRENGTH = -60
const LABEL_TEXT_HEIGHT = 5
const LABEL_OFFSET = 3
const INITIAL_DEPTH_MIN = LINK_DISTANCE * 1.5
const INITIAL_DEPTH_RATIO = 0.45
const THREE_D_LABEL_RENDER_LIMIT = 300
const THREE_D_PERFORMANCE_NODE_LIMIT = 500
const THREE_D_PERFORMANCE_EDGE_LIMIT = 1000
const THREE_D_PERFORMANCE_COOLDOWN_TICKS = 30

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

let glowTexture: THREE.Texture | null = null
const spriteMaterials = new Map<string, THREE.SpriteMaterial>()

// 带有清晰外圈的实心发光粒子：明亮的内部圆盘加上完全不透明的硬边圆环，
// 使粒子边界更加清楚。
function getGlowTexture(): THREE.Texture {
  if (glowTexture) return glowTexture
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const cx = size / 2
  const cy = size / 2
  const outer = size / 2 - 2
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, outer)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.85)')
  gradient.addColorStop(0.6, 'rgba(255,255,255,0.35)')
  gradient.addColorStop(0.8, 'rgba(255,255,255,0.1)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(cx, cy, outer, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,1)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(cx, cy, outer - ctx.lineWidth / 2, 0, Math.PI * 2)
  ctx.stroke()
  glowTexture = new THREE.Texture(canvas)
  glowTexture.needsUpdate = true
  glowTexture.dispose = () => undefined
  return glowTexture
}

function getSpriteMaterial(color: string, additive: boolean): THREE.SpriteMaterial {
  const key = `${color}|${additive ? 'a' : 'n'}`
  let material = spriteMaterials.get(key)
  if (!material) {
    material = new THREE.SpriteMaterial({
      map: getGlowTexture(),
      color: new THREE.Color(color),
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
    })
    material.dispose = () => undefined
    spriteMaterials.set(key, material)
  }
  return material
}

const GraphViewer3D = () => {
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

  const isDark = useIsDarkMode()
  const isDarkRef = useRef(isDark)
  useEffect(() => {
    isDarkRef.current = isDark
  }, [isDark])
  const dimColor = isDark ? '#444444' : '#dddddd'
  const linkColor = useCallback(
    (link: any) =>
      link.__graphId === (selectedEdge ?? focusedEdge)
        ? edgeColorSelected
        : (isDark ? edgeColorDarkTheme : '#cccccc'),
    [focusedEdge, isDark, selectedEdge]
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
    const planarNodes = sigmaGraph.mapNodes((id: string, attrs: any) => ({
      id,
      label: (attrs.label as string) ?? id,
      color: (attrs.color as string) ?? '#5D6D7E',
      size: (attrs.size as number) ?? 10,
      x: (attrs.x as number) ?? 0,
      y: (attrs.y as number) ?? 0,
      z: typeof attrs.z === 'number' && Number.isFinite(attrs.z) ? attrs.z : undefined
    }))
    const planarExtent = planarNodes.reduce(
      (extent, node) => Math.max(extent, Math.abs(node.x), Math.abs(node.y)),
      0
    )
    const depthScale = Math.max(INITIAL_DEPTH_MIN, planarExtent * INITIAL_DEPTH_RATIO)
    const nodes = planarNodes.map((node, index) => ({
      ...node,
      z: node.z ?? getInitialDepth(node.id, index, depthScale)
    }))
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
    return { nodes, links }
    // graphology 在展开/裁剪/重命名时会原地修改图谱，因此数量/版本镜像是刷新此 memo
    // 缓存所必需的依赖项。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigmaGraph, graphNodeCount, graphEdgeCount, graphDataVersion])
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
      if (!enableHideUnselectedEdges || !selectedNode) return true
      const src = typeof link.source === 'object' ? link.source.id : link.source
      const tgt = typeof link.target === 'object' ? link.target.id : link.target
      return src === selectedNode || tgt === selectedNode
    },
    [enableHideUnselectedEdges, selectedNode]
  )

  // 发光粒子节点：使用面向屏幕的精灵，并用节点颜色着色；径向纹理提供柔和光晕。
  // 深色模式使用叠加混合（更有发光感），浅色模式使用普通混合（保证在明亮背景上仍清晰）。
  const nodeThreeObject = useCallback((node: any) => {
    const baseColor = node.color ?? '#5D6D7E'
    const group = new THREE.Group()
    const sprite = new THREE.Sprite(getSpriteMaterial(baseColor, isDarkRef.current))
    const scale = Math.cbrt(node.size ?? 10) * NODE_GLOW_SCALE
    sprite.scale.set(scale, scale, 1)
    sprite.renderOrder = 20 // 让发光节点绘制在连线之上
    group.add(sprite)
    let label: SpriteText | null = null
    if (showLabelsRef.current) {
      label = new SpriteText(
        node.label ?? node.id,
        LABEL_TEXT_HEIGHT,
        isDarkRef.current ? labelColorDarkTheme : labelColorLightTheme
      )
      label.position.y = scale / 2 + LABEL_OFFSET
      label.renderOrder = 30
      label.padding = 2 
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
        const material = isDim
          ? getSpriteMaterial(dimColor, isDark)
          : getSpriteMaterial(ud.baseColor, isDark)
        const sprite = ud.sprite
        if (sprite && sprite.material !== material) sprite.material = material
        if (ud.label) {
          ud.label.color = isDark ? labelColorDarkTheme : labelColorLightTheme
        }
      }
    })
  }, [selectedNode, focusedNode, neighbors, dimColor, isDark])

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
        nodeLabel={isPerformanceMode ? undefined : (n: any) => n.label}
        linkVisibility={linkVisibility}
        linkColor={linkColor}
        linkOpacity={0.9}
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

      <div className="bg-background/60 absolute bottom-2 left-2 flex flex-col rounded-xl border-2 backdrop-blur-lg">
        <ZoomControl3D fgRef={fgRef} />
        <LegendButton />
        <Settings />
      </div>

      {showPropertyPanel && (
        <div className="absolute top-2 right-2 z-10">
          <PropertiesView />
        </div>
      )}

      {showLegend && (
        <div className="absolute right-2 bottom-10 z-0">
          <Legend className="bg-background/60 backdrop-blur-lg" />
        </div>
      )}

      <SettingsDisplay />
    </div>
  )
}

export default GraphViewer3D
