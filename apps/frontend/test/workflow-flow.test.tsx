import type { NodeChange, ReactFlowProps } from "@xyflow/react"
import * as ReactFlowModule from "@xyflow/react"
import { JSDOM } from "jsdom"
import { StrictMode, act } from "react"
import { createRoot } from "react-dom/client"
import type { ProcessWorkflowQuery } from "../lib/generated/gql/graphql"
import { createInitialLayout } from "../lib/workflow/layout"
import { expect, mock, test } from "bun:test"

type WorkflowData = NonNullable<ProcessWorkflowQuery["processWorkflow"]>

let flowProps: ReactFlowProps = {}

// Substitute the canvas/ResizeObserver boundary, retaining React Flow's real
// provider, hooks and node-change handling and the mounted workflow component.
mock.module("@xyflow/react", () => ({
  ...ReactFlowModule,
  ReactFlow: (props: ReactFlowProps) => {
    flowProps = props
    return null
  },
}))
mock.module("../components/theme-provider", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}))
mock.module(
  "../app/(protected)/processes/workflow/[...processPath]/use-workflow-auto-refresh",
  () => ({
    useWorkflowAutoRefresh: (_path: string, workflowData: WorkflowData) => ({
      workflowData,
      refreshCount: 0,
    }),
  }),
)
mock.module(
  "../app/(protected)/processes/workflow/[...processPath]/workflow-form-preview-sheet",
  () => ({ WorkflowFormPreviewSheet: () => null }),
)

const { WorkflowFlow } = await import(
  "../app/(protected)/processes/workflow/[...processPath]/workflow-flow"
)

const workflow: WorkflowData = {
  processId: "process",
  processName: "Branching workflow",
  processPath: "branching",
  processPurpose: "Test sibling step layout",
  steps: ["source", "upper", "lower", "other-lane"].map((id, index) => ({
    id,
    name: id,
    path: `branching/${id}`,
    purpose: "Test step",
    processId: "process",
    role: {
      id: index === 3 ? "reviewer" : "owner",
      name: index === 3 ? "Reviewer" : "Owner",
      path: index === 3 ? "reviewer" : "owner",
    },
    phase: null,
    isStartStep: index === 0,
    isEmbedded: false,
    column: index === 0 ? 1 : index === 3 ? 3 : 2,
  })),
  flows: ["upper", "lower"].map((targetStepId) => ({
    id: `flow-${targetStepId}`,
    sourceStepId: "source",
    targetStepId,
    condition: null,
    isElse: false,
    isOnError: false,
    taggedErrors: null,
    schedule: null,
  })),
  responsibilities: [],
}

function getNode(id: string) {
  const node = flowProps.nodes?.find((node) => node.id === id)
  if (!node) throw new Error(`Missing node ${id}`)
  return node
}

async function measureSteps(height: number) {
  const onNodesChange = flowProps.onNodesChange
  if (!onNodesChange) throw new Error("Missing measurement handler")
  const measurements: NodeChange[] = workflow.steps.map(({ id }) => ({
    id,
    type: "dimensions",
    dimensions: { width: 280, height },
  }))
  await act(async () => {
    // Queue an update before measurements so Strict Mode replays the updater
    // during render instead of using React's eager state-update optimization.
    onNodesChange([{ id: "source", type: "select", selected: true }])
    onNodesChange(measurements)
  })
}

test("Strict Mode measurements separate sibling cards, grow lanes, and relayout refreshed workflows", async () => {
  const dom = new JSDOM("", { url: "https://dashboard.example.test" })
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  }
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback)
      return frameId
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  })
  const container = document.createElement("div")
  const root = createRoot(container)
  try {
    for (const height of [215, 275]) {
      const { nodes, edges } = createInitialLayout(workflow)
      await act(async () => {
        root.render(
          <StrictMode>
            <WorkflowFlow
              initialWorkflowData={workflow}
              initialNodes={nodes}
              edges={edges}
              processPath={workflow.processPath}
            />
          </StrictMode>,
        )
      })
      await measureSteps(height)

      const upper = getNode("upper")
      const lower = getNode("lower")
      const lane = getNode("swimlane-owner")
      expect(upper.position.x).toBe(lower.position.x)
      expect(lower.position.y).toBeGreaterThan(upper.position.y + height)
      expect(lane.data.height).toBeGreaterThan(height * 2)
      expect(lower.position.y + height).toBeLessThan(Number(lane.data.height))
      expect(getNode("swimlane-reviewer").position.y).toBeGreaterThan(
        Number(lane.data.height),
      )

      await act(async () => {
        const pendingFrames = [...frames.values()]
        frames.clear()
        for (const callback of pendingFrames) callback(0)
      })
      const section = container.querySelector("section")
      expect(Number.parseFloat(section?.style.height ?? "0")).toBeGreaterThan(
        getNode("swimlane-reviewer").position.y + height,
      )

      // Repeated measurements and selection updates retain the committed layout.
      await measureSteps(height)
      expect(getNode("lower").position).toEqual(lower.position)
      expect(getNode("swimlane-owner").data.height).toBe(lane.data.height)
      expect(frames.size).toBe(0)
    }
  } finally {
    await act(async () => root.unmount())
    Object.assign(globalThis, previous)
    dom.window.close()
  }
})
