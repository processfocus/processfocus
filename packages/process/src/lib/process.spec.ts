import { DateTime, Schema as ES, Effect } from "effect"
import { Form } from "./form"
import { NodeStep } from "./node_step"
import { OrgUnit } from "./org-unit"
import { Organisation } from "./organisation"
import type { EdgeAttributes } from "./process"
import { Process } from "./process"
import { Role } from "./role"
import { describe, expect, it } from "bun:test"

function createTestFixtures() {
  const organisation = new Organisation({ name: "Test Organisation" })
  const orgUnit = new OrgUnit(organisation, "test-unit", {
    name: "Test Unit",
    type: "department",
  })
  const mockRole = new Role(orgUnit, "mock", { name: "Mock Role" })
  return { organisation, orgUnit, mockRole }
}

describe("Process - validateFlows", () => {
  it("should detect a single dangling step (no .end() call)", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    // Missing .end() - step2 has no outgoing edge
    process.start(step1).next(step2)

    const result = process.validateFlows()
    expect(result.dangling).toEqual(["test-unit/process/step2"])
    expect(result.unreachable).toEqual([])
  })

  it("should pass when flow is properly terminated with .end()", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    process.start(step1).next(step2).end()

    const result = process.validateFlows()
    expect(result.dangling).toEqual([])
    expect(result.unreachable).toEqual([])
  })

  it("should pass when using .end(step) shorthand", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    process.start(step1).end(step2)

    const result = process.validateFlows()
    expect(result.dangling).toEqual([])
    expect(result.unreachable).toEqual([])
  })

  it("should detect multiple dangling steps in a branching flow", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2a = new Form(process, "step2a", {
      role: mockRole,
      form: () => ({}),
    })
    const step2b = new Form(process, "step2b", {
      role: mockRole,
      form: () => ({}),
    })

    // Both branches missing .end()
    const flow = process.start(step1)
    flow.next(step2a, { condition: { fn: () => true } })
    flow.next(step2b, { condition: { fn: () => false } })

    const result = process.validateFlows()
    expect(result.dangling).toHaveLength(2)
    expect(result.dangling).toContain("test-unit/process/step2a")
    expect(result.dangling).toContain("test-unit/process/step2b")
    expect(result.unreachable).toEqual([])
  })

  it("should pass when all branches are properly terminated", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2a = new Form(process, "step2a", {
      role: mockRole,
      form: () => ({}),
    })
    const step2b = new Form(process, "step2b", {
      role: mockRole,
      form: () => ({}),
    })

    const flow = process.start(step1)
    flow.next(step2a, { condition: { fn: () => true } }).end()
    flow.next(step2b, { condition: { fn: () => false } }).end()

    const result = process.validateFlows()
    expect(result.dangling).toEqual([])
    expect(result.unreachable).toEqual([])
  })

  it("should detect dangling step when only one branch is terminated", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2a = new Form(process, "step2a", {
      role: mockRole,
      form: () => ({}),
    })
    const step2b = new Form(process, "step2b", {
      role: mockRole,
      form: () => ({}),
    })

    const flow = process.start(step1)
    flow.next(step2a, { condition: { fn: () => true } }).end()
    flow.next(step2b, { condition: { fn: () => false } }) // Missing .end()

    const result = process.validateFlows()
    expect(result.dangling).toEqual(["test-unit/process/step2b"])
    expect(result.unreachable).toEqual([])
  })

  it("should detect dangling step in a diamond pattern", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2a = new Form(process, "step2a", {
      role: mockRole,
      form: () => ({}),
    })
    const step2b = new Form(process, "step2b", {
      role: mockRole,
      form: () => ({}),
    })
    const step3 = new Form(process, "step3", {
      role: mockRole,
      form: () => ({}),
    })

    // Diamond: step1 -> step2a -> step3
    //               \-> step2b -> step3
    // But step3 has no .end()
    const flow = process.start(step1)
    flow.next(step2a, { condition: { fn: () => true } }).next(step3)
    flow.next(step2b, { condition: { fn: () => false } }).next(step3)

    const result = process.validateFlows()
    expect(result.dangling).toEqual(["test-unit/process/step3"])
    expect(result.unreachable).toEqual([])
  })

  it("should pass for diamond pattern with proper termination", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2a = new Form(process, "step2a", {
      role: mockRole,
      form: () => ({}),
    })
    const step2b = new Form(process, "step2b", {
      role: mockRole,
      form: () => ({}),
    })
    const step3 = new Form(process, "step3", {
      role: mockRole,
      form: () => ({}),
    })

    // Diamond converging to step3, which is properly ended
    const flow = process.start(step1)
    flow
      .next(step2a, { condition: { fn: () => true } })
      .next(step3)
      .end()
    flow.next(step2b, { condition: { fn: () => false } }).next(step3)
    // step3 already has .end() from first branch

    const result = process.validateFlows()
    expect(result.dangling).toEqual([])
    expect(result.unreachable).toEqual([])
  })

  it("should detect orphaned step (not connected to flow)", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })
    // Create orphan but don't use it - it's still added to the graph
    new Form(process, "orphan", { role: mockRole, form: () => ({}) })

    process.start(step1).next(step2).end()
    // orphan is created but never connected

    const result = process.validateFlows()
    expect(result.unreachable).toEqual(["test-unit/process/orphan"])
    expect(result.dangling).toEqual([])
  })

  it("should detect unreachable chain (connected but not to start)", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })
    // Unreachable chain: step3 -> step4 with .end() but never connected to start
    const step3 = new Form(process, "step3", {
      role: mockRole,
      form: () => ({}),
    })
    const step4 = new Form(process, "step4", {
      role: mockRole,
      form: () => ({}),
    })

    process.start(step1).next(step2).end()
    // This chain is properly terminated but unreachable from start
    step3.next(step4).end()

    const result = process.validateFlows()
    expect(result.unreachable).toHaveLength(2)
    expect(result.unreachable).toContain("test-unit/process/step3")
    expect(result.unreachable).toContain("test-unit/process/step4")
    expect(result.dangling).toEqual([])
  })

  it("should handle single-step process", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })

    process.start(step1).end()

    const result = process.validateFlows()
    expect(result.dangling).toEqual([])
    expect(result.unreachable).toEqual([])
  })

  it("should detect dangling single-step process without .end()", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })

    process.start(step1) // Missing .end()

    const result = process.validateFlows()
    expect(result.dangling).toEqual(["test-unit/process/step1"])
    expect(result.unreachable).toEqual([])
  })

  it("should handle Step.end() method for inline termination", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })
    const step3 = new Form(process, "step3", {
      role: mockRole,
      form: () => ({}),
    })

    // Using Step.end() to terminate at step3
    process.start(step1).next(step2).end(step3)

    const result = process.validateFlows()
    expect(result.dangling).toEqual([])
    expect(result.unreachable).toEqual([])
  })
})

describe("Process - edge cases", () => {
  it("should throw when using step from a different process", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process1 = new Process(orgUnit, "process1", {
      name: "Test 1",
      purpose: "Test",
    })
    const process2 = new Process(orgUnit, "process2", {
      name: "Test 2",
      purpose: "Test",
    })

    const step1 = new Form(process1, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process2, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    expect(() => process1.start(step1).next(step2)).toThrow(
      'Step "test-unit/process2/step2" belongs to a different process than "test-unit/process1"',
    )
  })

  it("should throw when calling .end() twice on the same step", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    const flow = process.start(step1).next(step2)
    flow.end()

    expect(() => flow.end()).toThrow(
      'Step "test-unit/process/step2" already has .end() called',
    )
  })

  it("should throw when diamond branches both call .end() on same step", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2a = new Form(process, "step2a", {
      role: mockRole,
      form: () => ({}),
    })
    const step2b = new Form(process, "step2b", {
      role: mockRole,
      form: () => ({}),
    })
    const step3 = new Form(process, "step3", {
      role: mockRole,
      form: () => ({}),
    })

    const flow = process.start(step1)
    flow
      .next(step2a, { condition: { fn: () => true } })
      .next(step3)
      .end()

    // Second branch trying to end step3 again should throw
    expect(() =>
      flow
        .next(step2b, { condition: { fn: () => false } })
        .next(step3)
        .end(),
    ).toThrow('Step "test-unit/process/step3" already has .end() called')
  })
})

describe("Process - startNodes", () => {
  it("should return single start node", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    process.start(step1).end()

    const startNodes = process.startNodes()
    expect(startNodes).toHaveLength(1)
    expect(startNodes[0]).toBe(step1)
  })

  it("should return multiple start nodes when defined", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    process.start(step1).end()
    process.start(step2).end()

    const startNodes = process.startNodes()
    expect(startNodes).toHaveLength(2)
    expect(startNodes).toContain(step1)
    expect(startNodes).toContain(step2)
  })
})

describe("Process - else branches", () => {
  it("should create edge with isElse: true using .else().next()", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })
    const step3 = new Form(process, "step3", {
      role: mockRole,
      form: () => ({}),
    })

    const flow = process.start(step1)
    flow.next(step2, { condition: { fn: () => true } }).end()
    flow.else().next(step3, { text: "Not approved" }).end()

    const graph = process.getGraph()
    const edges = graph.outEdges(step1.node.path)
    expect(edges).toHaveLength(2)

    // Find the else edge
    const elseEdge = edges?.find((e) => graph.target(e) === step3.node.path)
    expect(elseEdge).toBeDefined()
    const attrs = graph.getEdgeAttributes(elseEdge!) as {
      isElse?: boolean
      condition?: unknown
      conditionText?: string
    }
    expect(attrs.isElse).toBe(true)
    expect(attrs.condition).toBeUndefined()
    expect(attrs.conditionText).toBe("Not approved")
  })

  it("should create edge with isElse: true using .elseEnd()", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    const flow = process.start(step1)
    flow.end(step2, { condition: { fn: () => true } })
    flow.elseEnd()

    const graph = process.getGraph()
    const edges = graph.outEdges(step1.node.path)
    expect(edges).toHaveLength(2)

    // Find the else edge to __end__
    const elseEdge = edges?.find((e) => graph.target(e) === "__end__")
    expect(elseEdge).toBeDefined()
    const attrs = graph.getEdgeAttributes(elseEdge!) as { isElse?: boolean }
    expect(attrs.isElse).toBe(true)
  })

  it("should create edge with isElse: true using .elseEnd(step)", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })
    const step3 = new Form(process, "step3", {
      role: mockRole,
      form: () => ({}),
    })

    const flow = process.start(step1)
    flow.end(step2, { condition: { fn: () => true } })
    flow.elseEnd(step3, { text: "Not approved" })

    const graph = process.getGraph()
    const edges = graph.outEdges(step1.node.path)
    expect(edges).toHaveLength(2)

    // Find the else edge to step3
    const elseEdge = edges?.find((e) => graph.target(e) === step3.node.path)
    expect(elseEdge).toBeDefined()
    const attrs = graph.getEdgeAttributes(elseEdge!) as {
      isElse?: boolean
      conditionText?: string
    }
    expect(attrs.isElse).toBe(true)
    expect(attrs.conditionText).toBe("Not approved")

    // step3 should also have an edge to __end__
    const step3EndEdge = graph
      .outEdges(step3.node.path)
      ?.find((e) => graph.target(e) === "__end__")
    expect(step3EndEdge).toBeDefined()
  })

  it("should create edge with isElse: true using .elseNext()", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })
    const step3 = new Form(process, "step3", {
      role: mockRole,
      form: () => ({}),
    })

    const flow = process.start(step1)
    flow.next(step2, { condition: { fn: () => true } }).end()
    flow.elseNext(step3, { text: "Not approved" }).end()

    const graph = process.getGraph()
    const edges = graph.outEdges(step1.node.path)
    expect(edges).toHaveLength(2)

    // Find the else edge
    const elseEdge = edges?.find((e) => graph.target(e) === step3.node.path)
    expect(elseEdge).toBeDefined()
    const attrs = graph.getEdgeAttributes(elseEdge!) as {
      isElse?: boolean
      conditionText?: string
    }
    expect(attrs.isElse).toBe(true)
    expect(attrs.conditionText).toBe("Not approved")
  })

  it("should detect missing else when conditional exists", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    // Conditional flow without else
    process.start(step1).end(step2, { condition: { fn: () => true } })

    const result = process.validateFlows()
    expect(result.missingElse).toContain(step1.node.path)
    expect(result.multipleElse).toEqual([])
  })

  it("should detect multiple else branches (error)", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })
    const step3 = new Form(process, "step3", {
      role: mockRole,
      form: () => ({}),
    })
    const step4 = new Form(process, "step4", {
      role: mockRole,
      form: () => ({}),
    })

    const flow = process.start(step1)
    flow.next(step2, { condition: { fn: () => true } }).end()
    flow.else().next(step3).end()
    // Manually add another else edge (simulating a bug)
    process.addEdge(step1, step4, { isElse: true })
    process.addEndEdge(step4)

    const result = process.validateFlows()
    expect(result.multipleElse).toContain(step1.node.path)
  })

  it("should pass validation when exactly one else branch present", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })
    const step3 = new Form(process, "step3", {
      role: mockRole,
      form: () => ({}),
    })

    const flow = process.start(step1)
    flow.next(step2, { condition: { fn: () => true } }).end()
    flow.elseNext(step3).end()

    const result = process.validateFlows()
    expect(result.missingElse).toEqual([])
    expect(result.multipleElse).toEqual([])
    expect(result.dangling).toEqual([])
    expect(result.unreachable).toEqual([])
  })

  it("should pass validation with multiple conditional edges and single else", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const stepHigh = new Form(process, "stepHigh", {
      role: mockRole,
      form: () => ({}),
    })
    const stepMedium = new Form(process, "stepMedium", {
      role: mockRole,
      form: () => ({}),
    })
    const stepLow = new Form(process, "stepLow", {
      role: mockRole,
      form: () => ({}),
    })

    const flow = process.start(step1)
    flow.next(stepHigh, { condition: { fn: () => true } }).end()
    flow.next(stepMedium, { condition: { fn: () => true } }).end()
    flow.else().next(stepLow).end()

    const result = process.validateFlows()
    expect(result.missingElse).toEqual([])
    expect(result.multipleElse).toEqual([])
    expect(result.dangling).toEqual([])
    expect(result.unreachable).toEqual([])
  })

  it("should not require else branch for unconditional flows", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    // Unconditional flow - no condition
    process.start(step1).next(step2).end()

    const result = process.validateFlows()
    expect(result.missingElse).toEqual([])
    expect(result.multipleElse).toEqual([])
  })

  it("should throw when calling .elseEnd() twice on same step", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    const flow = process.start(step1)
    flow.end(step2, { condition: { fn: () => true } })
    flow.elseEnd()

    expect(() => flow.elseEnd()).toThrow(
      'Step "test-unit/process/step1" already has .elseEnd() called',
    )
  })

  it("should detect orphan else branch (else without conditional flow)", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    // Only an else branch, no conditional flow - this is invalid
    const flow = process.start(step1)
    flow.else().end(step2)

    const result = process.validateFlows()
    expect(result.orphanElse).toEqual(["test-unit/process/step1"])
    expect(result.missingElse).toEqual([])
    expect(result.multipleElse).toEqual([])
  })

  it("should detect orphan else with elseEnd (else without conditional flow)", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({}),
    })

    // Only elseEnd, no conditional flow - this is invalid
    const flow = process.start(step1)
    flow.elseEnd()

    const result = process.validateFlows()
    expect(result.orphanElse).toEqual(["test-unit/process/step1"])
    expect(result.missingElse).toEqual([])
  })
})

describe("Process - onError branches", () => {
  it("should create error edge metadata for catch-all onError branches", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new NodeStep(process, "step1", {
      input: () => Effect.succeed({}),
      output: {},
      execute: () => Effect.succeed({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    process.start(step1)
    step1.onError(step2).end()

    const graph = process.getGraph()
    const edge = graph
      .outEdges(step1.node.path)
      ?.find((candidate) => graph.target(candidate) === step2.node.path)
    expect(edge).toBeDefined()

    const attrs = graph.getEdgeAttributes(edge!) as {
      isOnError?: boolean
      taggedErrors?: readonly string[]
      isElse?: boolean
    }
    expect(attrs.isOnError).toBe(true)
    expect(attrs.taggedErrors).toBeUndefined()
    expect(attrs.isElse).toBeUndefined()
  })

  it("should preserve taggedErrors on onError branches", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new NodeStep(process, "step1", {
      input: () => Effect.succeed({}),
      output: {},
      execute: () => Effect.succeed({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    process.start(step1)
    step1.onError(step2, { taggedErrors: ["Timeout", "Fatal"] })

    const graph = process.getGraph()
    const edge = graph
      .outEdges(step1.node.path)
      ?.find((candidate) => graph.target(candidate) === step2.node.path)
    expect(edge).toBeDefined()

    const attrs = graph.getEdgeAttributes(edge!) as {
      isOnError?: boolean
      taggedErrors?: readonly string[]
    }
    expect(attrs.isOnError).toBe(true)
    expect(attrs.taggedErrors).toEqual(["Timeout", "Fatal"])
  })

  it("should allow duplicate onError branches to the same target", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new NodeStep(process, "step1", {
      input: () => Effect.succeed({}),
      output: {},
      execute: () => Effect.succeed({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    process.start(step1)
    step1.onError(step2, { taggedErrors: ["Retryable"] })
    step1.onError(step2, { taggedErrors: ["Retryable"] }).end()

    const graph = process.getGraph()
    const edgesToStep2 = (graph.outEdges(step1.node.path) ?? []).filter(
      (candidate) => graph.target(candidate) === step2.node.path,
    )

    expect(edgesToStep2).toHaveLength(2)
    for (const edge of edgesToStep2) {
      const attrs = graph.getEdgeAttributes(edge) as {
        isOnError?: boolean
        taggedErrors?: readonly string[]
      }
      expect(attrs.isOnError).toBe(true)
      expect(attrs.taggedErrors).toEqual(["Retryable"])
    }
  })

  it("should allow normal and onError branches to share a target", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new NodeStep(process, "step1", {
      input: () => Effect.succeed({}),
      output: {},
      execute: () => Effect.succeed({}),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    process.start(step1)
    step1.next(step2)
    step1.onError(step2).end()

    const graph = process.getGraph()
    const edgesToStep2 = (graph.outEdges(step1.node.path) ?? []).filter(
      (candidate) => graph.target(candidate) === step2.node.path,
    )

    expect(edgesToStep2).toHaveLength(2)
    expect(
      edgesToStep2.filter(
        (edge) =>
          (graph.getEdgeAttributes(edge) as { isOnError?: boolean })
            .isOnError === true,
      ),
    ).toHaveLength(1)
  })
})

describe("Process - schedule property", () => {
  it("should store schedule function on edge", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({ start_date: ES.DateTimeUtc }),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    const scheduleFn = (state: { start_date: DateTime.DateTime }) =>
      state.start_date
    process.start(step1).next(step2, {
      schedule: { fn: scheduleFn, text: "On start date" },
    })

    const graph = process.getGraph()
    const edges = graph.outEdges(step1.node.path)
    expect(edges).toHaveLength(1)

    const edge = edges![0]!
    const attrs = graph.getEdgeAttributes(edge) as EdgeAttributes<{
      start_date: DateTime.DateTime
    }>
    expect(attrs.schedule).toBe(scheduleFn)
    expect(attrs.scheduleText).toBe("On start date")
  })

  it("should store scheduleText on edge", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({ start_date: ES.DateTimeUtc }),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    process.start(step1).end(step2, {
      schedule: {
        fn: (state) => DateTime.add(state.start_date, { days: 7 }),
        text: "One week after start",
      },
    })

    const graph = process.getGraph()
    const edges = graph.outEdges(step1.node.path)
    expect(edges).toHaveLength(1)

    const edge = edges![0]!
    const attrs = graph.getEdgeAttributes(edge) as EdgeAttributes<{
      start_date: DateTime.DateTime
    }>
    expect(attrs.schedule).toBeDefined()
    expect(attrs.scheduleText).toBe("One week after start")
  })

  it("should allow both condition and schedule on same edge", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({ start_date: ES.DateTimeUtc, approved: ES.Boolean }),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    const conditionFn = (state: {
      start_date: DateTime.DateTime
      approved: boolean
    }) => state.approved
    const scheduleFn = (state: {
      start_date: DateTime.DateTime
      approved: boolean
    }) => state.start_date

    process.start(step1).next(step2, {
      condition: { fn: conditionFn, text: "If approved" },
      schedule: { fn: scheduleFn, text: "On start date" },
    })

    const graph = process.getGraph()
    const edges = graph.outEdges(step1.node.path)
    expect(edges).toHaveLength(1)

    const edge = edges![0]!
    const attrs = graph.getEdgeAttributes(edge) as EdgeAttributes<{
      start_date: DateTime.DateTime
      approved: boolean
    }>
    expect(attrs.condition).toBe(conditionFn)
    expect(attrs.conditionText).toBe("If approved")
    expect(attrs.schedule).toBe(scheduleFn)
    expect(attrs.scheduleText).toBe("On start date")
  })

  it("should type-check schedule function with accumulated state", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({
        first_name: ES.String,
        last_name: ES.String,
        start_date: ES.DateTimeUtc,
      }),
    })

    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({ additional_days: ES.Number }),
    })

    const step3 = new Form(process, "step3", {
      role: mockRole,
      form: () => ({}),
    })

    process
      .start(step1)
      .next(step2, {
        schedule: {
          // At this point, state has { first_name, last_name, start_date }
          fn: (state) => state.start_date,
          text: "On start date",
        },
      })
      .next(step3, {
        schedule: {
          // At this point, state has { first_name, last_name, start_date, additional_days }
          fn: (state) =>
            DateTime.add(state.start_date, { days: state.additional_days }),
          text: "Custom delay after start",
        },
      })
      .end()

    expect(true).toBe(true)
  })

  it("should work with FlowPath.next() schedule option via step flow pattern", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({ start_date: ES.DateTimeUtc }),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    // Use flow pattern to get properly typed state
    const flow = process.start(step1)
    flow.next(step2, {
      schedule: {
        fn: (state) => DateTime.subtract(state.start_date, { days: 7 }),
        text: "One week before start",
      },
    })

    const graph = process.getGraph()
    const edges = graph.outEdges(step1.node.path)
    expect(edges).toHaveLength(1)

    const edge = edges![0]!
    const attrs = graph.getEdgeAttributes(edge) as EdgeAttributes<{
      start_date: DateTime.DateTime
    }>
    expect(attrs.schedule).toBeDefined()
    expect(attrs.scheduleText).toBe("One week before start")
  })

  it("should work with FlowPath.end() schedule option via step flow pattern", () => {
    const { orgUnit, mockRole } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role: mockRole,
      form: () => ({ start_date: ES.DateTimeUtc }),
    })
    const step2 = new Form(process, "step2", {
      role: mockRole,
      form: () => ({}),
    })

    // Use flow pattern to get properly typed state
    const flow = process.start(step1)
    flow.end(step2, {
      schedule: {
        fn: (state) => state.start_date,
        text: "On employee start date",
      },
    })

    const graph = process.getGraph()
    const edges = graph.outEdges(step1.node.path)
    expect(edges).toHaveLength(1)

    const edge = edges![0]!
    const attrs = graph.getEdgeAttributes(edge) as EdgeAttributes<{
      start_date: DateTime.DateTime
    }>
    expect(attrs.schedule).toBeDefined()
    expect(attrs.scheduleText).toBe("On employee start date")
  })
})
