/**
 * Data for a workflow step node in React Flow
 */
export interface WorkflowStepData extends Record<string, unknown> {
  id: string
  name: string
  path: string
  purpose: string
  /** Display swimlane label (can differ from the underlying workflow role) */
  roleName: string
  /** Display swimlane id (can differ from the underlying workflow role) */
  roleId: string
  /** Column position (1-indexed) for horizontal placement */
  column: number
  /** Vertical branch track within the swimlane */
  branchTrack: number
  /** Optional phase name if step belongs to a phase */
  phaseName?: string | undefined
  /** Optional phase ID if step belongs to a phase */
  phaseId?: string | undefined
  /** Phase index for color lookup (based on order of appearance) */
  phaseIndex?: number | undefined
  isStartStep: boolean
  isEmbedded: boolean
  /** Number of outgoing edges from this step (for handle positioning) */
  outgoingEdgeCount: number
  /** Number of incoming edges to this step (for handle positioning) */
  incomingEdgeCount: number
  /** Source-side flow line anchor positions to render */
  sourceHandleSlots: Array<"top" | "middle" | "bottom">
  /** Target-side flow line anchor positions to render */
  targetHandleSlots: Array<"top" | "middle" | "bottom">
  /** True if this is a system step (NodeStep) without a role */
  isSystemStep: boolean
}

/**
 * Unique phase info for the legend display
 */
export interface WorkflowPhaseInfo {
  id: string
  name: string
  /** Color index for phase styling */
  index: number
  /** 1-indexed order for sorting phases in the legend */
  order: number
}

/**
 * Data for a swimlane node in React Flow
 */
export interface WorkflowSwimlaneData extends Record<string, unknown> {
  /** Display swimlane id (can differ from the underlying workflow role) */
  roleId: string
  /** Display swimlane label */
  roleName: string
  /** Optional responsibility text for this role in this process */
  responsibility?: string | undefined
  width: number
  height: number
  /** True if this is the system swimlane for NodeSteps */
  isSystem?: boolean | undefined
}
