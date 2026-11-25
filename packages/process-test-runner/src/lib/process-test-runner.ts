import { QueueService } from "@processfocus/runtime"
import { and, eq, isNull } from "drizzle-orm"
import {
  Arbitrary,
  Clock,
  Data,
  DateTime,
  Effect,
  Option,
  Schema,
} from "effect"
import * as dbSchema from "@pf/drizzle-sqlite"
import {
  CompletedJobOperations,
  SYSTEM_STEP_EXECUTION_QUEUE,
  getStartedSystemStepCompletedJobId,
} from "@pf/graphql-db-operations"
import { storeOrganisation } from "@pf/org-to-db"
import {
  type Form,
  type OrgUnit,
  isOrgUnit,
  isRole,
  normalizePath,
} from "@pf/process"
import {
  type ExecutionIdentity,
  completeTodo,
  startProcess,
} from "@pf/process-execution"
import {
  FlowExecutionPayloadSchema,
  SystemStepExecutionPayloadSchema,
  advanceScheduledFlow,
  executeSystemStep,
} from "@pf/process-execution/worker"
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

const makeTestRunnerIdentity = (org: OrgUnit): ExecutionIdentity => ({
  session: {
    userId: "process-test-runner@example.com",
    email: "process-test-runner@example.com",
    roles: collectRolePaths(org),
    orgUnitPath: org.node.path,
    orgUnitId: org.node.path,
  },
  userId: "process-test-runner@example.com",
  subject: "process-test-runner@example.com",
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
    schema: Schema.Codec<A, I>
    handle: (
      // biome-ignore lint/suspicious/noExplicitAny: Job type erased at runtime
      job: any,
    ) => Effect.Effect<void, unknown, unknown>
  },
) =>
  Effect.gen(function* () {
    let count = 0

    // Keep claiming and processing until queue is empty
    while (true) {
      // Simulations may jump business time inside a handler. Lease elapsed time
      // must still measure actual execution, not that simulated calendar jump.
      // Anchor each claim to business time so scheduled jobs remain eligible,
      // then use the live clock's elapsed time for both claim and acknowledgement.
      const businessNow = DateTime.toEpochMillis(yield* DateTime.now)
      const liveClock = Clock.Clock.defaultValue()
      const liveStart = liveClock.monotonicTimeNanosUnsafe()
      const currentTimeNanosUnsafe = () =>
        BigInt(businessNow) * 1_000_000n +
        liveClock.monotonicTimeNanosUnsafe() -
        liveStart
      const currentTimeMillisUnsafe = () =>
        Number(currentTimeNanosUnsafe() / 1_000_000n)
      const leaseClock: Clock.Clock = Object.assign(liveClock, {
        currentTimeMillisUnsafe,
        currentTimeMillis: Effect.sync(currentTimeMillisUnsafe),
        currentTimeNanosUnsafe,
        currentTimeNanos: Effect.sync(currentTimeNanosUnsafe),
      })
      const jobOption = yield* QueueService.claim(
        queueName,
        handler.schema,
      ).pipe(Effect.provideService(Clock.Clock, leaseClock))

      if (Option.isNone(jobOption)) {
        break
      }

      const job = jobOption.value
      // Set current time for this job's database operations
      const now = yield* DateTime.now
      yield* handler.handle(job).pipe(Effect.provideService(RequestTime, now))

      // Acknowledge the job after processing
      const queueService = yield* QueueService
      yield* queueService
        .acknowledge(job.jobId, job.receipt)
        .pipe(Effect.provideService(Clock.Clock, leaseClock))

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
 * Uses Effect's schema-derived arbitrary to produce random valid data.
 */
const generateFormData = (
  form: Form,
): Effect.Effect<Record<string, unknown>, Arbitrary.SampleError> => {
  if (!form.output) return Effect.succeed({})

  const inputSchema = Schema.Struct(form.output as Schema.Struct.Fields)
  return Arbitrary.sampleEffect(Arbitrary.schema(inputSchema), {
    count: 1,
  }).pipe(Effect.map(([generatedData]) => generatedData ?? {}))
}

/**
 * Find form data override for a step, or auto-generate from schema.
 */
const getFormDataForStep = (
  stepPath: string,
  org: ProcessTestConfig["org"],
  forms: ReadonlyArray<FormEntry> | undefined,
): Effect.Effect<Record<string, unknown>, Arbitrary.SampleError> => {
  // Check for explicit override first (compare normalized paths)
  const normalizedStepPath = normalizePath(stepPath)
  const override = forms?.find(
    (f) => normalizePath(f.stepPath) === normalizedStepPath,
  )
  if (override) {
    return Effect.succeed(override.data)
  }

  // Auto-generate from schema
  const form = org.formByPath(stepPath)
  if (!form) return Effect.succeed({})
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

    // Set initial request time
    const now = yield* DateTime.now
    return yield* Effect.gen(function* () {
      const testRunnerContext = makeTestRunnerIdentity(org)

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
      const startData =
        initialState ??
        (startNode.isSystemStep || !startNode.submissionEffectSchema
          ? {}
          : yield* getFormDataForStep(startStepPath, org, forms))
      const startResult = yield* startProcess({
        processPath: normalizedProcessPath,
        input: startData,
        identity: testRunnerContext,
      })
      const completedSteps: CompletedStepRecord[] = startNode.isSystemStep
        ? []
        : [{ stepPath: startStepPath, isSystemStep: false }]

      const { executionId } = startResult

      // 4. Main drain loop
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        // Update request time for each iteration
        const iterNow = yield* DateTime.now

        // 4a. Drain flow-execution queue
        const flowJobsProcessed = yield* drainQueue("flow-execution", {
          schema: FlowExecutionPayloadSchema,
          handle: advanceScheduledFlow,
        })

        // 4b. Drain system-step-execution queue
        const systemJobsProcessed = yield* drainQueue("system-step-execution", {
          schema: SystemStepExecutionPayloadSchema,
          handle: executeSystemStep,
        })

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
            .innerJoin(
              dbSchema.flow,
              eq(dbSchema.toDo.flowId, dbSchema.flow.id),
            )
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
          const formData = yield* getFormDataForStep(todo.stepPath, org, forms)

          yield* completeTodo({
            todoId: todo.id,
            input: formData,
            actor: { kind: "authenticated", identity: testRunnerContext },
          }).pipe(Effect.provideService(RequestTime, iterNow))

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
          eq(
            dbSchema.processExecution.processStateId,
            dbSchema.processState.id,
          ),
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
    }).pipe(Effect.provideService(RequestTime, now))
  })

/**
 * Error thrown when a process is not found in the database or organisation.
 */
export class ProcessNotFoundError extends Data.TaggedError(
  "ProcessNotFoundError",
)<{
  readonly processPath: string
}> {}
