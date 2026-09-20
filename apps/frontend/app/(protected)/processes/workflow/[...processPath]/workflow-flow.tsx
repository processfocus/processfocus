"use client"

import {
  type ColorMode,
  Controls,
  MiniMap,
  type NodeChange,
  type NodeMouseHandler,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import type { Edge, Node } from "@xyflow/react"
import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { useWorkflowAutoRefresh } from "./use-workflow-auto-refresh"
import { WorkflowFormPreviewSheet } from "./workflow-form-preview-sheet"
import { useTheme } from "@/components/theme-provider"
import { StepNode } from "@/components/workflow/step-node"
import { SwimlaneNode } from "@/components/workflow/swimlane-node"
import { WorkflowEdge } from "@/components/workflow/workflow-edge"
import type { ProcessWorkflowQuery } from "@/lib/generated/gql/graphql"
import { canPreviewWorkflowStepForm } from "@/lib/workflow/form-preview"
import {
  CONTAINER_PADDING,
  MIN_CONTAINER_HEIGHT,
  SWIMLANE_VERTICAL_GAP,
  applyMeasuredLayout,
  createInitialLayout,
} from "@/lib/workflow/layout"
import type {
  WorkflowStepData,
  WorkflowSwimlaneData,
} from "@/lib/workflow/types"

const nodeTypes = {
  swimlane: SwimlaneNode,
  workflowStep: StepNode,
}

const edgeTypes = {
  workflow: WorkflowEdge,
}

type WorkflowData = NonNullable<ProcessWorkflowQuery["processWorkflow"]>

interface WorkflowFlowProps {
  initialNodes: Node[]
  edges: Edge[]
}

interface WorkflowFlowOuterProps {
  initialWorkflowData: WorkflowData
  initialNodes: Node[]
  edges: Edge[]
  processPath: string
}

/**
 * Calculate container height from swimlane nodes
 */
function calculateContainerHeight(nodes: Node[]): number {
  const swimlanes = nodes.filter((n) => n.type === "swimlane")
  const totalHeight = swimlanes.reduce((sum, node) => {
    const data = node.data as WorkflowSwimlaneData
    return sum + data.height + SWIMLANE_VERTICAL_GAP
  }, 0)
  return Math.max(MIN_CONTAINER_HEIGHT, totalHeight + CONTAINER_PADDING)
}

interface WorkflowFlowInnerProps extends WorkflowFlowProps {
  onHeightChange: (height: number) => void
  onFormStepSelect: (step: WorkflowStepData) => void
}

/**
 * Inner component that handles the two-pass layout.
 * Must be inside ReactFlowProvider to use hooks.
 */
function WorkflowFlowInner({
  initialNodes,
  edges,
  onHeightChange,
  onFormStepSelect,
}: WorkflowFlowInnerProps) {
  const { resolvedTheme } = useTheme()
  const colorMode: ColorMode | undefined =
    resolvedTheme === "dark"
      ? "dark"
      : resolvedTheme === "light"
        ? "light"
        : undefined
  const [{ nodes, measuredHeight }, setLayout] = useState<{
    nodes: Node[]
    measuredHeight: number | null
  }>({ nodes: initialNodes, measuredHeight: null })
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const { setViewport, getViewport } = useReactFlow()

  // Memoize edges with highlight info based on hovered node
  const highlightedEdges = useMemo(() => {
    if (!hoveredNodeId) return edges
    return edges.map((edge) => ({
      ...edge,
      data: {
        ...edge.data,
        isHighlighted:
          edge.source === hoveredNodeId || edge.target === hoveredNodeId,
      },
    }))
  }, [edges, hoveredNodeId])

  const onNodeMouseEnter: NodeMouseHandler = useCallback((_event, node) => {
    if (node.type === "workflowStep") {
      setHoveredNodeId(node.id)
    }
  }, [])

  const onNodeMouseLeave: NodeMouseHandler = useCallback(() => {
    setHoveredNodeId(null)
  }, [])

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      if (node.type !== "workflowStep") return

      const stepData = node.data as WorkflowStepData
      if (!canPreviewWorkflowStepForm(stepData)) return

      onFormStepSelect(stepData)
    },
    [onFormStepSelect],
  )

  // Reset layout and nodes together when initialNodes prop reference changes
  // (e.g., navigating to different workflow or auto-refresh data update)
  useEffect(() => {
    setLayout({ nodes: initialNodes, measuredHeight: null })
  }, [initialNodes])

  // Publish layout effects only after React commits the measured nodes. Keep
  // them out of the state updater, which React may replay or discard.
  useEffect(() => {
    if (measuredHeight === null) return

    const frame = requestAnimationFrame(() => {
      onHeightChange(measuredHeight)
      const currentViewport = getViewport()
      setViewport({ x: 0, y: 0, zoom: currentViewport.zoom || 1 })
    })
    return () => cancelAnimationFrame(frame)
  }, [measuredHeight, onHeightChange, getViewport, setViewport])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setLayout((currentLayout) => {
      // Apply React Flow's changes first
      const updatedNodes = applyNodeChanges(changes, currentLayout.nodes)

      // If layout already applied, just return the updated nodes
      if (currentLayout.measuredHeight !== null) {
        return { ...currentLayout, nodes: updatedNodes }
      }

      // Check if we have dimension changes
      const hasDimensionChanges = changes.some(
        (change) => change.type === "dimensions",
      )
      if (!hasDimensionChanges) {
        return { ...currentLayout, nodes: updatedNodes }
      }

      // Check if all step nodes now have measurements
      const stepNodes = updatedNodes.filter((n) => n.type === "workflowStep")
      const allMeasured =
        stepNodes.length > 0 &&
        stepNodes.every((n) => n.measured?.height !== undefined)

      if (allMeasured) {
        // Commit the nodes and completion marker atomically so replaying this
        // updater always produces the same measured layout.
        const measuredNodes = applyMeasuredLayout(updatedNodes)
        return {
          nodes: measuredNodes,
          measuredHeight: calculateContainerHeight(measuredNodes),
        }
      }

      return { ...currentLayout, nodes: updatedNodes }
    })
  }, [])

  return (
    <ReactFlow
      nodes={nodes}
      edges={highlightedEdges}
      {...(colorMode ? { colorMode } : {})}
      onNodesChange={onNodesChange}
      onNodeMouseEnter={onNodeMouseEnter}
      onNodeMouseLeave={onNodeMouseLeave}
      onNodeClick={onNodeClick}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={true}
      defaultViewport={{ x: 0, y: 0, zoom: 1 }}
    >
      <Controls />
      <MiniMap />
    </ReactFlow>
  )
}

/**
 * Static workflow visualization with container height management.
 * Shared between Suspense fallback and auto-refresh wrapper.
 */
function StaticWorkflowFlow({
  initialNodes,
  edges,
}: {
  initialNodes: Node[]
  edges: Edge[]
}) {
  const initialHeight = calculateContainerHeight(initialNodes)
  const [containerHeight, setContainerHeight] = useState(initialHeight)
  const [selectedStep, setSelectedStep] = useState<WorkflowStepData | null>(
    null,
  )
  const handlePreviewOpenChange = useCallback((isOpen: boolean) => {
    if (!isOpen) {
      setSelectedStep(null)
    }
  }, [])

  return (
    <>
      <section
        aria-label="Workflow diagram"
        style={{ width: "100%", height: `${containerHeight}px` }}
      >
        <ReactFlowProvider>
          <WorkflowFlowInner
            initialNodes={initialNodes}
            edges={edges}
            onHeightChange={setContainerHeight}
            onFormStepSelect={setSelectedStep}
          />
        </ReactFlowProvider>
      </section>
      {selectedStep ? (
        <WorkflowFormPreviewSheet
          key={selectedStep.id}
          step={selectedStep}
          open={true}
          onOpenChange={handlePreviewOpenChange}
        />
      ) : null}
    </>
  )
}

/**
 * Inner wrapper that uses the auto-refresh hook (requires Suspense boundary
 * because useWorkflowAutoRefresh calls `use()` for the process collection).
 */
function WorkflowFlowWithAutoRefresh({
  initialWorkflowData,
  initialNodes,
  edges,
  processPath,
}: WorkflowFlowOuterProps) {
  const { workflowData, refreshCount } = useWorkflowAutoRefresh(
    processPath,
    initialWorkflowData,
  )

  // Recompute layout when workflow data changes
  const { nodes: currentNodes, edges: currentEdges } = useMemo(
    () => createInitialLayout(workflowData),
    [workflowData],
  )

  // Use server-provided layout for initial render, auto-refresh layout after
  const activeNodes = refreshCount === 0 ? initialNodes : currentNodes
  const activeEdges = refreshCount === 0 ? edges : currentEdges

  return <StaticWorkflowFlow initialNodes={activeNodes} edges={activeEdges} />
}

/**
 * Client-side React Flow component for workflow visualization.
 * Renders swimlanes and workflow steps with pan/zoom controls.
 * Uses two-pass layout: initial render, then measure and center vertically.
 * Container height adjusts dynamically based on content.
 * Wraps auto-refresh in Suspense so it works when process collection isn't loaded yet.
 */
export function WorkflowFlow({
  initialWorkflowData,
  initialNodes,
  edges,
  processPath,
}: WorkflowFlowOuterProps) {
  return (
    <Suspense
      fallback={
        <StaticWorkflowFlow initialNodes={initialNodes} edges={edges} />
      }
    >
      <WorkflowFlowWithAutoRefresh
        initialWorkflowData={initialWorkflowData}
        initialNodes={initialNodes}
        edges={edges}
        processPath={processPath}
      />
    </Suspense>
  )
}
