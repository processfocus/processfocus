import { DateTime, Effect, Schema } from "effect"
import type { ExecutionRow, TodoStepRow } from "@pf/graphql-db-operations"
import {
  Form,
  NodeStep,
  OrgUnit,
  Organisation,
  Process,
  Role,
} from "@pf/process"
import {
  assembleSteps,
  publicCompletionRecipientEmail,
} from "../src/lib/rxdb/execution"
import { beforeEach, describe, expect, it } from "bun:test"

/**
 * Tests for assembleSteps function.
 *
 * This unit tests the step assembly logic directly by providing
 * fake ExecutionRow and TodoStepRow data, avoiding the need
 * for database setup.
 */

/**
 * Create a test organisation with a linear process:
 * Start -> StepA -> StepB -> StepC -> End
 */
const createLinearOrg = () => {
  const org = new Organisation({ name: "Test Corp" })
  const dept = new OrgUnit(org, "dept", {
    name: "Department",
    type: "department",
  })
  const role = new Role(dept, "worker", { name: "Worker" })
  const process = new Process(dept, "linear-process", {
    name: "Linear Process",
    purpose: "Test linear flow",
  })

  const stepA = new Form(process, "step-a", {
    name: "Step A",
    role,
    form: () => ({}),
  })
  const stepB = new Form(process, "step-b", {
    name: "Step B",
    role,
    form: () => ({}),
  })
  const stepC = new Form(process, "step-c", {
    name: "Step C",
    role,
    form: () => ({}),
  })

  process.start(stepA).next(stepB).end(stepC)

  return { org, process, stepA, stepB, stepC }
}

const createSystemStepOrg = () => {
  const org = new Organisation({ name: "Test Corp" })
  const dept = new OrgUnit(org, "dept", {
    name: "Department",
    type: "department",
  })
  const role = new Role(dept, "worker", { name: "Worker" })
  const process = new Process(dept, "system-process", {
    name: "System Process",
    purpose: "Test system step timeline",
  })

  const submit = new Form(process, "submit", {
    name: "Submit",
    role,
    form: () => ({}),
  })
  const automate = new NodeStep(process, "automate", {
    name: "Automate",
    input: () => Effect.succeed({}),
    output: {},
    execute: () => Effect.succeed({}),
  })
  const approve = new Form(process, "approve", {
    name: "Approve",
    role,
    form: () => ({}),
  })

  process.start(submit).next(automate).end(approve)

  return { org }
}

const createStartSystemStepOrg = () => {
  const org = new Organisation({ name: "Test Corp" })
  const dept = new OrgUnit(org, "dept", {
    name: "Department",
    type: "department",
  })
  const process = new Process(dept, "start-system-process", {
    name: "Start System Process",
    purpose: "Test system start timeline",
  })

  const automate = new NodeStep(process, "automate", {
    name: "Automate",
    input: () => Effect.succeed({}),
    output: {},
    execute: () => Effect.succeed({}),
  })

  process.start(automate).end()

  return { org }
}

const createPublicCompletionOrg = (
  recipient: (state: {
    email: string
  }) => string | Effect.Effect<string, { readonly _tag: string }, unknown>,
) => {
  const org = new Organisation({ name: "Test Corp" })
  const dept = new OrgUnit(org, "dept", {
    name: "Department",
    type: "department",
  })
  const role = new Role(dept, "worker", { name: "Worker" })
  const process = new Process(dept, "public-process", {
    name: "Public Process",
    purpose: "Test public completion timeline",
  })

  const submit = new Form(process, "submit", {
    name: "Submit",
    role,
    form: () => ({ email: Schema.String }),
  })
  const publicStep = new Form(process.start(submit), "public-step", {
    name: "Public Step",
    role,
    publicCompletion: {
      recipient,
      expiresAt: () => DateTime.unsafeMake("2024-01-15T00:00:00Z"),
    },
    form: () => ({}),
  })

  return { org, publicStep }
}

/**
 * Create a test organisation with a branching process:
 *
 *                    StepB1
 *                  /        \
 * Start -> StepA             -> StepD -> End
 *                  \        /
 *                    StepB2
 */
const createBranchingOrg = () => {
  const org = new Organisation({ name: "Test Corp" })
  const dept = new OrgUnit(org, "dept", {
    name: "Department",
    type: "department",
  })
  const role = new Role(dept, "worker", { name: "Worker" })
  const process = new Process(dept, "branching-process", {
    name: "Branching Process",
    purpose: "Test branching flow",
  })

  const stepA = new Form(process, "step-a", {
    name: "Step A",
    role,
    form: () => ({}),
  })
  const stepB1 = new Form(process, "step-b1", {
    name: "Step B1",
    role,
    form: () => ({}),
  })
  const stepB2 = new Form(process, "step-b2", {
    name: "Step B2",
    role,
    form: () => ({}),
  })
  const stepD = new Form(process, "step-d", {
    name: "Step D",
    role,
    form: () => ({}),
  })

  process.start(stepA).next(stepB1).next(stepD).end(stepD)
  stepA.next(stepB2).next(stepD)

  return { org, process, stepA, stepB1, stepB2, stepD }
}

/**
 * Helper to create a fake ExecutionRow
 */
const makeExecution = (overrides: Partial<ExecutionRow> = {}): ExecutionRow => {
  const base: ExecutionRow = {
    id: "exec-1",
    processStateId: "ps-1",
    processName: "Test Process",
    processPath: "dept/linear-process",
    status: "InProgress",
    startedAt: "2024-01-01T00:00:00Z",
    finishedAt: null,
    durationMs: null,
    updatedAt: 1704067200000,
    deleted: false,
    startStepId: "start-step-id",
    startStepName: "Step A",
    startStepPath: "dept/linear-process/step-a",
    startStepRoleId: "role-start",
    startStepRoleName: "Initiator",
    startStepRoleOrgUnitPath: "/dept/",
    startStepEmbedded: false,
    startStepExternalParticipantId: null,
    startStepExternalParticipantEmail: null,
    processStateCreatedAt: "2023-12-31T23:59:00Z",
    startedByEmail: "john.doe@example.com",
    startedById: "emp-starter",
    startedByFirstName: "John",
    startedByLastName: "Doe",
    startedByPicture: null,
    startedByOrgUnit: "Department",
    processSlaValue: null,
    processSlaUnit: null,
    processSlaWarning: null,
    typicalDurationMinMs: null,
    typicalDurationMaxMs: null,
    processOrgUnitId: "org-1",
    startedByRoleId: null,
    startedByRoleName: null,
    startedByRolePath: null,
    abandonedReason: null,
  }
  return { ...base, ...overrides }
}

/**
 * Helper to create a fake TodoStepRow
 */
const makeTodo = (overrides: Partial<TodoStepRow> = {}): TodoStepRow => ({
  executionId: "exec-1",
  todoId: "todo-1",
  stepId: "step-id",
  stepName: "Step",
  stepPath: "dept/linear-process/step-b",
  completed: false,
  failureReason: null,
  correctionRequiredAt: null,
  correctionFailureReason: null,
  completedByUserId: null,
  providerUserId: "emp-1",
  providerUserFirstName: "Jane",
  providerUserLastName: "Smith",
  providerUserEmail: null,
  providerUserPicture: null,
  providerUserOrgUnit: "Department",
  assignedProviderUserEmail: null,
  externalParticipantId: null,
  externalParticipantEmail: null,
  roleId: "role-1",
  roleName: "Operator",
  roleOrgUnitPath: "/dept/",
  completingRoleId: null,
  completingRoleName: null,
  completingRolePath: null,
  itemData: null,
  createdAt: 1704067100000,
  updatedAt: 1704067200000,
  ...overrides,
})

describe("assembleSteps", () => {
  it("distinguishes delegated start and completion without changing owner identities", () => {
    const { org } = createLinearOrg()
    const by =
      'pf:delegation:{"version":1,"ownerUserId":"usr-owner","ownerEmail":"owner@example.com","delegationId":"dlg-1","generationId":"dsg-1","name":"invoice-agent"}'
    const execution = makeExecution({ createdBy: by })
    const todo = makeTodo({ completed: true, updatedBy: by })
    const { steps } = assembleSteps(execution, [todo], org)
    expect(steps[0]?.providerUserId).toBe(execution.startedById)
    expect(steps[0]?.providerUserFirstName).toBe(
      "owner@example.com via invoice-agent",
    )
    expect(steps[0]?.providerUserLastName).toBeNull()
    const completed = steps.find((step) => step.id === todo.todoId)
    expect(completed?.providerUserId).toBe(todo.providerUserId)
    expect(completed?.providerUserFirstName).toBe(
      "owner@example.com via invoice-agent",
    )
    expect(completed?.providerUserLastName).toBeNull()
  })
  it.each([null, "emp-owner"])(
    "distinguishes delegated failed work with provider user %s",
    (providerUserId) => {
      const { org } = createSystemStepOrg()
      const execution = makeExecution({
        startStepPath: "dept/system-process/submit",
      })
      const todo = makeTodo({
        stepPath: "dept/system-process/automate",
        failureReason: "Worker failed",
        providerUserId,
        updatedBy:
          'pf:delegation:{"version":1,"ownerUserId":"usr-owner","ownerEmail":"owner@example.com","delegationId":"dlg-1","generationId":"dsg-1","name":"invoice-agent"}',
      })
      const { steps } = assembleSteps(execution, [todo], org)
      expect(steps.find((step) => step.id === todo.todoId)).toMatchObject({
        status: "Failed",
        failureReason: "Worker failed",
        providerUserId,
        providerUserFirstName: "owner@example.com via invoice-agent",
        providerUserLastName: null,
      })

      const human = assembleSteps(
        execution,
        [{ ...todo, updatedBy: "human@example.com" }],
        org,
      )
      expect(human.steps.find((step) => step.id === todo.todoId)).toMatchObject(
        {
          providerUserFirstName: todo.providerUserFirstName,
          providerUserLastName: todo.providerUserLastName,
        },
      )
    },
  )
  describe("linear process", () => {
    let org: Organisation

    beforeEach(() => {
      const setup = createLinearOrg()
      org = setup.org
    })

    it("should include start step as first completed step", () => {
      const execution = makeExecution()
      const todos: TodoStepRow[] = []

      const { steps } = assembleSteps(execution, todos, org)

      // Start step + potential steps from graph walk
      expect(steps.length).toBeGreaterThanOrEqual(1)
      expect(steps[0]?.path).toBe("/dept/linear-process/step-a")
      expect(steps[0]?.status).toBe("Completed")
      expect(steps[0]?.name).toBe("Step A")
      // Start step should have role from database
      expect(steps[0]?.roleId).toBe("role-start")
      expect(steps[0]?.roleName).toBe("Initiator")
      // Start step timestamps: started = processStateCreatedAt, completed = startedAt
      expect(steps[0]?.startedAt).toBe("2023-12-31T23:59:00Z")
      expect(steps[0]?.completedAt).toBe("2024-01-01T00:00:00Z")
    })

    it("should include embedded form submitter metadata on the start step", () => {
      const execution = makeExecution({
        startStepEmbedded: true,
        startStepExternalParticipantId: "xp-1",
        startStepExternalParticipantEmail: "alice@example.com",
        startedById: null,
        startedByFirstName: null,
        startedByLastName: null,
        startedByPicture: null,
        startedByOrgUnit: null,
      })
      const { steps } = assembleSteps(execution, [], org)

      expect(steps[0]?.externalSubmitterEmail).toBe("alice@example.com")
      expect(steps[0]?.providerUserId).toBeNull()
    })

    it("should leave embedded form external submitter email empty when no participant was recorded", () => {
      const execution = makeExecution({
        startStepEmbedded: true,
      })
      const { steps } = assembleSteps(execution, [], org)

      expect(steps[0]?.externalSubmitterEmail).toBeNull()
    })

    it("should add waiting todos after start step", () => {
      const execution = makeExecution({ status: "Running" })
      const todos: TodoStepRow[] = [
        makeTodo({
          stepPath: "dept/linear-process/step-b",
          stepName: "Step B",
          completed: false,
          createdAt: 1704067100000,
        }),
      ]

      const { steps, correctedStatus } = assembleSteps(execution, todos, org)

      // 3 steps: start (completed), step-b (waiting), step-c (potential)
      expect(steps).toHaveLength(3)
      expect(steps[0]?.status).toBe("Completed")
      expect(steps[0]?.path).toBe("/dept/linear-process/step-a")
      expect(steps[1]?.status).toBe("Waiting")
      expect(steps[1]?.path).toBe("/dept/linear-process/step-b")
      // Waiting step should have role and startedAt but no completedAt
      expect(steps[1]?.roleId).toBe("role-1")
      expect(steps[1]?.roleName).toBe("Operator")
      expect(steps[1]?.startedAt).toBe("2023-12-31T23:58:20.000Z")
      expect(steps[1]?.completedAt).toBeNull()
      // Has waiting todos, so stays Running
      expect(correctedStatus).toBe("Running")
    })

    it("should include direct assignee email on waiting todos", () => {
      const execution = makeExecution({ status: "Running" })
      const todos: TodoStepRow[] = [
        makeTodo({
          stepPath: "dept/linear-process/step-b",
          stepName: "Step B",
          completed: false,
          assignedProviderUserEmail: "employee@example.com",
        }),
      ]

      const { steps } = assembleSteps(execution, todos, org)

      expect(steps[1]?.assignedProviderUserEmail).toBe("employee@example.com")
    })

    it("shows correction-required steps without failing the execution", () => {
      const execution = makeExecution({ status: "Running" })
      const todos: TodoStepRow[] = [
        makeTodo({
          stepPath: "dept/linear-process/step-b",
          stepName: "Step B",
          completed: false,
          correctionRequiredAt: 1704067200000,
          correctionFailureReason: "recipient_not_found",
        }),
      ]

      const { steps, correctedStatus } = assembleSteps(execution, todos, org)

      expect(correctedStatus).toBe("Running")
      expect(steps[1]?.status).toBe("Correction Required")
      expect(steps[1]?.failureReason).toBe("recipient_not_found")
    })

    it("should add completed todos with Completed status", () => {
      const execution = makeExecution()
      const todos: TodoStepRow[] = [
        makeTodo({
          stepPath: "dept/linear-process/step-b",
          stepName: "Step B",
          completed: true,
          createdAt: 1704067100000,
          updatedAt: 1704067200000,
        }),
        makeTodo({
          todoId: "todo-2",
          stepPath: "dept/linear-process/step-c",
          stepName: "Step C",
          completed: false,
          createdAt: 1704067250000,
          updatedAt: 1704067300000,
        }),
      ]

      const { steps } = assembleSteps(execution, todos, org)

      expect(steps).toHaveLength(3)
      expect(steps[0]?.status).toBe("Completed") // start step
      expect(steps[1]?.status).toBe("Completed") // step-b
      expect(steps[1]?.path).toBe("/dept/linear-process/step-b")
      // Completed step should have both startedAt and completedAt
      expect(steps[1]?.startedAt).toBe("2023-12-31T23:58:20.000Z")
      expect(steps[1]?.completedAt).toBe("2024-01-01T00:00:00.000Z")
      expect(steps[2]?.status).toBe("Waiting") // step-c
      expect(steps[2]?.path).toBe("/dept/linear-process/step-c")
    })

    it("should walk graph to find potential steps from waiting todos", () => {
      const execution = makeExecution()
      const todos: TodoStepRow[] = [
        makeTodo({
          stepPath: "dept/linear-process/step-b",
          stepName: "Step B",
          completed: false,
        }),
      ]

      const { steps } = assembleSteps(execution, todos, org)

      // Should have: start (completed), step-b (waiting), step-c (potential)
      expect(steps).toHaveLength(3)
      expect(steps[2]?.status).toBe("Potential")
      expect(steps[2]?.path).toBe("/dept/linear-process/step-c")
      // Potential steps get role from org model, no timestamps
      expect(steps[2]?.roleId).not.toBeNull() // role comes from org
      expect(steps[2]?.roleName).toBe("Worker")
      expect(steps[2]?.startedAt).toBeNull()
      expect(steps[2]?.completedAt).toBeNull()
    })

    it("should not add potential steps for completed executions", () => {
      const execution = makeExecution({ status: "Completed" })
      const todos: TodoStepRow[] = [
        makeTodo({
          stepPath: "dept/linear-process/step-b",
          stepName: "Step B",
          completed: true,
        }),
      ]

      const { steps, correctedStatus } = assembleSteps(execution, todos, org)

      // Should only have completed steps, no potential
      expect(steps.every((s) => s.status !== "Potential")).toBe(true)
      // Preserves Completed status from database
      expect(correctedStatus).toBe("Completed")
    })

    it("should walk from last completed step when no waiting todos", () => {
      const execution = makeExecution({ status: "Running" })
      const todos: TodoStepRow[] = [
        makeTodo({
          stepPath: "dept/linear-process/step-b",
          stepName: "Step B",
          completed: true,
        }),
      ]

      const { steps, correctedStatus } = assembleSteps(execution, todos, org)

      // Should have: start (completed), step-b (completed), step-c (potential)
      expect(steps).toHaveLength(3)
      expect(steps[2]?.status).toBe("Potential")
      expect(steps[2]?.path).toBe("/dept/linear-process/step-c")
      // Has potential steps, so stays Running
      expect(correctedStatus).toBe("Running")
    })

    it("should walk from start step when no todos exist", () => {
      const execution = makeExecution()
      const todos: TodoStepRow[] = []

      const { steps } = assembleSteps(execution, todos, org)

      // Should have: start (completed), step-b (potential), step-c (potential)
      expect(steps).toHaveLength(3)
      expect(steps[0]?.status).toBe("Completed")
      expect(steps[1]?.status).toBe("Potential")
      expect(steps[1]?.path).toBe("/dept/linear-process/step-b")
      expect(steps[2]?.status).toBe("Potential")
      expect(steps[2]?.path).toBe("/dept/linear-process/step-c")
    })

    it("should not duplicate steps", () => {
      const execution = makeExecution({
        startStepPath: "dept/linear-process/step-a",
      })
      const todos: TodoStepRow[] = [
        // Completed todo for the same step as start step (edge case)
        makeTodo({
          stepPath: "dept/linear-process/step-a",
          stepName: "Step A",
          completed: true,
        }),
      ]

      const { steps } = assembleSteps(execution, todos, org)

      // step-a should only appear once
      const stepAPaths = steps.filter(
        (s) => s.path === "/dept/linear-process/step-a",
      )
      expect(stepAPaths).toHaveLength(1)
    })

    it("should not duplicate waiting step as potential when path has leading slash", () => {
      // This test uses paths with leading slashes (as they appear in the database)
      // to ensure the waiting step is not duplicated as a potential step
      const execution = makeExecution({
        status: "Running",
        startStepPath: "/dept/linear-process/step-a",
        startStepName: "Step A",
      })
      const todos: TodoStepRow[] = [
        makeTodo({
          stepPath: "/dept/linear-process/step-b",
          stepName: "Step B",
          completed: false,
        }),
      ]

      const { steps } = assembleSteps(execution, todos, org)

      // step-b should only appear once (as Waiting), not twice (as Waiting and Potential)
      const stepBPaths = steps.filter((s) => s.path.endsWith("step-b"))
      expect(stepBPaths).toHaveLength(1)
      expect(stepBPaths[0]?.status).toBe("Waiting")
    })

    it("should include provider user info for todos", () => {
      const execution = makeExecution()
      const todos: TodoStepRow[] = [
        makeTodo({
          stepPath: "dept/linear-process/step-b",
          completed: false,
          providerUserFirstName: "Alice",
          providerUserLastName: "Wonder",
          providerUserPicture: "alice.jpg",
          providerUserOrgUnit: "Engineering",
        }),
      ]

      const { steps } = assembleSteps(execution, todos, org)

      const stepB = steps.find((s) => s.path === "/dept/linear-process/step-b")
      expect(stepB?.providerUserFirstName).toBe("Alice")
      expect(stepB?.providerUserLastName).toBe("Wonder")
      expect(stepB?.providerUserPicture).toBe("alice.jpg")
      expect(stepB?.providerUserOrgUnit).toBe("Engineering")
    })

    it("should have null provider user info for potential steps", () => {
      const execution = makeExecution()
      const todos: TodoStepRow[] = []

      const { steps } = assembleSteps(execution, todos, org)

      const potentialSteps = steps.filter((s) => s.status === "Potential")
      for (const step of potentialSteps) {
        expect(step.providerUserFirstName).toBeNull()
        expect(step.providerUserLastName).toBeNull()
        expect(step.providerUserPicture).toBeNull()
        expect(step.providerUserOrgUnit).toBeNull()
      }
    })

    it("should correct Running to Completed for old data without finishedAt", () => {
      // Simulate old data: finishedAt is null so status is "Running", but execution is actually done
      const execution = makeExecution({
        status: "Running", // DB says running (no finishedAt)
      })
      // All todos are completed, last step (step-c) is done
      const todos: TodoStepRow[] = [
        makeTodo({
          todoId: "todo-1",
          stepPath: "dept/linear-process/step-b",
          stepName: "Step B",
          completed: true,
          updatedAt: 1704067200000,
        }),
        makeTodo({
          todoId: "todo-2",
          stepPath: "dept/linear-process/step-c",
          stepName: "Step C",
          completed: true,
          updatedAt: 1704067300000,
        }),
      ]

      const { correctedStatus } = assembleSteps(execution, todos, org)

      // No waiting todos and step-c has no outgoing edges (end step)
      // so correctedStatus should be "Completed"
      expect(correctedStatus).toBe("Completed")
    })

    it("should still correct completed human-start executions with no remaining work", () => {
      const execution = makeExecution({ status: "Running" })
      const todos: TodoStepRow[] = [
        makeTodo({
          todoId: "todo-1",
          stepPath: "dept/linear-process/step-b",
          stepName: "Step B",
          completed: true,
        }),
        makeTodo({
          todoId: "todo-2",
          stepPath: "dept/linear-process/step-c",
          stepName: "Step C",
          completed: true,
        }),
      ]

      const { correctedStatus } = assembleSteps(execution, todos, org)

      expect(execution.startStepRoleId).not.toBeNull()
      expect(correctedStatus).toBe("Completed")
    })
  })

  describe("publicCompletionRecipientEmail", () => {
    it("resolves the waiting public completion recipient", async () => {
      const { org, publicStep } = createPublicCompletionOrg(
        (state) => state.email,
      )

      const result = await Effect.runPromise(
        publicCompletionRecipientEmail(
          org,
          publicStep.node.path,
          { email: "parent@example.com" },
          makeExecution({
            id: "exec-public",
            startedAt: "2024-01-01T00:00:00Z",
          }),
          null,
        ),
      )

      expect(result).toBe("parent@example.com")
    })

    it("resolves an effectful waiting public completion recipient", async () => {
      const { org, publicStep } = createPublicCompletionOrg((state) =>
        Effect.succeed(state.email),
      )

      const result = await Effect.runPromise(
        publicCompletionRecipientEmail(
          org,
          publicStep.node.path,
          { email: "parent@example.com" },
          makeExecution({
            id: "exec-public",
            startedAt: "2024-01-01T00:00:00Z",
          }),
          null,
        ),
      )

      expect(result).toBe("parent@example.com")
    })

    it("returns null when recipient resolution fails", async () => {
      const { org, publicStep } = createPublicCompletionOrg(() =>
        Effect.fail({
          _tag: "RecipientUnavailable",
          message: "recipient unavailable",
        }),
      )

      const result = await Effect.runPromise(
        publicCompletionRecipientEmail(
          org,
          publicStep.node.path,
          { email: "parent@example.com" },
          makeExecution({
            id: "exec-public",
            startedAt: "2024-01-01T00:00:00Z",
          }),
          null,
        ),
      )

      expect(result).toBeNull()
    })
  })

  describe("branching process", () => {
    let org: Organisation

    beforeEach(() => {
      const setup = createBranchingOrg()
      org = setup.org
    })

    it("should walk all branches from start step", () => {
      const execution = makeExecution({
        startStepPath: "dept/branching-process/step-a",
        startStepName: "Step A",
        processPath: "dept/branching-process",
      })
      const todos: TodoStepRow[] = []

      const { steps } = assembleSteps(execution, todos, org)

      // Should find all reachable steps: step-a (completed), step-b1, step-b2, step-d (all potential)
      expect(steps.length).toBeGreaterThanOrEqual(4)
      const paths = steps.map((s) => s.path)
      expect(paths).toContain("/dept/branching-process/step-a")
      expect(paths).toContain("/dept/branching-process/step-b1")
      expect(paths).toContain("/dept/branching-process/step-b2")
      expect(paths).toContain("/dept/branching-process/step-d")
    })

    it("should walk from multiple waiting todos", () => {
      const execution = makeExecution({
        startStepPath: "dept/branching-process/step-a",
        startStepName: "Step A",
        processPath: "dept/branching-process",
      })
      const todos: TodoStepRow[] = [
        makeTodo({
          todoId: "todo-1",
          stepPath: "dept/branching-process/step-b1",
          stepName: "Step B1",
          completed: false,
          updatedAt: 1704067200000,
        }),
        makeTodo({
          todoId: "todo-2",
          stepPath: "dept/branching-process/step-b2",
          stepName: "Step B2",
          completed: false,
          updatedAt: 1704067300000,
        }),
      ]

      const { steps } = assembleSteps(execution, todos, org)

      // Should have: start (completed), step-b1 (waiting), step-b2 (waiting), step-d (potential)
      expect(steps).toHaveLength(4)

      const stepB1 = steps.find(
        (s) => s.path === "/dept/branching-process/step-b1",
      )
      const stepB2 = steps.find(
        (s) => s.path === "/dept/branching-process/step-b2",
      )
      const stepD = steps.find(
        (s) => s.path === "/dept/branching-process/step-d",
      )

      expect(stepB1?.status).toBe("Waiting")
      expect(stepB2?.status).toBe("Waiting")
      expect(stepD?.status).toBe("Potential")
    })
  })

  describe("filtering by execution id", () => {
    let org: Organisation

    beforeEach(() => {
      const setup = createLinearOrg()
      org = setup.org
    })

    it("should only include todos for the specific execution", () => {
      const execution = makeExecution({ id: "exec-1" })
      const todos: TodoStepRow[] = [
        makeTodo({
          executionId: "exec-1",
          stepPath: "dept/linear-process/step-b",
          stepName: "Step B",
          completed: false,
        }),
        makeTodo({
          executionId: "exec-2", // Different execution
          stepPath: "dept/linear-process/step-c",
          stepName: "Step C",
          completed: false,
        }),
      ]

      const { steps } = assembleSteps(execution, todos, org)

      // Should only have step-b as waiting (not step-c from different execution)
      const waitingSteps = steps.filter((s) => s.status === "Waiting")
      expect(waitingSteps).toHaveLength(1)
      expect(waitingSteps[0]?.path).toBe("/dept/linear-process/step-b")
    })
  })

  describe("ordering by updatedAt", () => {
    let org: Organisation

    beforeEach(() => {
      const setup = createLinearOrg()
      org = setup.org
    })

    it("should order completed todos by updatedAt", () => {
      const execution = makeExecution()
      const todos: TodoStepRow[] = [
        makeTodo({
          todoId: "todo-c",
          stepPath: "dept/linear-process/step-c",
          stepName: "Step C",
          completed: true,
          updatedAt: 1704067300000, // Later
        }),
        makeTodo({
          todoId: "todo-b",
          stepPath: "dept/linear-process/step-b",
          stepName: "Step B",
          completed: true,
          updatedAt: 1704067200000, // Earlier
        }),
      ]

      const { steps } = assembleSteps(execution, todos, org)

      // Completed steps should be ordered by updatedAt
      const completedSteps = steps.filter((s) => s.status === "Completed")
      // First is start step, then step-b (earlier), then step-c (later)
      expect(completedSteps[1]?.path).toBe("/dept/linear-process/step-b")
      expect(completedSteps[2]?.path).toBe("/dept/linear-process/step-c")
    })

    it("should keep completed system steps in the timeline", () => {
      const { org } = createSystemStepOrg()
      const execution = makeExecution({
        processName: "System Process",
        processPath: "dept/system-process",
        status: "Completed",
        finishedAt: "2024-01-01T00:10:00Z",
        startStepName: "Submit",
        startStepPath: "dept/system-process/submit",
        startStepRoleId: null,
        startStepRoleName: null,
        startStepRoleOrgUnitPath: null,
        startStepEmbedded: false,
        startStepExternalParticipantId: null,
        startStepExternalParticipantEmail: null,
        startedByEmail: null,
        startedById: null,
        startedByFirstName: null,
        startedByLastName: null,
        startedByPicture: null,
        startedByOrgUnit: null,
      })
      const todos: TodoStepRow[] = [
        makeTodo({
          todoId: "todo-system",
          stepId: "step-system",
          stepName: "Automate",
          stepPath: "dept/system-process/automate",
          completed: true,
          roleId: null,
          roleName: null,
          roleOrgUnitPath: null,
          providerUserId: null,
          providerUserFirstName: null,
          providerUserLastName: null,
          providerUserPicture: null,
          providerUserOrgUnit: null,
          updatedAt: 1704067250000,
        }),
        makeTodo({
          todoId: "todo-approve",
          stepId: "step-approve",
          stepName: "Approve",
          stepPath: "dept/system-process/approve",
          completed: true,
          updatedAt: 1704067300000,
        }),
      ]

      const { steps, correctedStatus } = assembleSteps(execution, todos, org)

      const completedSteps = steps.filter((s) => s.status === "Completed")
      expect(correctedStatus).toBe("Completed")
      expect(completedSteps).toHaveLength(3)
      expect(completedSteps[0]).toMatchObject({
        path: "/dept/system-process/submit",
        roleId: null,
        providerUserId: null,
      })
      expect(completedSteps[1]).toMatchObject({
        path: "/dept/system-process/automate",
        roleId: null,
        status: "Completed",
      })
      expect(completedSteps[2]?.path).toBe("/dept/system-process/approve")
    })

    it("should keep running system-start executions running while the start job is active", () => {
      const { org } = createStartSystemStepOrg()
      const execution = makeExecution({
        processName: "Start System Process",
        processPath: "dept/start-system-process",
        status: "Running",
        finishedAt: null,
        startStepName: "Automate",
        startStepPath: "dept/start-system-process/automate",
        startStepRoleId: null,
        startStepRoleName: null,
        startStepRoleOrgUnitPath: null,
        startedByEmail: "bob@example.com",
        startedById: "provider-user-1",
      })

      const { steps, correctedStatus } = assembleSteps(execution, [], org)

      expect(correctedStatus).toBe("Running")
      expect(steps[0]).toMatchObject({
        path: "/dept/start-system-process/automate",
        status: "Waiting",
        completedAt: null,
      })
    })

    it("should keep failed system-start executions failed without a failed todo", () => {
      const { org } = createStartSystemStepOrg()
      const execution = makeExecution({
        processName: "Start System Process",
        processPath: "dept/start-system-process",
        status: "Failed",
        finishedAt: "2024-01-01T00:05:00Z",
        abandonedReason: "CostExplorerAwsError: An error has occurred",
        startStepName: "Automate",
        startStepPath: "dept/start-system-process/automate",
        startStepRoleId: null,
        startStepRoleName: null,
        startStepRoleOrgUnitPath: null,
      })

      const { steps, correctedStatus } = assembleSteps(execution, [], org)

      expect(correctedStatus).toBe("Failed")
      expect(steps[0]).toMatchObject({
        path: "/dept/start-system-process/automate",
        status: "Failed",
        failureReason: "CostExplorerAwsError: An error has occurred",
        completedAt: "2024-01-01T00:05:00Z",
      })
    })

    it("should not show abandoned system-start executions as waiting", () => {
      const { org } = createStartSystemStepOrg()
      const execution = makeExecution({
        processName: "Start System Process",
        processPath: "dept/start-system-process",
        status: "Abandoned",
        finishedAt: "2024-01-01T00:05:00Z",
        abandonedReason: "Cancelled by operator",
        startStepName: "Automate",
        startStepPath: "dept/start-system-process/automate",
        startStepRoleId: null,
        startStepRoleName: null,
        startStepRoleOrgUnitPath: null,
      })

      const { steps, correctedStatus } = assembleSteps(execution, [], org)

      expect(correctedStatus).toBe("Abandoned")
      expect(steps[0]).toMatchObject({
        path: "/dept/start-system-process/automate",
        status: "Failed",
        failureReason: "Cancelled by operator",
      })
    })

    it("should fall back to startedAt when a failed todo has an invalid updatedAt", () => {
      const execution = makeExecution({ status: "Running" })
      const todos: TodoStepRow[] = [
        makeTodo({
          todoId: "todo-failed",
          stepId: "step-failed",
          stepName: "Destroy environment stacks",
          stepPath: "dept/linear-process/step-b",
          failureReason: "Step failed.",
          updatedAt: 0,
          createdAt: 1704067100000,
        }),
      ]

      const { steps, correctedStatus } = assembleSteps(execution, todos, org)

      const failedStep = steps.find((step) => step.status === "Failed")

      expect(correctedStatus).toBe("Failed")
      expect(failedStep?.startedAt).toBe("2023-12-31T23:58:20.000Z")
      expect(failedStep?.completedAt).toBe("2023-12-31T23:58:20.000Z")
    })
  })

  describe("terminal system-step failure", () => {
    it("keeps completed sibling evidence next to a failed system todo", () => {
      const { org } = createSystemStepOrg()
      const execution = makeExecution({
        processName: "System Process",
        processPath: "dept/system-process",
        status: "Failed",
        finishedAt: "2024-01-01T00:08:00Z",
        abandonedReason: "account boom",
        startStepName: "Submit",
        startStepPath: "dept/system-process/submit",
        startStepRoleId: "role-start",
        startStepRoleName: "Initiator",
        startStepRoleOrgUnitPath: "/dept/",
      })
      const todos: TodoStepRow[] = [
        makeTodo({
          todoId: "todo-automate-ok",
          stepId: "step-automate",
          stepName: "Automate",
          stepPath: "dept/system-process/automate",
          completed: true,
          roleId: null,
          roleName: null,
          roleOrgUnitPath: null,
          updatedAt: 1704067250000,
        }),
        makeTodo({
          todoId: "todo-automate-failed",
          stepId: "step-automate",
          stepName: "Automate",
          stepPath: "dept/system-process/automate",
          completed: false,
          failureReason: "account boom",
          roleId: null,
          roleName: null,
          roleOrgUnitPath: null,
          updatedAt: 1704067260000,
        }),
      ]

      const { steps, correctedStatus } = assembleSteps(execution, todos, org)

      expect(correctedStatus).toBe("Failed")
      expect(steps.some((step) => step.status === "Potential")).toBe(false)
      expect(steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "/dept/system-process/submit",
            status: "Completed",
          }),
          expect.objectContaining({
            path: "/dept/system-process/automate",
            status: "Completed",
          }),
          expect.objectContaining({
            path: "/dept/system-process/automate",
            status: "Failed",
            failureReason: "account boom",
          }),
        ]),
      )
    })

    it("does not mark the execution Failed when a matching error branch is waiting", () => {
      const { org } = createSystemStepOrg()
      const execution = makeExecution({
        processName: "System Process",
        processPath: "dept/system-process",
        status: "Running",
        finishedAt: null,
        abandonedReason: null,
        startStepName: "Submit",
        startStepPath: "dept/system-process/submit",
        startStepRoleId: "role-start",
        startStepRoleName: "Initiator",
        startStepRoleOrgUnitPath: "/dept/",
      })
      const todos: TodoStepRow[] = [
        makeTodo({
          todoId: "todo-automate-failed",
          stepId: "step-automate",
          stepName: "Automate",
          stepPath: "dept/system-process/automate",
          completed: false,
          failureReason: "account boom",
          roleId: null,
          roleName: null,
          roleOrgUnitPath: null,
        }),
        makeTodo({
          todoId: "todo-approve",
          stepId: "step-approve",
          stepName: "Approve",
          stepPath: "dept/system-process/approve",
          completed: false,
        }),
      ]

      const { steps, correctedStatus } = assembleSteps(execution, todos, org)

      expect(correctedStatus).toBe("Running")
      expect(steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "/dept/system-process/automate",
            status: "Failed",
            failureReason: "account boom",
          }),
          expect.objectContaining({
            path: "/dept/system-process/approve",
            status: "Waiting",
          }),
        ]),
      )
    })
  })

  it("uses startedByRoleId for start step completing role", () => {
    const org = new Organisation({ name: "Test" })
    const { steps } = assembleSteps(
      makeExecution({
        startedByRoleId: "role-manager",
        startedByRoleName: "Manager",
        startedByRolePath: "/Manager",
        startStepRoleId: "role-employee",
        startStepRoleName: "Employee",
        status: "Completed",
      }),
      [],
      org,
    )

    const startStep = steps[0]
    expect(startStep).toBeDefined()
    expect(startStep!.completingRoleId).toBe("role-manager")
    expect(startStep!.completingRoleName).toBe("Manager")
    // Still carries the configured role for fallback
    expect(startStep!.roleId).toBe("role-employee")
    expect(startStep!.roleName).toBe("Employee")
  })
})
