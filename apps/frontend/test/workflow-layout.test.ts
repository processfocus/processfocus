import { describe, expect, test } from "vitest"
import type { ProcessWorkflowQuery } from "../lib/generated/gql/graphql"
import { ROLE_LABEL_WIDTH } from "../lib/workflow/constants"
import {
  BRANCH_TRACK_GAP,
  DEFAULT_STEP_GAP,
  applyMeasuredLayout,
  createInitialLayout,
} from "../lib/workflow/layout"
import type {
  WorkflowStepData,
  WorkflowSwimlaneData,
} from "../lib/workflow/types"

type WorkflowData = NonNullable<ProcessWorkflowQuery["processWorkflow"]>
const MEASURED_STEP_HEIGHT = 80

/**
 * Helper to create minimal workflow data for testing swimlane ordering
 */
function createWorkflowData(
  roles: Array<{ id: string; name: string }>,
  responsibilities: Array<{
    roleId: string
    responsibility: string
    order: number | null
  }>,
): WorkflowData {
  return {
    processId: "process-1",
    processName: "Test Process",
    processPath: "test/process",
    processPurpose: "Testing",
    steps: roles.map((role, index) => ({
      id: `step-${index + 1}`,
      name: `Step ${index + 1}`,
      path: `test/process/step-${index + 1}`,
      purpose: "Test step",
      processId: "process-1",
      role: { id: role.id, name: role.name, path: `roles/${role.name}` },
      phase: null,
      isStartStep: index === 0,
      isEmbedded: false,
      column: index + 1,
    })),
    flows: [],
    responsibilities: responsibilities.map((r) => ({
      roleId: r.roleId,
      roleName: roles.find((role) => role.id === r.roleId)?.name ?? "Unknown",
      rolePath: `roles/${r.roleId}`,
      responsibility: r.responsibility,
      order: r.order,
    })),
  }
}

/**
 * Extract swimlane role IDs in their visual order from layout result
 */
function getSwimlaneOrder(workflowData: WorkflowData): string[] {
  const { nodes } = createInitialLayout(workflowData)
  return nodes
    .filter((n) => n.type === "swimlane")
    .sort((a, b) => a.position.y - b.position.y)
    .map((n) => (n.data as WorkflowSwimlaneData).roleId)
}

function getStepXPositions(workflowData: WorkflowData): Record<string, number> {
  const { nodes } = createInitialLayout(workflowData)
  return Object.fromEntries(
    nodes
      .filter((node) => node.type === "workflowStep")
      .map((node) => [node.id, node.position.x]),
  )
}

function getSwimlaneWidths(workflowData: WorkflowData): Record<string, number> {
  const { nodes } = createInitialLayout(workflowData)
  return Object.fromEntries(
    nodes
      .filter((node) => node.type === "swimlane")
      .map((node) => [node.id, (node.data as WorkflowSwimlaneData).width]),
  )
}

function getMeasuredStepYPositions(
  workflowData: WorkflowData,
): Record<string, number> {
  const { nodes } = createInitialLayout(workflowData)
  const measuredNodes = nodes.map((node) =>
    node.type === "workflowStep"
      ? { ...node, measured: { width: 280, height: MEASURED_STEP_HEIGHT } }
      : node,
  )
  return Object.fromEntries(
    applyMeasuredLayout(measuredNodes)
      .filter((node) => node.type === "workflowStep")
      .map((node) => [node.id, node.position.y]),
  )
}

function getWorkflowStepData(
  nodes: ReturnType<typeof createInitialLayout>["nodes"],
  stepId: string,
): WorkflowStepData | undefined {
  return nodes.find((node) => node.id === stepId)?.data as
    | WorkflowStepData
    | undefined
}

describe("createInitialLayout swimlane ordering", () => {
  test("orders swimlanes by responsibility order when all have order", () => {
    const roles = [
      { id: "role-a", name: "Role A" },
      { id: "role-b", name: "Role B" },
      { id: "role-c", name: "Role C" },
    ]
    const responsibilities = [
      { roleId: "role-a", responsibility: "Does A", order: 3 },
      { roleId: "role-b", responsibility: "Does B", order: 1 },
      { roleId: "role-c", responsibility: "Does C", order: 2 },
    ]

    const order = getSwimlaneOrder(createWorkflowData(roles, responsibilities))

    expect(order).toEqual(["role-b", "role-c", "role-a"])
  })

  test("orders swimlanes with null order after those with order", () => {
    const roles = [
      { id: "role-a", name: "Role A" },
      { id: "role-b", name: "Role B" },
      { id: "role-c", name: "Role C" },
    ]
    const responsibilities = [
      { roleId: "role-a", responsibility: "Does A", order: null },
      { roleId: "role-b", responsibility: "Does B", order: 1 },
      { roleId: "role-c", responsibility: "Does C", order: null },
    ]

    const order = getSwimlaneOrder(createWorkflowData(roles, responsibilities))

    // role-b has order 1, so it comes first
    // role-a and role-c have no order, they come after in encounter order
    expect(order[0]).toBe("role-b")
    expect(order.slice(1)).toEqual(expect.arrayContaining(["role-a", "role-c"]))
  })

  test("maintains encounter order when no responsibilities have order", () => {
    const roles = [
      { id: "role-a", name: "Role A" },
      { id: "role-b", name: "Role B" },
      { id: "role-c", name: "Role C" },
    ]
    const responsibilities = [
      { roleId: "role-a", responsibility: "Does A", order: null },
      { roleId: "role-b", responsibility: "Does B", order: null },
      { roleId: "role-c", responsibility: "Does C", order: null },
    ]

    const order = getSwimlaneOrder(createWorkflowData(roles, responsibilities))

    // Without explicit order, swimlanes appear in the order roles are encountered in steps
    expect(order).toEqual(["role-a", "role-b", "role-c"])
  })

  test("handles roles without any responsibility entry", () => {
    const roles = [
      { id: "role-a", name: "Role A" },
      { id: "role-b", name: "Role B" },
      { id: "role-c", name: "Role C" },
    ]
    // Only role-b has a responsibility defined
    const responsibilities = [
      { roleId: "role-b", responsibility: "Does B", order: 1 },
    ]

    const order = getSwimlaneOrder(createWorkflowData(roles, responsibilities))

    // role-b has order, so it comes first
    // role-a and role-c have no responsibility entry, they come after
    expect(order[0]).toBe("role-b")
  })

  test("handles empty workflow", () => {
    const workflowData: WorkflowData = {
      processId: "process-1",
      processName: "Empty Process",
      processPath: "test/empty",
      processPurpose: "Testing",
      steps: [],
      flows: [],
      responsibilities: [],
    }

    const { nodes } = createInitialLayout(workflowData)

    expect(nodes).toEqual([])
  })

  test("orders correctly with mixed order values", () => {
    const roles = [
      { id: "role-a", name: "Role A" },
      { id: "role-b", name: "Role B" },
      { id: "role-c", name: "Role C" },
      { id: "role-d", name: "Role D" },
    ]
    const responsibilities = [
      { roleId: "role-a", responsibility: "Does A", order: 10 },
      { roleId: "role-b", responsibility: "Does B", order: null },
      { roleId: "role-c", responsibility: "Does C", order: 5 },
      { roleId: "role-d", responsibility: "Does D", order: 1 },
    ]

    const order = getSwimlaneOrder(createWorkflowData(roles, responsibilities))

    // Ordered roles first: role-d (1), role-c (5), role-a (10)
    // Then unordered: role-b
    expect(order).toEqual(["role-d", "role-c", "role-a", "role-b"])
  })

  test("creates a separate anonymous swimlane for embedded start steps", () => {
    const workflowData: WorkflowData = {
      processId: "process-1",
      processName: "Embedded Start Process",
      processPath: "test/embedded-start",
      processPurpose: "Testing",
      steps: [
        {
          id: "step-start",
          name: "Submit enquiry",
          path: "test/embedded-start/submit-enquiry",
          purpose: "Start the process",
          processId: "process-1",
          role: { id: "office", name: "Office Staff", path: "roles/office" },
          phase: null,
          isStartStep: true,
          isEmbedded: true,
          column: 1,
        },
        {
          id: "step-follow-up",
          name: "Contact parent",
          path: "test/embedded-start/contact-parent",
          purpose: "Continue the process",
          processId: "process-1",
          role: { id: "office", name: "Office Staff", path: "roles/office" },
          phase: null,
          isStartStep: false,
          isEmbedded: false,
          column: 2,
        },
      ],
      flows: [],
      responsibilities: [
        {
          roleId: "office",
          roleName: "Office Staff",
          rolePath: "roles/office",
          responsibility: "Manage enquiries",
          order: 1,
        },
      ],
    }

    const { nodes } = createInitialLayout(workflowData)
    const swimlaneNames = nodes
      .filter((node) => node.type === "swimlane")
      .sort((a, b) => a.position.y - b.position.y)
      .map((node) => (node.data as WorkflowSwimlaneData).roleName)

    expect(swimlaneNames).toEqual(["Anonymous / Office Staff", "Office Staff"])

    const startStep = nodes.find((node) => node.id === "step-start")
    expect((startStep?.data as WorkflowStepData | undefined)?.roleName).toBe(
      "Anonymous / Office Staff",
    )

    const followUpStep = nodes.find((node) => node.id === "step-follow-up")
    expect((followUpStep?.data as WorkflowStepData | undefined)?.roleName).toBe(
      "Office Staff",
    )
  })

  test("widens the column gap when an edge label needs room", () => {
    const workflowData: WorkflowData = {
      processId: "process-1",
      processName: "Labeled Gap Process",
      processPath: "test/labeled-gap",
      processPurpose: "Testing",
      steps: [
        {
          id: "step-1",
          name: "Step 1",
          path: "test/labeled-gap/step-1",
          purpose: "Start",
          processId: "process-1",
          role: { id: "role-a", name: "Role A", path: "roles/role-a" },
          phase: null,
          isStartStep: true,
          isEmbedded: false,
          column: 1,
        },
        {
          id: "step-2",
          name: "Step 2",
          path: "test/labeled-gap/step-2",
          purpose: "Next",
          processId: "process-1",
          role: { id: "role-a", name: "Role A", path: "roles/role-a" },
          phase: null,
          isStartStep: false,
          isEmbedded: false,
          column: 2,
        },
      ],
      flows: [
        {
          id: "flow-1",
          sourceStepId: "step-1",
          targetStepId: "step-2",
          condition: "Google Calendar lookup enabled",
          isElse: false,
          isOnError: false,
          taggedErrors: null,
          schedule: null,
        },
      ],
      responsibilities: [
        {
          roleId: "role-a",
          roleName: "Role A",
          rolePath: "roles/role-a",
          responsibility: "Does A",
          order: 1,
        },
      ],
    }

    const { edges } = createInitialLayout(workflowData)
    const positions = getStepXPositions(workflowData)
    const edgeData = edges[0]?.data as
      | { gapWidth?: number; labelMaxWidth?: number }
      | undefined

    expect(edgeData?.gapWidth).toBeGreaterThan(80)
    expect(edgeData?.labelMaxWidth).toBeGreaterThan(80)
    expect(positions["step-2"] - positions["step-1"]).toBeGreaterThan(360)
  })

  test("keeps the default column gap for short labels", () => {
    const unlabeledWorkflowData: WorkflowData = {
      processId: "process-1",
      processName: "Default Gap Process",
      processPath: "test/default-gap",
      processPurpose: "Testing",
      steps: [
        {
          id: "step-1",
          name: "Step 1",
          path: "test/default-gap/step-1",
          purpose: "Start",
          processId: "process-1",
          role: { id: "role-a", name: "Role A", path: "roles/role-a" },
          phase: null,
          isStartStep: true,
          isEmbedded: false,
          column: 1,
        },
        {
          id: "step-2",
          name: "Step 2",
          path: "test/default-gap/step-2",
          purpose: "Next",
          processId: "process-1",
          role: { id: "role-a", name: "Role A", path: "roles/role-a" },
          phase: null,
          isStartStep: false,
          isEmbedded: false,
          column: 2,
        },
      ],
      flows: [],
      responsibilities: [
        {
          roleId: "role-a",
          roleName: "Role A",
          rolePath: "roles/role-a",
          responsibility: "Does A",
          order: 1,
        },
      ],
    }

    const shortLabelWorkflowData: WorkflowData = {
      ...unlabeledWorkflowData,
      flows: [
        {
          id: "flow-1",
          sourceStepId: "step-1",
          targetStepId: "step-2",
          condition: null,
          isElse: true,
          isOnError: false,
          taggedErrors: null,
          schedule: null,
        },
      ],
    }

    const unlabeledPositions = getStepXPositions(unlabeledWorkflowData)
    const shortLabelPositions = getStepXPositions(shortLabelWorkflowData)
    const { edges } = createInitialLayout(shortLabelWorkflowData)
    const edgeData = edges[0]?.data as
      | { gapWidth?: number; labelMaxWidth?: number }
      | undefined

    expect(shortLabelPositions).toEqual(unlabeledPositions)
    expect(edgeData?.gapWidth).toBe(80)
    expect(edgeData?.labelMaxWidth).toBeUndefined()
  })

  test("keeps swimlane width scoped to the steps area", () => {
    const workflowData = createWorkflowData(
      [
        // Reuse the same role id so both steps render in one swimlane.
        { id: "role-a", name: "Role A" },
        { id: "role-a", name: "Role A" },
      ],
      [{ roleId: "role-a", responsibility: "Does A", order: 1 }],
    )

    const positions = getStepXPositions(workflowData)
    const widths = getSwimlaneWidths(workflowData)
    // Infer the fixed step width from column spacing so the test doesn't need
    // layout internals beyond the exported default gap.
    const inferredStepWidth =
      positions["step-2"] - positions["step-1"] - DEFAULT_STEP_GAP
    const expectedStepsAreaWidth =
      positions["step-2"] +
      inferredStepWidth +
      DEFAULT_STEP_GAP -
      ROLE_LABEL_WIDTH

    expect(widths["swimlane-role-a"]).toBe(expectedStepsAreaWidth)
  })

  test("keeps a cross-lane flow line clear of unrelated same-lane steps", () => {
    const workflowData: WorkflowData = {
      processId: "process-1",
      processName: "Branch Track Process",
      processPath: "test/branch-track",
      processPurpose: "Testing",
      steps: [
        {
          id: "send-initial-response",
          name: "Send initial response",
          path: "test/branch-track/send-initial-response",
          purpose: "Reply to the parent",
          processId: "process-1",
          role: null,
          phase: null,
          isStartStep: false,
          isEmbedded: false,
          column: 1,
        },
        {
          id: "parent-books-tour",
          name: "Parent books school tour",
          path: "test/branch-track/parent-books-tour",
          purpose: "Parent selects a tour slot",
          processId: "process-1",
          role: { id: "office", name: "Office Staff", path: "roles/office" },
          phase: null,
          isStartStep: false,
          isEmbedded: false,
          column: 1,
        },
        {
          id: "book-selected-slot",
          name: "Book selected school tour slot",
          path: "test/branch-track/book-selected-slot",
          purpose: "Book the calendar slot",
          processId: "process-1",
          role: null,
          phase: null,
          isStartStep: false,
          isEmbedded: false,
          column: 2,
        },
        {
          id: "contact-parent",
          name: "Contact parent to book a tour",
          path: "test/branch-track/contact-parent",
          purpose: "Contact the parent manually",
          processId: "process-1",
          role: { id: "office", name: "Office Staff", path: "roles/office" },
          phase: null,
          isStartStep: false,
          isEmbedded: false,
          column: 3,
        },
      ],
      flows: [
        {
          id: "flow-parent-books-to-calendar-booking",
          sourceStepId: "parent-books-tour",
          targetStepId: "book-selected-slot",
          condition: null,
          isElse: false,
          isOnError: false,
          taggedErrors: null,
          schedule: null,
        },
        {
          id: "flow-initial-response-to-contact-parent",
          sourceStepId: "send-initial-response",
          targetStepId: "contact-parent",
          condition: null,
          isElse: false,
          isOnError: false,
          taggedErrors: null,
          schedule: null,
        },
      ],
      responsibilities: [
        {
          roleId: "office",
          roleName: "Office Staff",
          rolePath: "roles/office",
          responsibility: "Manage enquiries",
          order: 1,
        },
      ],
    }

    const stepY = getMeasuredStepYPositions(workflowData)
    const sendInitialResponseY = stepY["send-initial-response"]
    const bookSelectedSlotY = stepY["book-selected-slot"]

    expect(sendInitialResponseY).toBeDefined()
    expect(bookSelectedSlotY).toBeDefined()
    if (sendInitialResponseY === undefined || bookSelectedSlotY === undefined) {
      return
    }

    expect(sendInitialResponseY).toBeGreaterThanOrEqual(
      bookSelectedSlotY + MEASURED_STEP_HEIGHT + BRANCH_TRACK_GAP,
    )
  })

  test("widens the column gap for long tagged onError labels", () => {
    const workflowData: WorkflowData = {
      processId: "process-1",
      processName: "onError Gap Process",
      processPath: "test/onerror-gap",
      processPurpose: "Testing",
      steps: [
        {
          id: "step-1",
          name: "Step 1",
          path: "test/onerror-gap/step-1",
          purpose: "Start",
          processId: "process-1",
          role: { id: "role-a", name: "Role A", path: "roles/role-a" },
          phase: null,
          isStartStep: true,
          isEmbedded: false,
          column: 1,
        },
        {
          id: "step-2",
          name: "Step 2",
          path: "test/onerror-gap/step-2",
          purpose: "Fallback",
          processId: "process-1",
          role: { id: "role-a", name: "Role A", path: "roles/role-a" },
          phase: null,
          isStartStep: false,
          isEmbedded: false,
          column: 2,
        },
      ],
      flows: [
        {
          id: "flow-1",
          sourceStepId: "step-1",
          targetStepId: "step-2",
          condition: null,
          isElse: false,
          isOnError: true,
          taggedErrors: ["ValidationError", "TimeoutException", "NetworkError"],
          schedule: null,
        },
      ],
      responsibilities: [
        {
          roleId: "role-a",
          roleName: "Role A",
          rolePath: "roles/role-a",
          responsibility: "Does A",
          order: 1,
        },
      ],
    }

    const { edges } = createInitialLayout(workflowData)
    const positions = getStepXPositions(workflowData)
    const edgeData = edges[0]?.data as
      | { gapWidth?: number; labelMaxWidth?: number }
      | undefined

    expect(edges[0]?.label).toBe(
      "onError(ValidationError, TimeoutException, NetworkError)",
    )
    expect(edgeData?.gapWidth).toBeGreaterThan(80)
    expect(edgeData?.labelMaxWidth).toBeGreaterThan(80)
    expect(positions["step-2"] - positions["step-1"]).toBeGreaterThan(360)
  })

  test("separates two outgoing flow line anchors by direction", () => {
    const workflowData: WorkflowData = {
      processId: "process-1",
      processName: "Anchor Process",
      processPath: "test/anchor-process",
      processPurpose: "Testing",
      steps: [
        {
          id: "top-target",
          name: "Top Target",
          path: "test/anchor-process/top-target",
          purpose: "Target above",
          processId: "process-1",
          role: { id: "top", name: "Top Role", path: "roles/top" },
          phase: null,
          isStartStep: false,
          isEmbedded: false,
          column: 2,
        },
        {
          id: "source",
          name: "Source",
          path: "test/anchor-process/source",
          purpose: "Splits upward and downward",
          processId: "process-1",
          role: { id: "middle", name: "Middle Role", path: "roles/middle" },
          phase: null,
          isStartStep: true,
          isEmbedded: false,
          column: 1,
        },
        {
          id: "bottom-target",
          name: "Bottom Target",
          path: "test/anchor-process/bottom-target",
          purpose: "Target below",
          processId: "process-1",
          role: { id: "bottom", name: "Bottom Role", path: "roles/bottom" },
          phase: null,
          isStartStep: false,
          isEmbedded: false,
          column: 2,
        },
      ],
      flows: [
        {
          id: "flow-up",
          sourceStepId: "source",
          targetStepId: "top-target",
          condition: null,
          isElse: false,
          isOnError: false,
          taggedErrors: null,
          schedule: null,
        },
        {
          id: "flow-down",
          sourceStepId: "source",
          targetStepId: "bottom-target",
          condition: null,
          isElse: false,
          isOnError: false,
          taggedErrors: null,
          schedule: null,
        },
      ],
      responsibilities: [
        {
          roleId: "top",
          roleName: "Top Role",
          rolePath: "roles/top",
          responsibility: "Top work",
          order: 1,
        },
        {
          roleId: "middle",
          roleName: "Middle Role",
          rolePath: "roles/middle",
          responsibility: "Middle work",
          order: 2,
        },
        {
          roleId: "bottom",
          roleName: "Bottom Role",
          rolePath: "roles/bottom",
          responsibility: "Bottom work",
          order: 3,
        },
      ],
    }

    const { edges, nodes } = createInitialLayout(workflowData)
    const sourceData = getWorkflowStepData(nodes, "source")
    const topTargetData = getWorkflowStepData(nodes, "top-target")
    const bottomTargetData = getWorkflowStepData(nodes, "bottom-target")

    expect(sourceData?.sourceHandleSlots).toEqual(["top", "bottom"])
    expect(topTargetData?.targetHandleSlots).toEqual(["middle"])
    expect(bottomTargetData?.targetHandleSlots).toEqual(["middle"])
    expect(edges.find((edge) => edge.id === "flow-up")?.sourceHandle).toBe(
      "source-top",
    )
    expect(edges.find((edge) => edge.id === "flow-up")?.targetHandle).toBe(
      "target-middle",
    )
    expect(edges.find((edge) => edge.id === "flow-down")?.sourceHandle).toBe(
      "source-bottom",
    )
    expect(edges.find((edge) => edge.id === "flow-down")?.targetHandle).toBe(
      "target-middle",
    )
  })

  test("allows straight sibling flow lines to share centred anchors", () => {
    // Use one role so both sibling flows are genuinely straight centre-to-centre lines.
    const workflowData = createWorkflowData(
      [
        { id: "role-a", name: "Role A" },
        { id: "role-a", name: "Role A" },
      ],
      [{ roleId: "role-a", responsibility: "Does A", order: 1 }],
    )
    workflowData.flows = [
      {
        id: "flow-straight-a",
        sourceStepId: "step-1",
        targetStepId: "step-2",
        condition: "First straight branch",
        isElse: false,
        isOnError: false,
        taggedErrors: null,
        schedule: null,
      },
      {
        id: "flow-straight-b",
        sourceStepId: "step-1",
        targetStepId: "step-2",
        condition: "Second straight branch",
        isElse: false,
        isOnError: false,
        taggedErrors: null,
        schedule: null,
      },
    ]

    const { edges, nodes } = createInitialLayout(workflowData)
    const sourceData = getWorkflowStepData(nodes, "step-1")
    const targetData = getWorkflowStepData(nodes, "step-2")

    expect(sourceData?.sourceHandleSlots).toEqual(["middle"])
    expect(targetData?.targetHandleSlots).toEqual(["middle"])
    expect(edges.map((edge) => edge.sourceHandle)).toEqual([
      "source-middle",
      "source-middle",
    ])
    expect(edges.map((edge) => edge.targetHandle)).toEqual([
      "target-middle",
      "target-middle",
    ])
  })

  test("prefers up and down anchors when more than three flow lines share a side", () => {
    const workflowData = createWorkflowData(
      [
        { id: "role-top-a", name: "Top A" },
        { id: "role-top-b", name: "Top B" },
        { id: "role-source", name: "Source Role" },
        { id: "role-bottom-a", name: "Bottom A" },
        { id: "role-bottom-b", name: "Bottom B" },
      ],
      [
        { roleId: "role-top-a", responsibility: "Top A", order: 1 },
        { roleId: "role-top-b", responsibility: "Top B", order: 2 },
        { roleId: "role-source", responsibility: "Source", order: 3 },
        { roleId: "role-bottom-a", responsibility: "Bottom A", order: 4 },
        { roleId: "role-bottom-b", responsibility: "Bottom B", order: 5 },
      ],
    )
    workflowData.steps = workflowData.steps.map((step) =>
      step.id === "step-3" ? { ...step, column: 1 } : { ...step, column: 2 },
    )
    workflowData.flows = ["step-1", "step-2", "step-4", "step-5"].map(
      (targetStepId) => ({
        id: `flow-to-${targetStepId}`,
        sourceStepId: "step-3",
        targetStepId,
        condition: null,
        isElse: false,
        isOnError: false,
        taggedErrors: null,
        schedule: null,
      }),
    )

    const { edges, nodes } = createInitialLayout(workflowData)
    const sourceData = getWorkflowStepData(nodes, "step-3")

    expect(sourceData?.sourceHandleSlots).toEqual(["top", "bottom"])
    expect(
      edges.filter((edge) => edge.sourceHandle === "source-top"),
    ).toHaveLength(2)
    expect(
      edges.filter((edge) => edge.sourceHandle === "source-bottom"),
    ).toHaveLength(2)
  })

  test("uses all three anchors for mixed upward, straight, and downward flow lines", () => {
    const workflowData: WorkflowData = {
      processId: "process-1",
      processName: "Mixed Anchor Process",
      processPath: "test/mixed-anchor-process",
      processPurpose: "Testing",
      steps: [
        {
          id: "top-target",
          name: "Top Target",
          path: "test/mixed-anchor-process/top-target",
          purpose: "Target above",
          processId: "process-1",
          role: { id: "top", name: "Top Role", path: "roles/top" },
          phase: null,
          isStartStep: false,
          isEmbedded: false,
          column: 2,
        },
        {
          id: "source",
          name: "Source",
          path: "test/mixed-anchor-process/source",
          purpose: "Splits upward, straight, and downward",
          processId: "process-1",
          role: { id: "middle", name: "Middle Role", path: "roles/middle" },
          phase: null,
          isStartStep: true,
          isEmbedded: false,
          column: 1,
        },
        {
          id: "straight-target",
          name: "Straight Target",
          path: "test/mixed-anchor-process/straight-target",
          purpose: "Target in the same row",
          processId: "process-1",
          role: { id: "middle", name: "Middle Role", path: "roles/middle" },
          phase: null,
          isStartStep: false,
          isEmbedded: false,
          column: 2,
        },
        {
          id: "bottom-target",
          name: "Bottom Target",
          path: "test/mixed-anchor-process/bottom-target",
          purpose: "Target below",
          processId: "process-1",
          role: { id: "bottom", name: "Bottom Role", path: "roles/bottom" },
          phase: null,
          isStartStep: false,
          isEmbedded: false,
          column: 2,
        },
      ],
      flows: [
        {
          id: "flow-up",
          sourceStepId: "source",
          targetStepId: "top-target",
          condition: null,
          isElse: false,
          isOnError: false,
          taggedErrors: null,
          schedule: null,
        },
        {
          id: "flow-straight",
          sourceStepId: "source",
          targetStepId: "straight-target",
          condition: null,
          isElse: false,
          isOnError: false,
          taggedErrors: null,
          schedule: null,
        },
        {
          id: "flow-down",
          sourceStepId: "source",
          targetStepId: "bottom-target",
          condition: null,
          isElse: false,
          isOnError: false,
          taggedErrors: null,
          schedule: null,
        },
      ],
      responsibilities: [
        {
          roleId: "top",
          roleName: "Top Role",
          rolePath: "roles/top",
          responsibility: "Top work",
          order: 1,
        },
        {
          roleId: "middle",
          roleName: "Middle Role",
          rolePath: "roles/middle",
          responsibility: "Middle work",
          order: 2,
        },
        {
          roleId: "bottom",
          roleName: "Bottom Role",
          rolePath: "roles/bottom",
          responsibility: "Bottom work",
          order: 3,
        },
      ],
    }

    const { edges, nodes } = createInitialLayout(workflowData)
    const sourceData = getWorkflowStepData(nodes, "source")

    expect(sourceData?.sourceHandleSlots).toEqual(["top", "middle", "bottom"])
    expect(edges.find((edge) => edge.id === "flow-up")?.sourceHandle).toBe(
      "source-top",
    )
    expect(
      edges.find((edge) => edge.id === "flow-straight")?.sourceHandle,
    ).toBe("source-middle")
    expect(edges.find((edge) => edge.id === "flow-down")?.sourceHandle).toBe(
      "source-bottom",
    )
  })

  test("keeps straight flow line anchors centred", () => {
    // Use one role so the adjacent steps stay in the same swimlane and row.
    const workflowData = createWorkflowData(
      [
        { id: "role-a", name: "Role A" },
        { id: "role-a", name: "Role A" },
      ],
      [{ roleId: "role-a", responsibility: "Does A", order: 1 }],
    )
    workflowData.flows = [
      {
        id: "flow-straight",
        sourceStepId: "step-1",
        targetStepId: "step-2",
        condition: null,
        isElse: false,
        isOnError: false,
        taggedErrors: null,
        schedule: null,
      },
    ]

    const { edges, nodes } = createInitialLayout(workflowData)
    const sourceData = getWorkflowStepData(nodes, "step-1")
    const targetData = getWorkflowStepData(nodes, "step-2")

    expect(sourceData?.sourceHandleSlots).toEqual(["middle"])
    expect(targetData?.targetHandleSlots).toEqual(["middle"])
    expect(edges[0]?.sourceHandle).toBe("source-middle")
    expect(edges[0]?.targetHandle).toBe("target-middle")
  })

  test("does not render unused flow line anchors", () => {
    const workflowData = createWorkflowData(
      [
        { id: "role-a", name: "Role A" },
        { id: "role-a", name: "Role A" },
      ],
      [{ roleId: "role-a", responsibility: "Does A", order: 1 }],
    )
    workflowData.flows = [
      {
        id: "flow-1",
        sourceStepId: "step-1",
        targetStepId: "step-2",
        condition: null,
        isElse: false,
        isOnError: false,
        taggedErrors: null,
        schedule: null,
      },
    ]

    const { nodes } = createInitialLayout(workflowData)
    const sourceData = getWorkflowStepData(nodes, "step-1")
    const targetData = getWorkflowStepData(nodes, "step-2")

    expect(sourceData?.targetHandleSlots).toEqual([])
    expect(targetData?.sourceHandleSlots).toEqual([])
  })

  test("separates anchors for stacked same-cell targets", () => {
    const workflowData: WorkflowData = {
      processId: "process-1",
      processName: "Stacked Anchor Process",
      processPath: "test/stacked-anchor-process",
      processPurpose: "Testing",
      steps: [
        {
          id: "source",
          name: "Source",
          path: "test/stacked-anchor-process/source",
          purpose: "Splits to stacked targets",
          processId: "process-1",
          role: { id: "role-a", name: "Role A", path: "roles/role-a" },
          phase: null,
          isStartStep: true,
          isEmbedded: false,
          column: 1,
        },
        {
          id: "upper-target",
          name: "Upper Target",
          path: "test/stacked-anchor-process/upper-target",
          purpose: "First stacked target",
          processId: "process-1",
          role: { id: "role-a", name: "Role A", path: "roles/role-a" },
          phase: null,
          isStartStep: false,
          isEmbedded: false,
          column: 2,
        },
        {
          id: "lower-target",
          name: "Lower Target",
          path: "test/stacked-anchor-process/lower-target",
          purpose: "Second stacked target",
          processId: "process-1",
          role: { id: "role-a", name: "Role A", path: "roles/role-a" },
          phase: null,
          isStartStep: false,
          isEmbedded: false,
          column: 2,
        },
      ],
      flows: [
        {
          id: "flow-upper",
          sourceStepId: "source",
          targetStepId: "upper-target",
          condition: null,
          isElse: false,
          isOnError: false,
          taggedErrors: null,
          schedule: null,
        },
        {
          id: "flow-lower",
          sourceStepId: "source",
          targetStepId: "lower-target",
          condition: null,
          isElse: false,
          isOnError: false,
          taggedErrors: null,
          schedule: null,
        },
      ],
      responsibilities: [
        {
          roleId: "role-a",
          roleName: "Role A",
          rolePath: "roles/role-a",
          responsibility: "Does A",
          order: 1,
        },
      ],
    }

    const { edges, nodes } = createInitialLayout(workflowData)
    const sourceData = getWorkflowStepData(nodes, "source")

    expect(sourceData?.sourceHandleSlots).toEqual(["middle", "bottom"])
    expect(edges.find((edge) => edge.id === "flow-upper")?.sourceHandle).toBe(
      "source-middle",
    )
    expect(edges.find((edge) => edge.id === "flow-lower")?.sourceHandle).toBe(
      "source-bottom",
    )
  })
})
