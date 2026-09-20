import { and, eq, isNull } from "drizzle-orm"
import {
  Arbitrary,
  Data,
  DateTime,
  Effect,
  FiberRef,
  Option,
  Schema,
} from "effect"
import * as FastCheck from "effect/FastCheck"
import * as dbSchema from "@pf/drizzle-sqlite"
import {
  type UserContext,
  completeStep,
  startProcess,
  startProcessExecution,
} from "@pf/graphql-api"
import {
  CompletedJobOperations,
  type ProcessState,
  SYSTEM_STEP_EXECUTION_QUEUE,
  getStartedSystemStepCompletedJobId,
} from "@pf/graphql-db-operations"
import {
  flowExecutionHandler,
  systemStepExecutionHandler,
} from "@pf/job-handler"
import { storeOrganisation } from "@pf/org-to-db"
import {
  type Form,
  type OrgUnit,
  isOrgUnit,
  isRole,
  normalizePath,
} from "@pf/process"
import { QueueService } from "@pf/queue-service"
import { RequestTime } from "@pf/request-time"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite/test"
import type {
  CompletedStepRecord,
  FormEntry,
  ProcessTestConfig,
  ProcessTestResult,
} from "./types"

/** Safety limit to prevent infinite loops */
const MAX_ITERATIONS = 100

const collectRolePaths = (org: OrgUnit): readonly string[] => {
  const roles: string[] = []
  const stack: OrgUnit[] = [org]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue

    for (const child of current.node.children) {
      if (isRole(child)) {
        roles.push(normalizePath(child.node.path))
      } else if (isOrgUnit(child)) {
        stack.push(child)
      }
    }
  }

  return roles
}

const makeTestRunnerUserContext = (
  org: OrgUnit,
  requestTime: DateTime.Utc,
): UserContext => ({
  _requestTime: requestTime,
  _userDetails: {
    by: "process-test-runner@example.com",
    id: "process-test-runner@example.com",
  },
  jwt: {
    mode: "access",
    type: "user",
    properties: {
      userId: "process-test-runner@example.com",
      email: "process-test-runner@example.com",
      // The runner executes whole process models, not a single user's journey.
      // Grant all modeled roles so field-level permissions do not block
      // generated form submissions unless a test supplies explicit auth data.
      roles: collectRolePaths(org),
      orgUnitPath: org.node.path,
      orgUnitId: org.node.path,
    },
    aud: "graphql-api",
    iss: "process-test-runner",
    sub: "process-test-runner@example.com",
    // This context is passed directly to operation helpers, after the HTTP/JWT
    // validation layer where token expiry is enforced.
    exp: 0,
    iat: 0,
  },
  userId: "process-test-runner@example.com",
})

/**
 * Query active (non-deleted, non-failed) todos for a process execution.
 * Returns step path and todo ID for each active todo.
 */
const queryActiveTodos = (processExecutionId: string) =>
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    const todos = yield* db
      .select({
        id: dbSchema.toDo.id,
        stepPath: dbSchema.step.path,
        roleId: dbSchema.step.roleId,
      })
      .from(dbSchema.toDo)
      .innerJoin(dbSchema.flow, eq(dbSchema.toDo.flowId, dbSchema.flow.id))
      .innerJoin(
        dbSchema.step,
        eq(dbSchema.flow.targetStepId, dbSchema.step.id),
      )
      .where(
        and(
          eq(dbSchema.toDo.processExecutionId, processExecutionId),
          eq(dbSchema.toDo._deleted, false),
          isNull(dbSchema.toDo.failureReason),
        ),
      )
    return todos
  })

/**
 * Drain all pending jobs from a queue by claiming and processing them.
 * Returns the number of jobs processed.
 */
const drainQueue = <A, I>(
  queueName: string,
  handler: {
    schema: Schema.Schema<A, I>
    handle: (
      // biome-ignore lint/suspicious/noExplicitAny: Job type erased at runtime
      job: any,
    ) => Effect.Effect<void, unknown, unknown>
  },
) =>
  Effect.gen(function* () {
    const requestTimeFiberRef = yield* RequestTime
    let count = 0

    // Keep claiming and processing until queue is empty
    while (true) {
      const jobOption = yield* QueueService.claim(queueName, handler.schema)

      if (Option.isNone(jobOption)) {
        break
      }

      const job = jobOption.value
      // Set current time for this job's database operations
      const now = yield* DateTime.now
      yield* FiberRef.set(requestTimeFiberRef, now)

      yield* handler.handle(job)

      // Acknowledge the job after processing
      const queueService = yield* QueueService
      yield* queueService.acknowledge(job.jobId, job.receipt)

      count++
    }

    return count
  })

/**
 * Drain event queues by claiming and acknowledging jobs (no processing needed).
 */
const drainEventQueues = Effect.gen(function* () {
  const queueService = yield* QueueService

  for (const queue of ["todo-event", "process-event", "execution-event"]) {
    while (true) {
      const jobOption = yield* queueService.rawClaim(queue)
      if (Option.isNone(jobOption)) break
      yield* queueService.acknowledge(
        jobOption.value.jobId,
        jobOption.value.receipt,
      )
    }
  }
})

/**
 * Auto-generate valid form data from a Form step's output schema.
 * Uses Effect's Arbitrary + FastCheck to produce random valid data.
 */
const generateFormData = (form: Form): Record<string, unknown> => {
  if (!form.output) return {}

  const inputSchema = Schema.Struct(form.output as Schema.Struct.Fields)
  const arb = Arbitrary.make(inputSchema)
  const [generatedData] = FastCheck.sample(arb, 1)
  return (generatedData ?? {}) as Record<string, unknown>
}

/**
 * Find form data override for a step, or auto-generate from schema.
 */
const getFormDataForStep = (
  stepPath: string,
  org: ProcessTestConfig["org"],
  forms: ReadonlyArray<FormEntry> | undefined,
): Record<string, unknown> => {
  // Check for explicit override first (compare normalized paths)
  const normalizedStepPath = normalizePath(stepPath)
  const override = forms?.find(
    (f) => normalizePath(f.stepPath) === normalizedStepPath,
  )
  if (override) {
    return override.data
  }

  // Auto-generate from schema
  const form = org.formByPath(stepPath)
  if (!form) return {}
  return generateFormData(form)
}

/**
 * Run a process through its entire lifecycle synchronously.
 *
 * 1. Store organisation in the in-memory database
 * 2. Start the process
 * 3. Loop: drain queues, complete form todos, until process finishes
 * 4. Return results
 */
export const runProcess = (config: ProcessTestConfig) =>
  Effect.gen(function* () {
    const { org, processPath, initialState, forms, setup } = config
    const db = yield* TypedSqliteDrizzle
    const requestTimeFiberRef = yield* RequestTime

    // Set initial request time
    const now = yield* DateTime.now
    yield* FiberRef.set(requestTimeFiberRef, now)
    const testRunnerContext = makeTestRunnerUserContext(org, now)

    // 1. Store organisation in the database
    yield* storeOrganisation(org)
    if (setup) {
      yield* setup
    }

    // 2. Look up the process in the database
    const normalizedProcessPath = normalizePath(processPath)
    const processes = yield* db
      .select()
      .from(dbSchema.process)
      .where(eq(dbSchema.process.path, normalizedProcessPath))
    const process = processes[0]
    if (!process) {
      return yield* new ProcessNotFoundError({
        processPath: normalizedProcessPath,
      })
    }

    // Find the process model to get start node info
    const processModel = org
      .processes()
      .find((p) => normalizePath(p.node.path) === normalizedProcessPath)
    if (!processModel) {
      return yield* new ProcessNotFoundError({
        processPath: normalizedProcessPath,
      })
    }

    const startNodes = processModel.startNodes()
    const startNode = startNodes[0]
    if (!startNode || startNodes.length !== 1) {
      return yield* new ProcessNotFoundError({
        processPath: normalizedProcessPath,
      })
    }

    const startStepPath = normalizePath(startNode.node.path)

    // 3. Start the process
    let startResult: { executionId: string }
    const completedSteps: CompletedStepRecord[] = []

    if (startNode.isSystemStep) {
      // Match production GraphQL no-input system-start path: enqueue the start
      // system step for the worker. Do not treat system-step output as form
      // input (submissionEffectSchema is undefined; outputSchema is worker-produced).
      startResult = yield* startProcessExecution(
        process.id,
        normalizedProcessPath,
        startStepPath,
        initialState ?? {},
        { enqueueStartSystemStep: true },
      )
      // Start system steps complete when the worker runs them; track after drain.
    } else {
      // Form start nodes: submissionEffectSchema is the flat submission schema.
      const startSchema = startNode.submissionEffectSchema
      if (startSchema) {
        const startData =
          initialState ?? getFormDataForStep(startStepPath, org, forms)

        startResult = yield* startProcess(
          process.id,
          normalizedProcessPath,
          startStepPath,
          startData,
          startSchema,
          // biome-ignore lint/suspicious/noExplicitAny: Form generics erased at runtime
          startNode as any,
          testRunnerContext,
        )
        completedSteps.push({
          stepPath: startStepPath,
          isSystemStep: false,
        })
      } else {
        // Zero-field form or non-system no-input start
        startResult = yield* startProcessExecution(
          process.id,
          normalizedProcessPath,
          startStepPath,
          initialState ?? {},
        )
        completedSteps.push({
          stepPath: startStepPath,
          isSystemStep: false,
        })
      }
    }

    const { executionId } = startResult

    // 4. Main drain loop
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      // Update request time for each iteration
      const iterNow = yield* DateTime.now
      yield* FiberRef.set(requestTimeFiberRef, iterNow)

      // 4a. Drain flow-execution queue
      const flowJobsProcessed = yield* drainQueue(
        "flow-execution",
        flowExecutionHandler,
      )

      // 4b. Drain system-step-execution queue
      const systemJobsProcessed = yield* drainQueue(
        "system-step-execution",
        systemStepExecutionHandler,
      )

      // Track system steps that were completed
      if (systemJobsProcessed > 0) {
        // Start system steps do not create todos; detect completion via completed job.
        if (
          startNode.isSystemStep &&
          !completedSteps.some((step) => step.stepPath === startStepPath)
        ) {
          const completedJobOps = yield* CompletedJobOperations
          const startCompleted = yield* completedJobOps.isJobCompleted(
            SYSTEM_STEP_EXECUTION_QUEUE,
            getStartedSystemStepCompletedJobId(executionId),
          )
          if (startCompleted) {
            completedSteps.push({
              stepPath: startStepPath,
              isSystemStep: true,
            })
          }
        }

        // Query completed (deleted) todos to find newly completed system steps
        const completedTodos = yield* db
          .select({
            stepPath: dbSchema.step.path,
            roleId: dbSchema.step.roleId,
          })
          .from(dbSchema.toDo)
          .innerJoin(dbSchema.flow, eq(dbSchema.toDo.flowId, dbSchema.flow.id))
          .innerJoin(
            dbSchema.step,
            eq(dbSchema.flow.targetStepId, dbSchema.step.id),
          )
          .where(
            and(
              eq(dbSchema.toDo.processExecutionId, executionId),
              eq(dbSchema.toDo._deleted, true),
            ),
          )

        // Add any system steps we haven't tracked yet
        for (const todo of completedTodos) {
          const isSystem = todo.roleId === null
          if (
            isSystem &&
            !completedSteps.some((s) => s.stepPath === todo.stepPath)
          ) {
            completedSteps.push({
              stepPath: todo.stepPath,
              isSystemStep: true,
            })
          }
        }

        // Continue draining after system step completion (may create more jobs)
        continue
      }

      // 4c. Drain event queues (just acknowledge, no processing)
      yield* drainEventQueues

      // Stop when the execution is already finished (success or failed start).
      const executionStatus = yield* db
        .select({
          finishedAt: dbSchema.processExecution.finishedAt,
        })
        .from(dbSchema.processExecution)
        .where(eq(dbSchema.processExecution.id, executionId))
      if (executionStatus[0]?.finishedAt !== null) {
        break
      }

      // 4d. Check for active form todos
      const activeTodos = yield* queryActiveTodos(executionId)

      if (activeTodos.length === 0 && flowJobsProcessed === 0) {
        // No todos, no jobs - process finished
        break
      }

      // 4e. Complete form todos
      for (const todo of activeTodos) {
        const isSystemStep = todo.roleId === null
        if (isSystemStep) {
          // System steps should be handled by drainQueue above
          // If we get here, something went wrong
          continue
        }

        // Look up the Form step
        const form = org.formByPath(todo.stepPath)
        if (!form) {
          // Not a form step - skip
          continue
        }

        // Get form data (explicit override or auto-generated)
        const formData = getFormDataForStep(todo.stepPath, org, forms)

        // Use flat submission schema (includes struct-level refinements)
        const inputSchema = form.submissionEffectSchema

        // Complete the step with the form's primary Role so audit metadata
        // records completed_by_role_id the same way GraphQL resolvers do.
        const completingRolePath = form.props.role
          ? normalizePath(form.props.role.node.path)
          : undefined

        yield* completeStep(
          todo.id,
          formData as ProcessState,
          // biome-ignore lint/suspicious/noExplicitAny: Form generics erased at runtime
          form as any,
          inputSchema,
          testRunnerContext,
          completingRolePath ? { completingRolePath } : {},
        )

        completedSteps.push({
          stepPath: todo.stepPath,
          isSystemStep: false,
        })
      }
    }

    // 5. Collect results
    // Query final process state
    const processStates = yield* db
      .select({
        state: dbSchema.processState.state,
      })
      .from(dbSchema.processExecution)
      .innerJoin(
        dbSchema.processState,
        eq(dbSchema.processExecution.processStateId, dbSchema.processState.id),
      )
      .where(eq(dbSchema.processExecution.id, executionId))

    const finalState = (processStates[0]?.state ?? {}) as Record<
      string,
      unknown
    >

    // Check if process finished
    const executions = yield* db
      .select({ finishedAt: dbSchema.processExecution.finishedAt })
      .from(dbSchema.processExecution)
      .where(eq(dbSchema.processExecution.id, executionId))

    const finished = executions[0]?.finishedAt !== null

    return {
      executionId,
      finalState,
      completedSteps,
      finished,
    } satisfies ProcessTestResult
  })

/**
 * Error thrown when a process is not found in the database or organisation.
 */
export class ProcessNotFoundError extends Data.TaggedError(
  "ProcessNotFoundError",
)<{
  readonly processPath: string
}> {}
