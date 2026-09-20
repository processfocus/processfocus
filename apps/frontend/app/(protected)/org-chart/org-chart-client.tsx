"use client"

import {
  Background,
  type ColorMode,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  type NodeTypes,
  ReactFlow,
} from "@xyflow/react"
import { OrgUnitNode } from "@/components/OrgUnitNode"
import { useTheme } from "@/components/theme-provider"
import type { OrgUnitNodeData } from "@/lib/org-chart-types"

interface OrgChartClientProps {
  nodes: Node<OrgUnitNodeData>[]
  edges: Edge[]
}

const nodeTypes = {
  orgUnit: OrgUnitNode,
} satisfies NodeTypes

// Depth-based hex colors for minimap
const depthColors = [
  "#a855f7", // Purple - Depth 1
  "#3b82f6", // Blue - Depth 2
  "#10b981", // Emerald - Depth 3
  "#f59e0b", // Amber - Depth 4
  "#64748b", // Slate - Depth 5+
] as const

const DEFAULT_COLOR = "#64748b"

export function OrgChartClient({ nodes, edges }: OrgChartClientProps) {
  const { resolvedTheme } = useTheme()
  const colorMode: ColorMode | undefined =
    resolvedTheme === "dark"
      ? "dark"
      : resolvedTheme === "light"
        ? "light"
        : undefined

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      {...(colorMode ? { colorMode } : {})}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      minZoom={0.1}
      maxZoom={1.5}
      defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <Controls />
      <MiniMap
        nodeColor={(node) => {
          const nodeData = node.data as OrgUnitNodeData
          const depth = nodeData.depth ?? 1
          const depthIndex = Math.max(
            0,
            Math.min(depth - 1, depthColors.length - 1),
          )
          return depthColors[depthIndex] ?? DEFAULT_COLOR
        }}
      />
    </ReactFlow>
  )
}
