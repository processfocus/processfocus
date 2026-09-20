import type { Edge, Node } from "@xyflow/react"
import { ROLE_LABEL_WIDTH } from "./constants"
import type {
  WorkflowPhaseInfo,
  WorkflowStepData,
  WorkflowSwimlaneData,
} from "./types"
import type { ProcessWorkflowQuery } from "@/lib/generated/gql/graphql"

// Layout constants
const INITIAL_SWIMLANE_HEIGHT = 160 // Generous initial height before measurement
const STEP_WIDTH = 280
export const DEFAULT_STEP_GAP = 80
const SWIMLANE_PADDING = 24 // Vertical padding around steps
const STACKED_STEP_GAP = 16 // Gap between vertically stacked steps in same column
export const BRANCH_TRACK_GAP = 16
// Keep this estimate aligned with the rendered edge-label font size and family.
const EDGE_LABEL_ESTIMATED_CHAR_WIDTH = 6.5
const EDGE_LABEL_MIN_WRAP_WIDTH = 120
const EDGE_LABEL_MAX_WRAP_WIDTH = 180
const EDGE_LABEL_HORIZONTAL_MARGIN = 16

// Exported constants for container height calculation
export const SWIMLANE_VERTICAL_GAP = 20
export const CONTAINER_PADDING = 40
export const MIN_CONTAINER_HEIGHT = 400

/**
 * Result of layout functions including nodes, edges, and phase info.
 */
interface LayoutResult {
  nodes: Array<Node<WorkflowStepData> | Node<WorkflowSwimlaneData>>
  edges: Edge[]
  phases: WorkflowPhaseInfo[]
}

interface StepCell {
  roleId: string
  track: number
  column: number
  steps: Node[]
}

type WorkflowData = NonNullable<ProcessWorkflowQuery["processWorkflow"]>
type WorkflowFlow = WorkflowData["flows"][number]
type FlowDirection = "up" | "straight" | "down"
type WorkflowHandleSlot = WorkflowStepData["sourceHandleSlots"][number]

const SYSTEM_ROLE_ID = "__system__"
const SYSTEM_ROLE_NAME = "SYSTEM"
const ANONYMOUS_SWIMLANE_SUFFIX = "__anonymous__"
const ANONYMOUS_SWIMLANE_NAME = "Anonymous"
// Exact same-row flows share a Y; keep this below the 1px same-cell tie-breaker.
const STRAIGHT_LINE_Y_TOLERANCE_PX = 0.5

function getFlowLabel(flow: WorkflowFlow): string | undefined {
  if (flow.condition) return flow.condition
  if (flow.isOnError) {
    return flow.taggedErrors && flow.taggedErrors.length > 0
      ? `onError(${flow.taggedErrors.join(", ")})`
      : "onError"
  }
  if (flow.isElse) return "else"
  return flow.schedule ?? undefined
}

function getOrderedHandleSlots(
  slots: ReadonlySet<WorkflowHandleSlot> | undefined,
): WorkflowHandleSlot[] {
  if (!slots) return []

  return (["top", "middle", "bottom"] as const).filter((slot) =>
    slots.has(slot),
  )
}

function getFlowDirection(
  sourceY: number | undefined,
  targetY: number | undefined,
  isStraight: boolean,
): FlowDirection {
  if (isStraight || sourceY === undefined || targetY === undefined) {
    return "straight"
  }

  if (targetY < sourceY) return "up"
  if (targetY > sourceY) return "down"
  return "straight"
}

function getPreferredSourceHandleSlot(
  direction: FlowDirection,
): WorkflowHandleSlot {
  if (direction === "up") return "top"
  if (direction === "down") return "bottom"
  return "middle"
}

function getPreferredTargetHandleSlot(
  direction: FlowDirection,
): WorkflowHandleSlot {
  if (direction === "up") return "bottom"
  if (direction === "down") return "top"
  return "middle"
}

function assignHandleSlots(
  flows: ReadonlyArray<WorkflowFlow>,
  getPreferredSlot: (flow: WorkflowFlow) => WorkflowHandleSlot,
): Map<string, WorkflowHandleSlot> {
  const assignedSlots = new Map<string, WorkflowHandleSlot>()
  const remainingTwoSlots: WorkflowHandleSlot[] = ["top", "bottom"]
  const remainingThreeSlots: WorkflowHandleSlot[] = ["top", "middle", "bottom"]

  if (flows.length <= 1) {
    const flow = flows[0]
    if (flow) assignedSlots.set(flow.id, "middle")
    return assignedSlots
  }

  if (flows.length > 3) {
    // More than three flows may share anchors; preserving up/down direction is
    // more important than forcing every line onto a distinct slot.
    for (const flow of flows) {
      assignedSlots.set(flow.id, getPreferredSlot(flow))
    }
    return assignedSlots
  }

  const remainingSlots =
    flows.length === 2 ? remainingTwoSlots : remainingThreeSlots
  const usedSlots = new Set<WorkflowHandleSlot>()

  for (const flow of flows) {
    const preferredSlot = getPreferredSlot(flow)
    if (preferredSlot === "middle") {
      // Straight lines always stay centre-to-centre, even when there are two
      // flows and the normal two-flow slots would otherwise be top and bottom.
      assignedSlots.set(flow.id, "middle")
      usedSlots.add("middle")
      continue
    }

    if (
      !usedSlots.has(preferredSlot) &&
      remainingSlots.includes(preferredSlot)
    ) {
      assignedSlots.set(flow.id, preferredSlot)
      usedSlots.add(preferredSlot)
    }
  }

  for (const flow of flows) {
    if (assignedSlots.has(flow.id)) continue

    const fallbackSlot = remainingSlots.find((slot) => !usedSlots.has(slot))
    // If all distinct slots are taken, the edge-level fallback keeps the line centred.
    if (!fallbackSlot) continue

    assignedSlots.set(flow.id, fallbackSlot)
    usedSlots.add(fallbackSlot)
  }

  return assignedSlots
}

function groupFlowsByStepId(
  flows: ReadonlyArray<WorkflowFlow>,
  getStepId: (flow: WorkflowFlow) => string,
): Map<string, WorkflowFlow[]> {
  const flowsByStepId = new Map<string, WorkflowFlow[]>()

  for (const flow of flows) {
    const stepId = getStepId(flow)
    const groupedFlows = flowsByStepId.get(stepId) ?? []
    groupedFlows.push(flow)
    flowsByStepId.set(stepId, groupedFlows)
  }

  return flowsByStepId
}

function getStepDirectionYByStepId(
  stepNodes: ReadonlyArray<Node>,
): Map<string, number> {
  const directionYByStepId = new Map<string, number>()
  const stepNodesByCell = new Map<string, Node[]>()

  for (const stepNode of stepNodes) {
    const data = stepNode.data as WorkflowStepData
    const key = `${data.roleId}:${data.branchTrack}:${data.column}`
    const cellStepNodes = stepNodesByCell.get(key) ?? []
    cellStepNodes.push(stepNode)
    stepNodesByCell.set(key, cellStepNodes)
  }

  for (const cellStepNodes of stepNodesByCell.values()) {
    cellStepNodes.forEach((stepNode, index) => {
      // Initial layout stacks same-cell steps at the same Y. Use the insertion
      // order as a deterministic pre-measurement vertical tie-breaker.
      directionYByStepId.set(stepNode.id, stepNode.position.y + index)
    })
  }

  return directionYByStepId
}

// Returns 0 when no extra gap is needed, otherwise the wrapped label width to
// reserve before adding horizontal margins.
function estimateWrappedLabelWidth(label: string): number {
  const normalizedLabel = label.trim().replace(/\s+/g, " ")
  if (normalizedLabel.length === 0) return 0

  const estimatedSingleLineWidth =
    normalizedLabel.length * EDGE_LABEL_ESTIMATED_CHAR_WIDTH

  if (
    estimatedSingleLineWidth <=
    DEFAULT_STEP_GAP - EDGE_LABEL_HORIZONTAL_MARGIN * 2
  ) {
    return 0
  }

  return Math.min(
    EDGE_LABEL_MAX_WRAP_WIDTH,
    Math.max(EDGE_LABEL_MIN_WRAP_WIDTH, estimatedSingleLineWidth),
  )
}

/**
 * Create initial layout for workflow nodes.
 * Steps are positioned at the top of swimlanes initially.
 * After React Flow measures nodes, use applyMeasuredLayout() to center them.
 */
export function createInitialLayout(workflowData: WorkflowData): LayoutResult {
  // Guard clause for empty workflows
  if (workflowData.steps.length === 0) {
    return { nodes: [], edges: [], phases: [] }
  }

  const nodes: Array<Node<WorkflowStepData> | Node<WorkflowSwimlaneData>> = []

  // Count outgoing and incoming edges per step for handle positioning
  const outgoingEdgeCounts = new Map<string, number>()
  const incomingEdgeCounts = new Map<string, number>()
  for (const flow of workflowData.flows) {
    outgoingEdgeCounts.set(
      flow.sourceStepId,
      (outgoingEdgeCounts.get(flow.sourceStepId) ?? 0) + 1,
    )
    incomingEdgeCounts.set(
      flow.targetStepId,
      (incomingEdgeCounts.get(flow.targetStepId) ?? 0) + 1,
    )
  }

  // Build unique phases list sorted by phase order
  const phaseMap = new Map<
    string,
    { id: string; name: string; order: number }
  >()
  for (const step of workflowData.steps) {
    if (step.phase && !phaseMap.has(step.phase.id)) {
      phaseMap.set(step.phase.id, {
        id: step.phase.id,
        name: step.phase.name,
        order: step.phase.order,
      })
    }
  }
  // Sort by order and assign color indices
  const sortedPhases = [...phaseMap.values()].sort((a, b) => a.order - b.order)
  const phases: WorkflowPhaseInfo[] = sortedPhases.map((phase, index) => ({
    id: phase.id,
    name: phase.name,
    index, // color index based on sorted position
    order: phase.order,
  }))
  // Build lookup for phaseId -> color index
  const phaseIndexMap = new Map<string, number>()
  for (const phase of phases) {
    phaseIndexMap.set(phase.id, phase.index)
  }

  // Build responsibility lookup by roleId (responsibility text and order)
  const responsibilityByRoleId = new Map<
    string,
    { responsibility: string; order: number | null | undefined }
  >()
  for (const resp of workflowData.responsibilities) {
    responsibilityByRoleId.set(resp.roleId, {
      responsibility: resp.responsibility,
      order: resp.order,
    })
  }

  type WorkflowStep = (typeof workflowData.steps)[number]
  type WorkflowLane = {
    id: string
    name: string
    responsibility?: string | undefined
    order: number | null | undefined
    encounterIndex: number
    isSystem: boolean
    baseRoleId: string
    steps: WorkflowStep[]
  }

  // Group steps by display swimlane. Embedded anonymous start steps render in a
  // separate swimlane so the process entry point is visible without hiding the
  // underlying role's regular swimlane.
  const lanesById = new Map<string, WorkflowLane>()
  const stepLaneIdByStepId = new Map<string, string>()
  workflowData.steps.forEach((step, encounterIndex) => {
    const baseRoleId = step.role?.id ?? SYSTEM_ROLE_ID
    const isAnonymousEmbeddedLane = Boolean(
      step.role && step.isStartStep && step.isEmbedded,
    )
    const laneId = isAnonymousEmbeddedLane
      ? `${baseRoleId}${ANONYMOUS_SWIMLANE_SUFFIX}`
      : baseRoleId
    const laneName = step.role
      ? isAnonymousEmbeddedLane
        ? `${ANONYMOUS_SWIMLANE_NAME} / ${step.role.name}`
        : step.role.name
      : SYSTEM_ROLE_NAME
    stepLaneIdByStepId.set(step.id, laneId)
    const existingLane = lanesById.get(laneId)

    if (existingLane) {
      existingLane.steps.push(step)
      return
    }

    const responsibility = responsibilityByRoleId.get(baseRoleId)
    lanesById.set(laneId, {
      id: laneId,
      name: laneName,
      responsibility: responsibility?.responsibility,
      order: responsibility?.order,
      encounterIndex,
      isSystem: baseRoleId === SYSTEM_ROLE_ID,
      baseRoleId,
      steps: [step],
    })
  })

  // Sort swimlanes by responsibility order (if defined), otherwise by encounter order.
  // Embedded anonymous swimlanes stay adjacent to their role and appear first.
  const sortedLanes = [...lanesById.values()].sort((a, b) => {
    if (a.isSystem) return 1
    if (b.isSystem) return -1

    if (a.order != null && b.order != null && a.order !== b.order) {
      return a.order - b.order
    }
    if (a.order != null && b.order == null) return -1
    if (a.order == null && b.order != null) return 1

    if (a.baseRoleId === b.baseRoleId) {
      const aIsAnonymousLane = a.id !== a.baseRoleId
      const bIsAnonymousLane = b.id !== b.baseRoleId

      if (aIsAnonymousLane !== bIsAnonymousLane) {
        return aIsAnonymousLane ? -1 : 1
      }
    }

    return a.encounterIndex - b.encounterIndex
  })

  // Calculate swimlane width and column positions based on max column.
  // Gaps expand only where edge labels need room to wrap without overlapping steps.
  const maxColumn =
    workflowData.steps.length > 0
      ? Math.max(...workflowData.steps.map((s) => s.column))
      : 1

  const stepColumnMap = new Map<string, number>()
  for (const step of workflowData.steps) {
    stepColumnMap.set(step.id, step.column)
  }

  const gapWidthByColumn = new Map<number, number>()
  for (let column = 1; column <= maxColumn; column += 1) {
    gapWidthByColumn.set(column, DEFAULT_STEP_GAP)
  }

  for (const flow of workflowData.flows) {
    const label = getFlowLabel(flow)
    if (!label) continue

    const sourceColumn = stepColumnMap.get(flow.sourceStepId) ?? 1
    const wrappedLabelWidth = estimateWrappedLabelWidth(label)
    const requiredGapWidth = Math.max(
      DEFAULT_STEP_GAP,
      wrappedLabelWidth + EDGE_LABEL_HORIZONTAL_MARGIN * 2,
    )

    gapWidthByColumn.set(
      sourceColumn,
      Math.max(
        gapWidthByColumn.get(sourceColumn) ?? DEFAULT_STEP_GAP,
        requiredGapWidth,
      ),
    )
  }

  const branchTrackByStepId = new Map<string, number>()
  for (const flow of workflowData.flows) {
    const sourceLaneId = stepLaneIdByStepId.get(flow.sourceStepId)
    const targetLaneId = stepLaneIdByStepId.get(flow.targetStepId)
    if (
      sourceLaneId === undefined ||
      targetLaneId === undefined ||
      sourceLaneId === targetLaneId
    ) {
      continue
    }

    const sourceColumn = stepColumnMap.get(flow.sourceStepId)
    const targetColumn = stepColumnMap.get(flow.targetStepId)
    if (
      sourceColumn === undefined ||
      targetColumn === undefined ||
      targetColumn <= sourceColumn + 1
    ) {
      continue
    }

    const crossesUnrelatedStepInSourceLane = workflowData.steps.some((step) => {
      if (step.id === flow.sourceStepId || step.id === flow.targetStepId) {
        return false
      }
      if (stepLaneIdByStepId.get(step.id) !== sourceLaneId) {
        return false
      }

      const stepColumn = stepColumnMap.get(step.id)
      return (
        stepColumn !== undefined &&
        stepColumn > sourceColumn &&
        stepColumn < targetColumn
      )
    })

    if (crossesUnrelatedStepInSourceLane) {
      // One alternate track covers this conservative guard; richer branch
      // packing can be added when multiple simultaneous obstacles need it.
      branchTrackByStepId.set(flow.sourceStepId, 1)
    }
  }

  const columnLeftXByColumn = new Map<number, number>()
  let currentColumnX = ROLE_LABEL_WIDTH + DEFAULT_STEP_GAP
  for (let column = 1; column <= maxColumn; column += 1) {
    columnLeftXByColumn.set(column, currentColumnX)
    currentColumnX +=
      STEP_WIDTH + (gapWidthByColumn.get(column) ?? DEFAULT_STEP_GAP)
  }
  const swimlaneWidth = currentColumnX - ROLE_LABEL_WIDTH

  // Create nodes for each display swimlane
  let currentY = 0
  for (const lane of sortedLanes) {
    const stepsInLane = lane.steps
    if (stepsInLane.length === 0) continue

    const firstStep = stepsInLane[0]
    if (!firstStep) continue
    const roleId = lane.id
    const roleName = lane.name
    const isSystemSwimlane = lane.isSystem

    // Use initial height - will be adjusted after measurement
    const swimlaneHeight = INITIAL_SWIMLANE_HEIGHT

    // Create swimlane background node - positioned at x:0 to include role label in bounds
    const swimlaneNode: Node<WorkflowSwimlaneData> = {
      id: `swimlane-${roleId}`,
      type: "swimlane",
      position: { x: 0, y: currentY },
      data: {
        roleId,
        roleName,
        responsibility: isSystemSwimlane ? undefined : lane.responsibility,
        width: swimlaneWidth,
        height: swimlaneHeight,
        isSystem: isSystemSwimlane,
      },
      draggable: false,
      selectable: false,
    }
    nodes.push(swimlaneNode)

    // Create step nodes - positioned at top initially
    for (const step of stepsInLane) {
      const stepX = columnLeftXByColumn.get(step.column)
      // step.column is always between 1 and maxColumn, so this lookup should exist.
      if (stepX == null) continue

      const stepNode: Node<WorkflowStepData> = {
        id: step.id,
        type: "workflowStep",
        position: {
          x: stepX,
          y: currentY + SWIMLANE_PADDING,
        },
        data: {
          id: step.id,
          name: step.name,
          path: step.path,
          purpose: step.purpose,
          roleName,
          roleId,
          column: step.column,
          branchTrack: branchTrackByStepId.get(step.id) ?? 0,
          phaseName: step.phase?.name,
          phaseId: step.phase?.id,
          phaseIndex: step.phase?.id
            ? phaseIndexMap.get(step.phase.id)
            : undefined,
          isStartStep: step.isStartStep,
          isEmbedded: step.isEmbedded,
          outgoingEdgeCount: outgoingEdgeCounts.get(step.id) ?? 0,
          incomingEdgeCount: incomingEdgeCounts.get(step.id) ?? 0,
          sourceHandleSlots: [],
          targetHandleSlots: [],
          isSystemStep: step.role === null,
        },
        draggable: false,
      }
      stepLaneIdByStepId.set(step.id, roleId)
      nodes.push(stepNode)
    }

    currentY += swimlaneHeight + SWIMLANE_VERTICAL_GAP
  }

  // Create edges from flows
  const workflowStepNodes = nodes.filter((node) => node.type === "workflowStep")
  const stepYByStepId = getStepDirectionYByStepId(workflowStepNodes)
  const directionByFlowId = new Map<string, FlowDirection>()

  for (const flow of workflowData.flows) {
    const sourceColumn = stepColumnMap.get(flow.sourceStepId) ?? 1
    const targetColumn = stepColumnMap.get(flow.targetStepId) ?? 1
    const sourceY = stepYByStepId.get(flow.sourceStepId)
    const targetY = stepYByStepId.get(flow.targetStepId)
    const isStraight =
      sourceY !== undefined &&
      targetY !== undefined &&
      Math.abs(sourceY - targetY) < STRAIGHT_LINE_Y_TOLERANCE_PX &&
      targetColumn === sourceColumn + 1

    directionByFlowId.set(
      flow.id,
      getFlowDirection(sourceY, targetY, isStraight),
    )
  }

  const flowsBySourceStepId = groupFlowsByStepId(
    workflowData.flows,
    (flow) => flow.sourceStepId,
  )
  const flowsByTargetStepId = groupFlowsByStepId(
    workflowData.flows,
    (flow) => flow.targetStepId,
  )
  const sourceHandleSlotByFlowId = new Map<string, WorkflowHandleSlot>()
  const targetHandleSlotByFlowId = new Map<string, WorkflowHandleSlot>()

  for (const flows of flowsBySourceStepId.values()) {
    const assignedSlots = assignHandleSlots(flows, (flow) =>
      getPreferredSourceHandleSlot(
        directionByFlowId.get(flow.id) ?? "straight",
      ),
    )
    for (const [flowId, slot] of assignedSlots) {
      sourceHandleSlotByFlowId.set(flowId, slot)
    }
  }

  for (const flows of flowsByTargetStepId.values()) {
    const assignedSlots = assignHandleSlots(flows, (flow) =>
      getPreferredTargetHandleSlot(
        directionByFlowId.get(flow.id) ?? "straight",
      ),
    )
    for (const [flowId, slot] of assignedSlots) {
      targetHandleSlotByFlowId.set(flowId, slot)
    }
  }

  const sourceHandleSlotsByStepId = new Map<string, Set<WorkflowHandleSlot>>()
  const targetHandleSlotsByStepId = new Map<string, Set<WorkflowHandleSlot>>()
  for (const flow of workflowData.flows) {
    const sourceSlot = sourceHandleSlotByFlowId.get(flow.id) ?? "middle"
    const targetSlot = targetHandleSlotByFlowId.get(flow.id) ?? "middle"
    const sourceSlots =
      sourceHandleSlotsByStepId.get(flow.sourceStepId) ??
      new Set<WorkflowHandleSlot>()
    const targetSlots =
      targetHandleSlotsByStepId.get(flow.targetStepId) ??
      new Set<WorkflowHandleSlot>()

    sourceSlots.add(sourceSlot)
    targetSlots.add(targetSlot)
    sourceHandleSlotsByStepId.set(flow.sourceStepId, sourceSlots)
    targetHandleSlotsByStepId.set(flow.targetStepId, targetSlots)
  }

  for (const node of workflowStepNodes) {
    const data = node.data as WorkflowStepData
    node.data = {
      ...data,
      sourceHandleSlots: getOrderedHandleSlots(
        sourceHandleSlotsByStepId.get(node.id),
      ),
      targetHandleSlots: getOrderedHandleSlots(
        targetHandleSlotsByStepId.get(node.id),
      ),
    }
  }

  // Track edge index per source for spreading multiple edges in the gap
  const sourceEdgeIndex = new Map<string, number>()

  const edges: Edge[] = workflowData.flows.map((flow) => {
    // Get edge index for spreading multiple edges from same source
    const edgeIdx = sourceEdgeIndex.get(flow.sourceStepId) ?? 0
    sourceEdgeIndex.set(flow.sourceStepId, edgeIdx + 1)

    // Get total outgoing edges from source for spreading
    const totalFromSource = outgoingEdgeCounts.get(flow.sourceStepId) ?? 1

    // Get column info for routing
    const sourceColumn = stepColumnMap.get(flow.sourceStepId) ?? 1
    const targetColumn = stepColumnMap.get(flow.targetStepId) ?? 1
    const gapWidth = gapWidthByColumn.get(sourceColumn) ?? DEFAULT_STEP_GAP
    const sourceLaneId = stepLaneIdByStepId.get(flow.sourceStepId)
    const targetLaneId = stepLaneIdByStepId.get(flow.targetStepId)
    // Forward edges read best when they turn in the gap before the target step.
    // We compute that preceding gap for every edge, but only forward cross-lane
    // routes use it. `gapWidthByColumn` stores the gap after each column, so the
    // gap before `targetColumn` lives at `targetColumn - 1`.
    const targetPrecedingGapWidth =
      targetColumn > 1
        ? (gapWidthByColumn.get(targetColumn - 1) ?? DEFAULT_STEP_GAP)
        : DEFAULT_STEP_GAP
    const label = getFlowLabel(flow)

    return {
      id: flow.id,
      source: flow.sourceStepId,
      target: flow.targetStepId,
      sourceHandle: `source-${sourceHandleSlotByFlowId.get(flow.id) ?? "middle"}`,
      targetHandle: `target-${targetHandleSlotByFlowId.get(flow.id) ?? "middle"}`,
      type: "workflow",
      style: { strokeWidth: 2 },
      // Label priority: condition text > onError > else > schedule
      label,
      labelStyle: { fontSize: 11, fill: "#64748b" },
      labelBgStyle: { fill: "#f8fafc", stroke: "#e2e8f0" },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      // Custom data for edge routing
      data: {
        edgeIndex: edgeIdx,
        totalEdges: totalFromSource,
        sourceColumn,
        targetColumn,
        gapWidth,
        targetPrecedingGapWidth,
        labelMaxWidth:
          label && gapWidth > DEFAULT_STEP_GAP
            ? gapWidth - EDGE_LABEL_HORIZONTAL_MARGIN * 2
            : undefined,
        isCrossLane:
          sourceLaneId !== undefined &&
          targetLaneId !== undefined &&
          sourceLaneId !== targetLaneId,
        isOnError: flow.isOnError,
        isConditional: (!!flow.condition || flow.isElse) && !flow.schedule,
        isScheduled: !!flow.schedule && !flow.condition && !flow.isElse,
        isConditionalAndScheduled:
          (!!flow.condition || flow.isElse) && !!flow.schedule,
      },
    }
  })

  return { nodes, edges, phases }
}

/**
 * Apply measured layout to nodes.
 * Uses actual measured heights to:
 * 1. Set swimlane heights based on max column height (accounting for stacked steps)
 * 2. Vertically center single steps, or center stacked groups within their swimlanes
 *
 * @param nodes - Nodes with measured dimensions from React Flow
 * @returns Repositioned nodes with correct vertical centering
 */
export function applyMeasuredLayout(
  nodes: Node[],
): Array<Node<WorkflowStepData> | Node<WorkflowSwimlaneData>> {
  // Separate swimlanes and steps
  const swimlanes = nodes.filter((n) => n.type === "swimlane")
  const steps = nodes.filter((n) => n.type === "workflowStep")

  const getStepStackHeight = (stepsInCell: Node[]) => {
    const stepsHeight = stepsInCell.reduce(
      (height, step) => height + (step.measured?.height ?? 0),
      0,
    )

    return stepsInCell.length > 1
      ? stepsHeight + (stepsInCell.length - 1) * STACKED_STEP_GAP
      : stepsHeight
  }

  // Group steps by (roleId, branchTrack, column) to identify stacked steps while
  // keeping alternate branches on stable vertical tracks across columns.
  const stepsByRoleTrackAndColumn = new Map<string, StepCell>()

  for (const step of steps) {
    const data = step.data as WorkflowStepData
    const key = `${data.roleId}:${data.branchTrack}:${data.column}`
    const existing = stepsByRoleTrackAndColumn.get(key)
    if (existing) {
      existing.steps.push(step)
      continue
    }

    stepsByRoleTrackAndColumn.set(key, {
      roleId: data.roleId,
      track: data.branchTrack,
      column: data.column,
      steps: [step],
    })
  }

  // Calculate required height per branch track and swimlane.
  const trackHeightByRoleId = new Map<string, Map<number, number>>()

  for (const cell of stepsByRoleTrackAndColumn.values()) {
    const cellHeight = getStepStackHeight(cell.steps)
    const trackHeights = trackHeightByRoleId.get(cell.roleId) ?? new Map()
    const currentTrackHeight = trackHeights.get(cell.track) ?? 0
    if (cellHeight > currentTrackHeight) {
      trackHeights.set(cell.track, cellHeight)
    }
    trackHeightByRoleId.set(cell.roleId, trackHeights)
  }

  // Calculate new swimlane positions and heights
  const swimlaneInfo = new Map<
    string,
    {
      y: number
      height: number
      roleId: string
      trackLayouts: Map<number, { y: number; height: number }>
    }
  >()
  let currentY = 0

  // Sort swimlanes by their current Y position to maintain order
  const sortedSwimlanes = [...swimlanes].sort(
    (a, b) => a.position.y - b.position.y,
  )

  for (const swimlane of sortedSwimlanes) {
    const roleId = (swimlane.data as WorkflowSwimlaneData).roleId
    const trackHeights = trackHeightByRoleId.get(roleId) ?? new Map([[0, 0]])
    const sortedTrackHeights = [...trackHeights.entries()].sort(
      ([trackA], [trackB]) => trackA - trackB,
    )
    const totalTrackHeight = sortedTrackHeights.reduce(
      (height, [, trackHeight]) => height + trackHeight,
      0,
    )
    const trackGapHeight =
      sortedTrackHeights.length > 1
        ? (sortedTrackHeights.length - 1) * BRANCH_TRACK_GAP
        : 0
    const branchTracksHeight = totalTrackHeight + trackGapHeight
    const swimlaneHeight = Math.max(
      INITIAL_SWIMLANE_HEIGHT,
      branchTracksHeight + SWIMLANE_PADDING * 2,
    )
    const trackLayouts = new Map<number, { y: number; height: number }>()
    let currentTrackY = currentY + (swimlaneHeight - branchTracksHeight) / 2

    for (const [track, trackHeight] of sortedTrackHeights) {
      trackLayouts.set(track, { y: currentTrackY, height: trackHeight })
      currentTrackY += trackHeight + BRANCH_TRACK_GAP
    }

    swimlaneInfo.set(swimlane.id, {
      y: currentY,
      height: swimlaneHeight,
      roleId,
      trackLayouts,
    })

    currentY += swimlaneHeight + SWIMLANE_VERTICAL_GAP
  }

  // Build new nodes array with updated positions
  const newNodes: Array<Node<WorkflowStepData> | Node<WorkflowSwimlaneData>> =
    []

  // Update swimlanes with new heights and positions
  for (const swimlane of swimlanes) {
    const info = swimlaneInfo.get(swimlane.id)
    if (!info) continue

    const newSwimlane: Node<WorkflowSwimlaneData> = {
      ...swimlane,
      position: { ...swimlane.position, y: info.y },
      data: {
        ...(swimlane.data as WorkflowSwimlaneData),
        height: info.height,
      },
    }
    newNodes.push(newSwimlane)
  }

  // Update steps with proper vertical positions.
  for (const cell of stepsByRoleTrackAndColumn.values()) {
    const swimlaneId = `swimlane-${cell.roleId}`
    const info = swimlaneInfo.get(swimlaneId)
    if (!info) continue
    const trackLayout = info.trackLayouts.get(cell.track)
    if (!trackLayout) continue

    if (cell.steps.length === 1) {
      // Single step: center it vertically
      const step = cell.steps[0]
      if (!step) continue

      const stepHeight = step.measured?.height ?? 0
      const centeredY = trackLayout.y + (trackLayout.height - stepHeight) / 2

      const newStep: Node<WorkflowStepData> = {
        ...step,
        position: { ...step.position, y: centeredY },
        data: step.data as WorkflowStepData,
      }
      newNodes.push(newStep)
    } else {
      // Multiple steps: stack them vertically, centered as a group
      const totalStackHeight = getStepStackHeight(cell.steps)

      // Calculate starting Y to center the stack within its branch track
      const stackStartY =
        trackLayout.y + (trackLayout.height - totalStackHeight) / 2

      // Position each step in the stack
      let currentStepY = stackStartY
      for (const step of cell.steps) {
        const stepHeight = step.measured?.height ?? 0

        const newStep: Node<WorkflowStepData> = {
          ...step,
          position: { ...step.position, y: currentStepY },
          data: step.data as WorkflowStepData,
        }
        newNodes.push(newStep)

        currentStepY += stepHeight + STACKED_STEP_GAP
      }
    }
  }

  return newNodes
}
