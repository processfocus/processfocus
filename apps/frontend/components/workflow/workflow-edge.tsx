import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react"
import { getWorkflowEdgeRoute } from "@/lib/workflow/edge-routing"

type EdgeState =
  | "highlighted"
  | "error"
  | "scheduled"
  | "conditional"
  | "conditionalAndScheduled"
  | "default"

const EDGE_COLORS = {
  highlighted: { stroke: "#818cf8", text: "#4f46e5", bg: "#eef2ff" },
  error: { stroke: "#dc2626", text: "#991b1b", bg: "#fef2f2" },
  scheduled: { stroke: "#f59e0b", text: "#92400e", bg: "#fffbeb" },
  conditional: { stroke: null, text: "#64748b", bg: "#f8fafc" },
  conditionalAndScheduled: {
    stroke: "#d97706",
    text: "#78350f",
    bg: "#fef3c7",
  },
  default: { stroke: null, text: "#64748b", bg: "#f8fafc" },
} as const

const EDGE_DASH_PATTERNS: Record<EdgeState, string | undefined> = {
  highlighted: undefined, //              ————————————————
  error: "10 4", //                      ————  ————
  scheduled: "2 4", //                    ··············
  conditional: "6 4", //                  — — — — — —
  conditionalAndScheduled: "6 4 2 4", //  — · — · — ·
  default: undefined, //                  ————————————————
}

function getEdgeState(data: WorkflowEdgeData | undefined): EdgeState {
  if (data?.isHighlighted) return "highlighted"
  if (data?.isOnError) return "error"
  if (data?.isConditionalAndScheduled) return "conditionalAndScheduled"
  if (data?.isScheduled) return "scheduled"
  if (data?.isConditional) return "conditional"
  return "default"
}

interface WorkflowEdgeData {
  edgeIndex: number
  totalEdges: number
  sourceColumn: number
  targetColumn: number
  gapWidth?: number
  targetPrecedingGapWidth?: number
  labelMaxWidth?: number
  isCrossLane?: boolean
  isHighlighted?: boolean
  isOnError?: boolean
  isConditional?: boolean
  isScheduled?: boolean
  isConditionalAndScheduled?: boolean
}

/**
 * Custom edge for workflow visualization.
 * Forward cross-swimlane edges stay horizontal until the target column gap,
 * then turn near the target so they read as one long outgoing path.
 */
export function WorkflowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  label,
  labelStyle,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const edgeData = data as WorkflowEdgeData | undefined
  const edgeIndex = edgeData?.edgeIndex ?? 0
  const totalEdges = edgeData?.totalEdges ?? 1
  const sourceColumn = edgeData?.sourceColumn ?? 1
  const targetColumn = edgeData?.targetColumn ?? 2
  // The route helper owns default gap fallbacks when edge metadata is missing.
  const gapWidth = edgeData?.gapWidth
  const targetPrecedingGapWidth = edgeData?.targetPrecedingGapWidth
  const labelMaxWidth = edgeData?.labelMaxWidth
  const isCrossLane = edgeData?.isCrossLane ?? false
  const isHighlighted = edgeData?.isHighlighted ?? false

  const edgeState = getEdgeState(edgeData)

  const colors = EDGE_COLORS[edgeState]
  const strokeColor = colors.stroke ?? (style?.stroke as string) ?? "#94a3b8"

  // Determine dash pattern based on edge state
  const strokeDasharray = EDGE_DASH_PATTERNS[edgeState]

  // Apply highlight, scheduled, and conditional styling
  const edgeStyle: React.CSSProperties = {
    ...style,
    stroke: strokeColor,
    strokeWidth: isHighlighted ? 3 : ((style?.strokeWidth as number) ?? 1.5),
    strokeDasharray,
    transition: "stroke 150ms ease-in-out, stroke-width 150ms ease-in-out",
  }

  const {
    path: edgePath,
    labelX,
    labelY,
  } = getWorkflowEdgeRoute({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourceColumn,
    targetColumn,
    sourceGapWidth: gapWidth,
    targetPrecedingGapWidth,
    edgeIndex,
    totalEdges,
    isCrossLane,
  })

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={edgeStyle}
        {...(markerEnd ? { markerEnd } : {})}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              fontSize: (labelStyle as React.CSSProperties)?.fontSize ?? 11,
              color:
                colors.text ??
                (labelStyle as React.CSSProperties)?.fill ??
                "#64748b",
              background:
                colors.bg ??
                (labelBgStyle as React.CSSProperties)?.fill ??
                "#f8fafc",
              border: `1px solid ${colors.stroke ?? (labelBgStyle as React.CSSProperties)?.stroke ?? "#e2e8f0"}`,
              padding: labelBgPadding
                ? `${(labelBgPadding as [number, number])[1]}px ${(labelBgPadding as [number, number])[0]}px`
                : "2px 4px",
              borderRadius: labelBgBorderRadius ?? 4,
              boxSizing: "border-box",
              maxWidth: labelMaxWidth,
              whiteSpace: "normal",
              textAlign: "center",
              lineHeight: 1.3,
              overflowWrap: "anywhere",
              pointerEvents: "all",
              transition:
                "color 150ms ease-in-out, background 150ms ease-in-out, border-color 150ms ease-in-out",
            }}
            className="nodrag nopan"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
