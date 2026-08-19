import { useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react'
import * as THREE from 'three'
import ForceGraph3D from 'react-force-graph-3d'
import SpriteText from 'three-spritetext'
import { GraphSearchOption, OptionItem } from '@react-sigma/graph-search'

import GraphLabels from '@/components/graph/GraphLabels'
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

// --- Shared WebGL resources (module-level singletons) ---
// three-forcegraph deallocates an object's material/texture whenever a node or
// link is removed (expand/prune, visibility toggle, re-digest). Since these are
// shared across many objects, we neutralize dispose() so one removal can't tear
// down resources still in use by the rest of the graph.

const NODE_GLOW_SCALE = 9
const FADE_LINE_VERTICES = 6
const LINK_DISTANCE = 60
const CHARGE_STRENGTH = -60
const LABEL_TEXT_HEIGHT = 5
const LABEL_OFFSET = 3
const INITIAL_DEPTH_MIN = LINK_DISTANCE * 1.5
const INITIAL_DEPTH_RATIO = 0.45

// Keep the initial depth stable across renders so expanding or pruning the
// graph does not make nodes jump to a new random position.
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
let fadeLineMaterial: THREE.ShaderMaterial | null = null

// Solid glowing particle with a crisp outer circumference: a bright interior
// disc plus a hard, fully-opaque ring so the boundary is clearly defined.
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

// Per-vertex alpha so each edge fades out toward both endpoints.
function getFadeLineMaterial(): THREE.ShaderMaterial {
  if (fadeLineMaterial) return fadeLineMaterial
  fadeLineMaterial = new THREE.ShaderMaterial({
    vertexShader: `
      attribute vec3 aColor;
      attribute float aAlpha;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = aColor;
        vAlpha = aAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        gl_FragColor = vec4(vColor, vAlpha);
      }
    `,
    transparent: true,
    depthWrite: false
  })
  fadeLineMaterial.dispose = () => undefined
  return fadeLineMaterial
}

const GraphViewer3D = () => {
  const fgRef = useRef<any>(null)
  const didAutoFitRef = useRef(false)

  const sigmaGraph = useGraphStore.use.sigmaGraph()
  const graphNodeCount = useGraphStore.use.graphNodeCount()
  const graphEdgeCount = useGraphStore.use.graphEdgeCount()
  const graphDataVersion = useGraphStore.use.graphDataVersion()

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

  // Labels are costly on large graphs; mirror the 2D viewer's threshold.
  const showLabels = showNodeLabel && graphNodeCount <= LABEL_RENDER_LIMIT
  const showLabelsRef = useRef(showLabels)
  useEffect(() => {
    showLabelsRef.current = showLabels
  }, [showLabels])

  // Data transformation: graphology graph -> react-force-graph { nodes, links }.
  // Depends on the reactive count/version mirrors (not just sigmaGraph) because
  // expand/prune mutate the graph in place without replacing the instance.
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
        // graphology edge key === store's dynamicId, needed to write back
        // edge hover/click selection for PropertiesView.
        __graphId: id
      })
    )
    return { nodes, links }
    // graphology mutates in place on expand/prune/rename; the count/version
    // mirrors are required deps to bust this memo's cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigmaGraph, graphNodeCount, graphEdgeCount, graphDataVersion])

  // Neighbour set of the active (selected or focused) node, for dimming.
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

  // Glow particle node: a screen-facing sprite tinted by the node color, with a
  // soft halo from the radial texture. Additive in dark mode (luminous), normal
  // in light mode (still visible on a bright background).
  const nodeThreeObject = useCallback((node: any) => {
    const baseColor = node.color ?? '#5D6D7E'
    const group = new THREE.Group()
    const sprite = new THREE.Sprite(getSpriteMaterial(baseColor, isDarkRef.current))
    const scale = Math.cbrt(node.size ?? 10) * NODE_GLOW_SCALE
    sprite.scale.set(scale, scale, 1)
    sprite.renderOrder = 20 // draw glow nodes above links
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

  // Fade line: a multi-vertex polyline whose per-vertex alpha stays opaque along
  // most of the span and fades only at the two endpoints, so the visible edge
  // reaches close to both particles. Colors are written by the highlight effect.
  const linkThreeObject = useCallback((link: any) => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(FADE_LINE_VERTICES * 3), 3)
    )
    geometry.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(FADE_LINE_VERTICES * 3), 3))
    const alpha = new Float32Array(FADE_LINE_VERTICES)
    alpha[0] = 0
    alpha[FADE_LINE_VERTICES - 1] = 0
    for (let i = 1; i < FADE_LINE_VERTICES - 1; i++) alpha[i] = 1
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1))
    const line = new THREE.Line(geometry, getFadeLineMaterial())
    const base = new THREE.Color(isDarkRef.current ? edgeColorDarkTheme : '#cccccc')
    const colors = geometry.attributes.aColor.array as Float32Array
    for (let i = 0; i < FADE_LINE_VERTICES; i++) {
      colors[i * 3] = base.r
      colors[i * 3 + 1] = base.g
      colors[i * 3 + 2] = base.b
    }
    line.userData = { type: 'fadeLink', linkId: link.__graphId }
    return line
  }, [])

  const linkPositionUpdate = useCallback((lineObj: any, { start, end }: any) => {
    const pos = lineObj.geometry.attributes.position.array as Float32Array
    const sx = start.x
    const sy = start.y ?? 0
    const sz = start.z ?? 0
    const ex = end.x
    const ey = end.y ?? 0
    const ez = end.z ?? 0
    for (let i = 0; i < FADE_LINE_VERTICES; i++) {
      const t = i / (FADE_LINE_VERTICES - 1)
      pos[i * 3] = sx + (ex - sx) * t
      pos[i * 3 + 1] = sy + (ey - sy) * t
      pos[i * 3 + 2] = sz + (ez - sz) * t
    }
    lineObj.geometry.attributes.position.needsUpdate = true
    return true
  }, [])

  // Custom objects bypass the library's accessor-driven color updates, so we
  // drive dim/highlight colors ourselves. Traversal reflects the current scene
  // (robust to expand/prune adding/removing objects).
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    const activeNode = selectedNode ?? focusedNode
    const activeEdge = selectedEdge ?? focusedEdge
    const highlightColor = new THREE.Color(edgeColorSelected)
    const baseEdgeColor = new THREE.Color(isDark ? edgeColorDarkTheme : '#cccccc')
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
      } else if (ud.type === 'fadeLink') {
        const color = activeEdge && ud.linkId === activeEdge ? highlightColor : baseEdgeColor
        const colors = obj.geometry.attributes.aColor.array as Float32Array
        for (let i = 0; i < FADE_LINE_VERTICES; i++) {
          colors[i * 3] = color.r
          colors[i * 3 + 1] = color.g
          colors[i * 3 + 2] = color.b
        }
        obj.geometry.attributes.aColor.needsUpdate = true
      }
    })
  }, [selectedNode, focusedNode, selectedEdge, focusedEdge, neighbors, dimColor, isDark])

  // Spread nodes apart: d3-force-3d defaults to a short link distance (30) and
  // weak repulsion (-60), which packs the graph too tightly. Tune both before
  // the simulation starts. useLayoutEffect runs before the debounced digest that
  // kicks off the layout, and deliberately does NOT reheat: reheating sets
  // engineRunning=true before state.layout is assigned, which crashes the tick
  // loop ("Cannot read properties of undefined (reading 'tick')").
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

  // Focus the camera on the selected node when requested (e.g. search select).
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
        nodeLabel={(n: any) => n.label}
        linkThreeObject={linkThreeObject}
        linkPositionUpdate={linkPositionUpdate}
        linkVisibility={linkVisibility}
        linkLabel={(l: any) => l.label}
        enableNodeDrag={enableNodeDrag}
        cooldownTicks={150}
        warmupTicks={sigmaGraph && sigmaGraph.order > 2000 ? 0 : 30}
        onEngineStop={() => {
          if (!didAutoFitRef.current && graphData.nodes.length > 0) {
            didAutoFitRef.current = true
            fgRef.current?.zoomToFit(600)
          }
        }}
        onNodeHover={(n: any) => useGraphStore.getState().setFocusedNode(n?.id ?? null)}
        onNodeClick={(n: any) => useGraphStore.getState().setSelectedNode(n.id)}
        onLinkHover={(l: any) => useGraphStore.getState().setFocusedEdge(l?.__graphId ?? null)}
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
