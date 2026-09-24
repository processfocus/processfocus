import { randomUUID } from "node:crypto"
import * as Otel from "@effect/opentelemetry"
import * as SqlClient from "@effect/sql/SqlClient"
import { SqlError } from "@effect/sql/SqlError"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { EnqueueError, type Payload, QueueService } from "@processfocus/runtime"
import { eq } from "drizzle-orm"
import {
  Data,
  DateTime,
  Deferred,
  Effect,
  Either,
  FiberRef,
  Layer,
  LogLevel,
  Logger,
  Metric,
  MetricState,
  Option,
  Ref,
  Schema,
} from "effect"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfigDefault,
} from "@pf/auth-local-cedar"
import {
  concurrentTransactionCommitError,
  concurrentTransactionRequested,
  transactionMode,
} from "@pf/db-info"
import * as sqliteSchema from "@pf/drizzle-sqlite"
import {
  CurrentProviderUser,
  EmailField,
  type FormValue,
  ListField,
  NumberFieldFrom,
  ProviderUserField,
  TextBlock,
  TextField,
  Wrapper,
} from "@pf/form-schema"
import {
  type UserContext,
  completeStep,
  makeBusinessMetricDimensionsLayer,
  recoverPendingExternalCompletionEnqueues,
  startProcess,
  startProcessExecution,
} from "@pf/graphql-api"
import {
  BusinessCalendarQueries,
  CompletedJobOperations,
  EXECUTION_EVENT_QUEUE,
  FLOW_EXECUTION_QUEUE,
  FlowExecutionOperations,
  SYSTEM_STEP_EXECUTION_QUEUE,
  ScheduledFlowOperations,
  StepCompletionOperations,
  UserDetails,
  encodeDelegationAudit,
  getStartedSystemStepCompletedJobId,
} from "@pf/graphql-db-operations"
import {
  ExecutionIdConflictError,
  InputValidationError,
  NotAuthorized,
  StepCompletionConflictError,
} from "@pf/graphql-schema"
import {
  completeAsyncSystemStep,
  systemStepExecutionHandler,
} from "@pf/job-handler"
import {
  ConditionEvaluator,
  Form,
  FormRuleSelf,
  FormSubmissionError,
  NodeStep,
  OrgUnit,
  Organisation,
  OrganisationProviderTest,
  Process,
  Role,
  SystemStepExecutor,
  makeConditionEvaluator,
  makeSystemStepExecutor,
  normalizePath,
} from "@pf/process"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import {
  businessMetricsOtlpUrl,
  businessMetricsPrometheusUrl,
  makeTimestampedMetricExporter,
  queryPrometheusRangeUntil,
  queryPrometheusUntil,
} from "../test-support/business-metrics"
import {
  type GraphqlDbCase,
  postgresDbCase,
  seedActiveTodo,
  sqliteDbCase,
} from "../test-support/graphql-db-matrix"
import {
  type EnqueuedJob,
  makeAuthorizationLayer as makeBaseAuthorizationLayer,
  makeQueueLayer,
} from "../test-support/queue-auth-stubs"
import { describe, expect, it } from "bun:test"

const uniqueSuffix = () => randomUUID().slice(0, 8)
const runPostgresDbSpecs =
  process.env["PF_RUNTIME_LOCAL_POSTGRES_DB_SPECS"] === "1"
const runDbEffect = <R, A, E, RExtra = never, REffect = never>(
  db: GraphqlDbCase<R>,
  enqueuedJobs: EnqueuedJob[],
  effect: Effect.Effect<A, E, REffect>,
  queueInTransaction = true,
  extraLayer?: Layer.Layer<RExtra, unknown, never>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mergeAll(
            db.layer,
            makeQueueLayer(enqueuedJobs, queueInTransaction),
          ),
          ...(extraLayer === undefined ? [] : [extraLayer]),
        ),
      ),
    ) as Effect.Effect<A, E, never>,
  )

class SimulatedCommitConflict extends Data.TaggedError(
  "SimulatedCommitConflict",
) {}

const makeConcurrentTestClient = (
  client: SqlClient.SqlClient,
  shouldConflict: (transactionAttempt: number) => boolean = () => false,
) => {
  let transactionAttempts = 0
  const withTransaction: SqlClient.SqlClient["withTransaction"] = (effect) =>
    Effect.gen(function* () {
      transactionAttempts += 1
      const transactionAttempt = transactionAttempts
      const concurrentRequested = yield* FiberRef.get(
        concurrentTransactionRequested,
      )
      const conflict = concurrentRequested && shouldConflict(transactionAttempt)
      const bodyResult = yield* Ref.make(
        Option.none<Effect.Effect.Success<typeof effect>>(),
      )
      const commitError = new SqlError({
        message: "Failed to commit transaction",
        cause: new Error("Tursodb error: Write-write conflict"),
      })

      return yield* client
        .withTransaction(
          FiberRef.set(
            transactionMode,
            concurrentRequested ? "concurrent" : "immediate",
          ).pipe(
            Effect.zipRight(effect),
            Effect.tap((result) => Ref.set(bodyResult, Option.some(result))),
            Effect.tap(() =>
              conflict
                ? FiberRef.set(concurrentTransactionCommitError, commitError)
                : Effect.void,
            ),
            Effect.flatMap((result) =>
              conflict
                ? Effect.fail(new SimulatedCommitConflict())
                : Effect.succeed(result),
            ),
          ),
        )
        .pipe(
          Effect.catchTag("SimulatedCommitConflict", () =>
            Ref.get(bodyResult).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.dieMessage(
                      "Simulated commit conflict missing transaction result",
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
        )
    })
  const concurrentClient = new Proxy(client, {
    get: (target, property, receiver) =>
      property === "withTransaction"
        ? withTransaction
        : Reflect.get(target, property, receiver),
  })

  return {
    client: concurrentClient,
    transactionAttempts: () => transactionAttempts,
  }
}

/** Process-ops defaults: allow step/todo/public completion; override flags as needed. */
const makeAuthorizationLayer = ({
  canModifyField = false,
  canActOnBehalfOf = false,
  canCompletePublicTodo = true,
}: {
  readonly canModifyField?: boolean
  readonly canActOnBehalfOf?: boolean
  readonly canCompletePublicTodo?: boolean
} = {}) =>
  makeBaseAuthorizationLayer({
    canCompleteStep: () => Effect.succeed(true),
    canCompleteTodo: () => Effect.succeed(true),
    canCompletePublicTodo: () => Effect.succeed(canCompletePublicTodo),
    canModifyField: () => Effect.succeed(canModifyField),
    canActOnBehalfOf: () => Effect.succeed(canActOnBehalfOf),
  })

const makeContext = (
  email: string,
  rolePath: string,
  orgUnitPath: string,
): UserContext => ({
  _requestTime: DateTime.unsafeMake("2026-04-06T10:00:00.000Z"),
  _userDetails: { by: email, id: email } as UserContext["_userDetails"],
  jwt: {
    mode: "access",
    type: "user",
    properties: {
      userId: email,
      email,
      roles: [rolePath],
      orgUnitPath,
      orgUnitId: orgUnitPath,
    },
    aud: "graphql-api",
    iss: "http://localhost:4020",
    sub: email,
    exp: 0,
    iat: 0,
  },
  userId: email,
})

const makeServiceAccountContext = (
  rolePath: string,
  orgUnitPath: string,
): UserContext => ({
  _requestTime: DateTime.unsafeMake("2026-04-06T10:00:00.000Z"),
  _userDetails: {
    by: "ci-client",
    id: "ci-client",
  } as UserContext["_userDetails"],
  jwt: {
    mode: "access",
    type: "user",
    properties: {
      userId: "ci-client",
      clientId: "ci-client",
      roles: [rolePath],
      orgUnitPath,
      orgUnitId: orgUnitPath,
    },
    aud: "graphql-api",
    iss: "http://localhost:4020",
    sub: "ci-client",
    exp: 0,
    iat: 0,
  },
  userId: "ci-client",
})

const makeStartOrganisation = (suffix: string, systemStart = false) => {
  const org = new Organisation({ name: `Test Org ${suffix}` })
  const operations = new OrgUnit(org, `Operations ${suffix}`, {
    name: `Operations ${suffix}`,
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const process = new Process(operations, `start-${suffix}`, {
    name: `Start ${suffix}`,
    purpose: "Test process execution starts",
  })

  if (systemStart) {
    const hello = new NodeStep(process, "Hello", {
      input: () => Effect.succeed({}),
      output: {},
      execute: () => Effect.succeed({}),
    })
    process.start(hello).end()
    return {
      org,
      orgUnitPath: normalizePath(operations.node.path),
      rolePath: normalizePath(employee.node.path),
      processPath: normalizePath(process.node.path),
      startStepPath: normalizePath(hello.node.path),
    }
  }

  const submit = new Form(process, "Submit", {
    role: employee,
    form: () => ({}),
  })
  process.start(submit).end()
  return {
    org,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(submit.node.path),
  }
}

const makeTwoProcessStartOrganisation = (suffix: string) => {
  const org = new Organisation({ name: `Two Process Org ${suffix}` })
  const operations = new OrgUnit(org, `Operations ${suffix}`, {
    name: `Operations ${suffix}`,
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const firstProcess = new Process(operations, `start-a-${suffix}`, {
    name: `Start A ${suffix}`,
    purpose: "First process for execution-id conflict",
  })
  const secondProcess = new Process(operations, `start-b-${suffix}`, {
    name: `Start B ${suffix}`,
    purpose: "Second process for execution-id conflict",
  })
  const firstSubmit = new Form(firstProcess, "Submit", {
    role: employee,
    form: () => ({}),
  })
  const secondSubmit = new Form(secondProcess, "Submit", {
    role: employee,
    form: () => ({}),
  })
  firstProcess.start(firstSubmit).end()
  secondProcess.start(secondSubmit).end()

  return {
    org,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    firstProcessPath: normalizePath(firstProcess.node.path),
    firstStartStepPath: normalizePath(firstSubmit.node.path),
    secondProcessPath: normalizePath(secondProcess.node.path),
    secondStartStepPath: normalizePath(secondSubmit.node.path),
  }
}

const makeRestrictedStartOrganisation = (suffix: string) => {
  const org = new Organisation({ name: `Restricted Start Org ${suffix}` })
  const operations = new OrgUnit(org, `Restricted Start Ops ${suffix}`, {
    name: `Restricted Start Ops ${suffix}`,
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const manager = new Role(operations, "manager", { name: "Manager" })
  const process = new Process(operations, `restricted-start-${suffix}`, {
    name: `Restricted Start ${suffix}`,
    purpose: "Test restricted process starts",
  })
  const submit = new Form(process, "Submit", {
    role: employee,
    form: () => ({
      title: TextField(),
      requestedFor: ProviderUserField({
        default: CurrentProviderUser,
        permission: { modify: manager },
      }),
    }),
  })
  process.start(submit).end()

  return {
    form: submit,
    org,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(submit.node.path),
  }
}

const makeWrappedRestrictedStartOrganisation = (suffix: string) => {
  const org = new Organisation({
    name: `Wrapped Restricted Start Org ${suffix}`,
  })
  const operations = new OrgUnit(
    org,
    `Wrapped Restricted Start Ops ${suffix}`,
    {
      name: `Wrapped Restricted Start Ops ${suffix}`,
      type: "department",
    },
  )
  const employee = new Role(operations, "employee", { name: "Employee" })
  const manager = new Role(operations, "manager", { name: "Manager" })
  const process = new Process(
    operations,
    `wrapped-restricted-start-${suffix}`,
    {
      name: `Wrapped Restricted Start ${suffix}`,
      purpose: "Test wrapped restricted process starts",
    },
  )
  const submit = new Form(process, "Submit", {
    role: employee,
    form: () => ({
      details: Wrapper({
        title: TextField(),
        requestedFor: ProviderUserField({
          default: CurrentProviderUser,
          permission: { modify: manager },
        }),
      }),
    }),
  })
  process.start(submit).end()

  return {
    form: submit,
    org,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    managerRolePath: normalizePath(manager.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(submit.node.path),
  }
}

const makeEmbeddedStartOrganisation = (suffix: string) => {
  const org = new Organisation({ name: `Embedded Start Org ${suffix}` })
  const operations = new OrgUnit(org, `Embedded Start Ops ${suffix}`, {
    name: `Embedded Start Ops ${suffix}`,
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const process = new Process(operations, `embedded-start-${suffix}`, {
    name: `Embedded Start ${suffix}`,
    purpose: "Test embedded starts",
  })
  const submit = new Form(process, "Submit", {
    role: employee,
    embed: {
      externalParticipantEmailField: "email",
      sites: ["https://example.com"],
      thankYou: "Thanks",
    },
    form: () => ({
      email: EmailField(),
      title: TextField(),
    }),
  })
  process.start(submit).end()

  return {
    form: submit,
    org,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(submit.node.path),
  }
}

const makeOptionalSubmissionOrganisation = (
  suffix: string,
  defaultValue: string | undefined,
  lazy: boolean,
) => {
  const org = new Organisation({ name: `Optional submissions ${suffix}` })
  const operations = new OrgUnit(org, "ops", {
    name: "Operations",
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const process = new Process(operations, "optional", {
    name: "Optional",
    purpose: "Verify submission contracts",
  })
  const children = {
    edit: TextField(),
    display: TextField({ readOnly: true }),
    help: TextBlock("Help"),
  }
  const fields = (resolved: FormValue<string> | undefined) => ({
    count: Schema.optionalWith(
      NumberFieldFrom(
        Schema.NumberFromString,
        resolved === undefined ? {} : { default: resolved },
      ),
      { default: () => 5 },
    ),
    leaf: Schema.optional(TextField({ readOnly: true })),
    nested: Schema.optional(Schema.Struct(children)),
    list: Schema.optional(ListField(children)),
  })
  const start = new Form(process, "Start", {
    role: employee,
    form: ({ value }) =>
      fields(lazy ? value(() => defaultValue) : defaultValue),
  })
  const flow = process.start(start)
  const complete = new Form(flow, "Complete", {
    role: employee,
    form: ({ value }) =>
      fields(lazy ? value(() => defaultValue) : defaultValue),
  })
  flow.next(complete).end()
  return {
    org,
    start,
    complete,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(start.node.path),
    todoStepPath: normalizePath(complete.node.path),
  }
}

const makeRuleStartOrganisation = (suffix: string) => {
  const org = new Organisation({ name: `Rule Start Org ${suffix}` })
  const operations = new OrgUnit(org, `Rule Start Ops ${suffix}`, {
    name: `Rule Start Ops ${suffix}`,
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const process = new Process(operations, `rule-start-${suffix}`, {
    name: `Rule Start ${suffix}`,
    purpose: "Test form rule process starts",
  })
  const submit = new Form(process, "Submit", {
    role: employee,
    form: ({ value }) => ({
      status: TextField(),
      details: Schema.optional(TextField()),
      disabledDefault: Schema.optional(
        TextField({
          default: value(
            (_state, ctx) =>
              ctx.process.startedAt ? "server default" : "unreachable",
            "server default",
          ),
        }),
      ),
      disabledRequired: Schema.optional(TextField()),
      section: Schema.optional(
        Schema.Struct({ inheritedDisabled: Schema.optional(TextField()) }),
      ),
      alwaysRequired: TextField(),
      choices: Wrapper({
        category: Schema.optional(Schema.Literal("Member", "Guest")),
      }),
      approvers: Schema.optional(ListField({ name: TextField() })),
    }),
  }).rules((value, rule) => [
    rule.when(value.status.equals("hide")).effects({
      details: { hidden: true },
    }),
    rule.when(value.status.equals("hide-choice-wrapper")).effects({
      choices: { [FormRuleSelf]: { hidden: true } },
    }),
    rule.when(value.status.equals("disable-choice-wrapper")).effects({
      choices: { [FormRuleSelf]: { disabled: true } },
    }),
    rule.when(value.status.equals("hide-disabled")).effects({
      details: { hidden: true, disabled: true },
    }),
    rule.when(value.status.equals("show")).effects({
      details: { required: true },
    }),
    rule.when(value.status.equals("needs-list")).effects({
      approvers: { required: true },
    }),
    rule.when(value.status.equals("loosen-static")).effects({
      alwaysRequired: { required: false },
    }),
    rule.when(value.status.equals("invalid-model-state")).effects({
      alwaysRequired: { hidden: true },
    }),
    rule.when(value.status.equals("disable-default")).effects({
      disabledDefault: { disabled: true },
    }),
    rule.when(value.status.equals("disable-required-missing")).effects({
      disabledRequired: { disabled: true, required: true },
    }),
    rule.when(value.status.equals("disable-section")).effects({
      section: { disabled: true },
    }),
  ])
  process.start(submit).end()

  return {
    form: submit,
    org,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(submit.node.path),
  }
}

const makePartialDefaultsOrganisation = (suffix: string, lazy: boolean) => {
  const org = new Organisation({ name: `Partial defaults ${suffix}` })
  const operations = new OrgUnit(org, "ops", {
    name: "Operations",
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const process = new Process(operations, "partial-defaults", {
    name: "Partial defaults",
    purpose: "Verify nested default precedence",
  })
  const fields = (editDefault: FormValue<string>) => ({
    mode: TextField(),
    section: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          edit: Schema.optional(TextField({ default: editDefault })),
          keep: Schema.optional(TextField({ default: "keep default" })),
          details: Schema.optional(TextField({ default: "details default" })),
        }),
      ),
    ),
    rows: Schema.optional(
      ListField({ edit: TextField() }, { default: [{ edit: "list default" }] }),
    ),
  })
  const start = new Form(process, "Start", {
    role: employee,
    form: ({ value }) =>
      fields(lazy ? value(() => "edit default") : "edit default"),
  }).rules(() => [
    {
      condition: {
        _tag: "equals",
        left: { _tag: "field", path: ["mode"] },
        right: { _tag: "literal", value: "locked" },
      },
      effects: [
        { target: ["section", "edit"], state: { disabled: true } },
        { target: ["section", "details"], state: { hidden: true } },
      ],
    },
  ])
  const flow = process.start(start)
  const complete = new Form(flow, "Complete", {
    role: employee,
    form: ({ value }) =>
      fields(lazy ? value(() => "edit default") : "edit default"),
  }).rules(() => start.authoritativeFormRules())
  flow.next(complete).end()
  return {
    org,
    start,
    complete,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(start.node.path),
    todoStepPath: normalizePath(complete.node.path),
  }
}

const makeRuleTodoOrganisation = (suffix: string) => {
  const org = new Organisation({ name: `Rule Todo Org ${suffix}` })
  const operations = new OrgUnit(org, `Rule Todo Ops ${suffix}`, {
    name: `Rule Todo Ops ${suffix}`,
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const process = new Process(operations, `rule-todo-${suffix}`, {
    name: `Rule Todo ${suffix}`,
    purpose: "Test form rule todo completions",
  })
  const start = new NodeStep(process, "Start", {
    input: () => Effect.succeed({}),
    output: {},
    execute: () => Effect.succeed({}),
  })
  const startFlow = process.start(start)
  const submit = new Form(startFlow, "Submit", {
    role: employee,
    form: ({ value }) => ({
      status: TextField(),
      details: Schema.optional(TextField()),
      originalOnly: Schema.optional(
        TextField({ default: value((_state, ctx) => ctx.process.executionId) }),
      ),
      disabledRequired: Schema.optional(TextField()),
      section: Schema.optional(
        Schema.Struct({ inheritedDisabled: Schema.optional(TextField()) }),
      ),
      alwaysRequired: TextField(),
      approvers: Schema.optional(ListField({ name: TextField() })),
    }),
  }).rules((value, rule) => [
    rule.when(value.status.equals("hide")).effects({
      details: { hidden: true },
    }),
    rule.when(value.status.equals("hide-disabled")).effects({
      details: { hidden: true, disabled: true },
    }),
    rule.when(value.status.equals("show")).effects({
      details: { required: true },
    }),
    rule.when(value.status.equals("needs-list")).effects({
      approvers: { required: true },
    }),
    rule.when(value.status.equals("invalid-model-state")).effects({
      alwaysRequired: { hidden: true },
    }),
    rule.when(value.status.equals("disable-original")).effects({
      originalOnly: { disabled: true },
    }),
    rule.when(value.status.equals("disable-required-missing")).effects({
      disabledRequired: { disabled: true, required: true },
    }),
    rule.when(value.status.equals("disable-section")).effects({
      section: { disabled: true },
    }),
    {
      condition: {
        _tag: "equals",
        left: { _tag: "field", path: ["status"] },
        right: { _tag: "literal", value: "disable-list-child" },
      },
      effects: [{ target: ["approvers", "name"], state: { disabled: true } }],
    },
  ])
  startFlow.next(submit).end()

  return {
    form: submit,
    org,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(start.node.path),
    todoStepPath: normalizePath(submit.node.path),
  }
}

const makeNestedRuleStartOrganisation = (suffix: string) => {
  const org = new Organisation({ name: `Nested Rule Start Org ${suffix}` })
  const operations = new OrgUnit(org, `Nested Rule Start Ops ${suffix}`, {
    name: `Nested Rule Start Ops ${suffix}`,
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const process = new Process(operations, `nested-rule-start-${suffix}`, {
    name: `Nested Rule Start ${suffix}`,
    purpose: "Test nested form rule process starts",
  })
  const submit = new Form(process, "Submit", {
    role: employee,
    form: () => ({
      section: Schema.Struct({
        status: TextField(),
        details: Schema.optional(TextField()),
        alwaysRequired: TextField(),
      }),
    }),
  }).rules((value, rule) => [
    rule.when(value.section.status.equals("hide-child")).effects({
      section: { details: { hidden: true } },
    }),
    rule.when(value.section.status.equals("hide-parent")).effects({
      section: { [FormRuleSelf]: { hidden: true } },
    }),
  ])
  process.start(submit).end()

  return {
    form: submit,
    org,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(submit.node.path),
  }
}

const makeHiddenProviderUserRuleStartOrganisation = (suffix: string) => {
  const org = new Organisation({ name: `Hidden Provider Rule Org ${suffix}` })
  const operations = new OrgUnit(org, `Hidden Provider Rule Ops ${suffix}`, {
    name: `Hidden Provider Rule Ops ${suffix}`,
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const process = new Process(operations, `hidden-provider-rule-${suffix}`, {
    name: `Hidden Provider Rule ${suffix}`,
    purpose: "Test hidden provider-user rule starts",
  })
  const submit = new Form(process, "Submit", {
    role: employee,
    form: () => ({
      status: TextField(),
      requestedFor: Schema.optional(ProviderUserField()),
    }),
  }).rules((value, rule) => [
    rule.when(value.status.equals("hide")).effects({
      requestedFor: { hidden: true },
    }),
  ])
  process.start(submit).end()

  return {
    form: submit,
    org,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(submit.node.path),
  }
}

const makeRestrictedTodoOrganisation = (suffix: string) => {
  const org = new Organisation({ name: `Restricted Todo Org ${suffix}` })
  const operations = new OrgUnit(org, `Restricted Todo Ops ${suffix}`, {
    name: `Restricted Todo Ops ${suffix}`,
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const manager = new Role(operations, "manager", { name: "Manager" })
  const process = new Process(operations, `restricted-todo-${suffix}`, {
    name: `Restricted Todo ${suffix}`,
    purpose: "Test restricted todo completions",
  })
  const start = new NodeStep(process, "Start", {
    input: () => Effect.succeed({}),
    output: {},
    execute: () => Effect.succeed({}),
  })
  const startFlow = process.start(start)
  const submit = new Form(startFlow, "Submit", {
    role: employee,
    form: () => ({
      title: TextField(),
      requestedFor: ProviderUserField({
        default: CurrentProviderUser,
        permission: { modify: manager },
      }),
    }),
  })
  startFlow.next(submit).end()

  return {
    form: submit,
    org,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(start.node.path),
    todoStepPath: normalizePath(submit.node.path),
  }
}

const makeWrappedRestrictedTodoOrganisation = (suffix: string) => {
  const org = new Organisation({
    name: `Wrapped Restricted Todo Org ${suffix}`,
  })
  const operations = new OrgUnit(org, `Wrapped Restricted Todo Ops ${suffix}`, {
    name: `Wrapped Restricted Todo Ops ${suffix}`,
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const manager = new Role(operations, "manager", { name: "Manager" })
  const process = new Process(operations, `wrapped-restricted-todo-${suffix}`, {
    name: `Wrapped Restricted Todo ${suffix}`,
    purpose: "Test wrapped restricted todo completions",
  })
  const start = new NodeStep(process, "Start", {
    input: () => Effect.succeed({}),
    output: {},
    execute: () => Effect.succeed({}),
  })
  const startFlow = process.start(start)
  const submit = new Form(startFlow, "Submit", {
    role: employee,
    form: () => ({
      details: Wrapper({
        title: TextField(),
        requestedFor: ProviderUserField({
          default: CurrentProviderUser,
          permission: { modify: manager },
        }),
      }),
    }),
  })
  startFlow.next(submit).end()

  return {
    form: submit,
    org,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    managerRolePath: normalizePath(manager.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(start.node.path),
    todoStepPath: normalizePath(submit.node.path),
  }
}

const makeNestedProviderUserTodoOrganisation = (suffix: string) => {
  const org = new Organisation({ name: `Nested Todo Org ${suffix}` })
  const operations = new OrgUnit(org, `Nested Todo Ops ${suffix}`, {
    name: `Nested Todo Ops ${suffix}`,
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const process = new Process(operations, `nested-todo-${suffix}`, {
    name: `Nested Todo ${suffix}`,
    purpose: "Test nested provider user completions",
  })
  const start = new NodeStep(process, "Start", {
    input: () => Effect.succeed({}),
    output: {},
    execute: () => Effect.succeed({}),
  })
  const startFlow = process.start(start)
  const submit = new Form(startFlow, "Submit", {
    role: employee,
    form: () => ({
      approvers: ListField({ requestedFor: ProviderUserField() }),
    }),
  })
  startFlow.next(submit).end()

  return {
    form: submit,
    org,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(start.node.path),
    todoStepPath: normalizePath(submit.node.path),
  }
}

const makeUnionProviderUserTodoOrganisation = (suffix: string) => {
  const org = new Organisation({ name: `Union Todo Org ${suffix}` })
  const operations = new OrgUnit(org, `Union Todo Ops ${suffix}`, {
    name: `Union Todo Ops ${suffix}`,
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const process = new Process(operations, `union-todo-${suffix}`, {
    name: `Union Todo ${suffix}`,
    purpose: "Test union provider user completions",
  })
  const start = new NodeStep(process, "Start", {
    input: () => Effect.succeed({}),
    output: {},
    execute: () => Effect.succeed({}),
  })
  const startFlow = process.start(start)
  const submit = new Form(startFlow, "Submit", {
    role: employee,
    form: () => ({
      target: Schema.Union(
        Schema.Struct({
          kind: Schema.Literal("provider-user"),
          requestedFor: ProviderUserField(),
        }),
        Schema.Struct({
          kind: Schema.Literal("note"),
          requestedFor: TextField(),
        }),
      ),
    }),
  })
  startFlow.next(submit).end()

  return {
    form: submit,
    org,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(start.node.path),
    todoStepPath: normalizePath(submit.node.path),
  }
}

const makeForEachTodoOrganisation = (suffix: string) => {
  const org = new Organisation({ name: `For Each Todo Org ${suffix}` })
  const operations = new OrgUnit(org, `For Each Todo Ops ${suffix}`, {
    name: `For Each Todo Ops ${suffix}`,
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const process = new Process(operations, `for-each-todo-${suffix}`, {
    name: `For Each Todo ${suffix}`,
    purpose: "Test forEach todo completions",
  })
  const start = new NodeStep(process, "Start", {
    input: () => Effect.succeed({}),
    output: {},
    execute: () => Effect.succeed({}),
  })
  const startFlow = process.start(start)
  const submit = new Form(startFlow, "Submit", {
    role: employee,
    forEach: { items: () => Effect.succeed([{ id: "item-1" }]) },
    form: () => ({ title: TextField() }),
  })
  startFlow.next(submit).end()

  return {
    form: submit,
    org,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(start.node.path),
    todoStepPath: normalizePath(submit.node.path),
  }
}

const makeSupportingRoleStartOrganisation = (suffix: string) => {
  const org = new Organisation({ name: `Supporting Role Start Org ${suffix}` })
  const operations = new OrgUnit(org, `Supporting Role Start Ops ${suffix}`, {
    name: `Supporting Role Start Ops ${suffix}`,
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const manager = new Role(operations, "manager", { name: "Manager" })
  const process = new Process(operations, `sr-start-${suffix}`, {
    name: `SR Start ${suffix}`,
    purpose: "Test supporting role completions",
  })
  const submit = new Form(process, "Submit", {
    role: employee,
    supportingRoles: [manager],
    form: () => ({ title: TextField() }),
  })
  process.start(submit).end()
  return {
    org,
    form: submit,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    supportingRolePath: normalizePath(manager.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(submit.node.path),
  }
}

const makeSupportingRoleTodoOrganisation = (suffix: string) => {
  const org = new Organisation({ name: `Supporting Role Todo Org ${suffix}` })
  const operations = new OrgUnit(org, `Supporting Role Todo Ops ${suffix}`, {
    name: `Supporting Role Todo Ops ${suffix}`,
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const manager = new Role(operations, "manager", { name: "Manager" })
  const process = new Process(operations, `sr-todo-${suffix}`, {
    name: `SR Todo ${suffix}`,
    purpose: "Test supporting role todo completions",
  })
  const start = new NodeStep(process, "Start", {
    input: () => Effect.succeed({}),
    output: {},
    execute: () => Effect.succeed({}),
  })
  const startFlow = process.start(start)
  const submit = new Form(startFlow, "Submit", {
    role: employee,
    supportingRoles: [manager],
    form: () => ({ title: TextField() }),
  })
  startFlow.next(submit).end()
  return {
    org,
    form: submit,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    supportingRolePath: normalizePath(manager.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(start.node.path),
    todoStepPath: normalizePath(submit.node.path),
  }
}

const makeOverlappingTodoOrganisation = (suffix: string) => {
  const org = new Organisation({ name: `Overlapping Todo Org ${suffix}` })
  const operations = new OrgUnit(org, `Overlapping Todo Ops ${suffix}`, {
    name: `Overlapping Todo Ops ${suffix}`,
    type: "department",
  })
  const employee = new Role(operations, "employee", { name: "Employee" })
  const process = new Process(operations, `overlapping-todo-${suffix}`, {
    name: `Overlapping Todo ${suffix}`,
    purpose: "Test overlapping todo completions",
  })
  const start = new NodeStep(process, "Start", {
    input: () => Effect.succeed({}),
    output: {},
    execute: () => Effect.succeed({}),
  })
  const startFlow = process.start(start)
  const givenName = new Form(startFlow, "Given Name", {
    role: employee,
    form: () => ({ givenName: TextField() }),
  })
  const familyName = new Form(startFlow, "Family Name", {
    role: employee,
    form: () => ({ familyName: TextField() }),
  })
  startFlow.next(givenName).end()
  startFlow.next(familyName).end()

  return {
    org,
    givenName,
    familyName,
    orgUnitPath: normalizePath(operations.node.path),
    rolePath: normalizePath(employee.node.path),
    processPath: normalizePath(process.node.path),
    startStepPath: normalizePath(start.node.path),
    givenNameStepPath: normalizePath(givenName.node.path),
    familyNameStepPath: normalizePath(familyName.node.path),
  }
}

const seedStartOrganisation = <R>(
  db: GraphqlDbCase<R>,
  suffix: string,
  systemStart = false,
) =>
  Effect.gen(function* () {
    const seed = makeStartOrganisation(suffix, systemStart)
    yield* db.storeOrganisation(seed.org)
    yield* db.ensureProviderUser({
      email: "employee@example.com",
      rolePaths: [seed.rolePath],
      orgUnitPath: seed.orgUnitPath,
    })
    const processId = yield* db.getProcessIdByPath(seed.processPath)
    const stepId = yield* db.getStepIdByPath(seed.startStepPath)
    return { ...seed, processId, stepId }
  })

const seedTwoProcessStartOrganisation = <R>(
  db: GraphqlDbCase<R>,
  suffix: string,
) =>
  Effect.gen(function* () {
    const seed = makeTwoProcessStartOrganisation(suffix)
    yield* db.storeOrganisation(seed.org)
    yield* db.ensureProviderUser({
      email: "employee@example.com",
      rolePaths: [seed.rolePath],
      orgUnitPath: seed.orgUnitPath,
    })
    const firstProcessId = yield* db.getProcessIdByPath(seed.firstProcessPath)
    const secondProcessId = yield* db.getProcessIdByPath(seed.secondProcessPath)
    return { ...seed, firstProcessId, secondProcessId }
  })

it("persists delegated GraphQL process starts with owner FKs and immutable generation audit", async () => {
  const seed = makeRestrictedStartOrganisation(`delegation-${uniqueSuffix()}`)
  const context = makeContext(
    "employee@example.com",
    seed.rolePath,
    seed.orgUnitPath,
  )
  if (!context.jwt || !("email" in context.jwt.properties))
    throw new Error("Missing provider user fixture")
  context.jwt = {
    ...context.jwt,
    type: "providerUser",
    properties: {
      ...context.jwt.properties,
      delegation: {
        id: "dlg-start",
        generationId: "dsg-start",
        name: "process-agent",
        expiresAt: 1_900_000_000_000,
      },
    },
  }
  const by = encodeDelegationAudit({
    version: 1,
    ownerUserId: "employee@example.com",
    ownerEmail: "employee@example.com",
    delegationId: "dlg-start",
    generationId: "dsg-start",
    name: "process-agent",
  })
  context._userDetails = { by, id: "employee@example.com" }
  await runDbEffect(
    sqliteDbCase,
    [],
    Effect.gen(function* () {
      yield* sqliteDbCase.storeOrganisation(seed.org)
      yield* sqliteDbCase.ensureProviderUser({
        email: "employee@example.com",
        rolePaths: [seed.rolePath],
        orgUnitPath: seed.orgUnitPath,
      })
      const processId = yield* sqliteDbCase.getProcessIdByPath(seed.processPath)
      const ref = yield* UserDetails
      const started = yield* startProcess(
        processId,
        seed.processPath,
        seed.startStepPath,
        { title: "Delegated request" },
        seed.form.submissionEffectSchema,
        seed.form,
        context,
      ).pipe(Effect.locally(ref, context._userDetails))
      const db = yield* TypedSqliteDrizzle
      const executions = yield* db
        .select()
        .from(sqliteSchema.processExecution)
        .where(eq(sqliteSchema.processExecution.id, started.executionId))
      expect(executions[0]?.createdBy).toBe(by)
      const states = yield* db
        .select()
        .from(sqliteSchema.processState)
        .where(eq(sqliteSchema.processState.id, executions[0]!.processStateId))
      expect(states[0]?.startedByUserId).toBe("employee@example.com")
      expect(states[0]?.createdBy).toBe(by)
      const handoffs = yield* db
        .select()
        .from(sqliteSchema.scheduledFlow)
        .where(
          eq(
            sqliteSchema.scheduledFlow.processExecutionId,
            started.executionId,
          ),
        )
      expect(handoffs[0]?.createdBy).toBe(by)
    }),
    true,
    LocalCedarAuthorizationLive.pipe(Layer.provide(LocalCedarConfigDefault())),
  )
})

it("persists delegated Todo completion and its outgoing handoff with owner FKs", async () => {
  const seed = makeRuleTodoOrganisation(`delegation-todo-${uniqueSuffix()}`)
  const context = makeContext(
    "employee@example.com",
    seed.rolePath,
    seed.orgUnitPath,
  )
  if (!context.jwt || !("email" in context.jwt.properties))
    throw new Error("Missing provider user fixture")
  context.jwt = {
    ...context.jwt,
    type: "providerUser",
    properties: {
      ...context.jwt.properties,
      delegation: {
        id: "dlg-todo",
        generationId: "dsg-todo",
        name: "todo-agent",
        expiresAt: 1_900_000_000_000,
      },
    },
  }
  const by = encodeDelegationAudit({
    version: 1,
    ownerUserId: "employee@example.com",
    ownerEmail: "employee@example.com",
    delegationId: "dlg-todo",
    generationId: "dsg-todo",
    name: "todo-agent",
  })
  context._userDetails = { by, id: "employee@example.com" }
  await runDbEffect(
    sqliteDbCase,
    [],
    Effect.gen(function* () {
      const active = yield* seedActiveTodo(sqliteDbCase, {
        organisation: seed.org,
        orgUnitPath: seed.orgUnitPath,
        rolePath: seed.rolePath,
        processPath: seed.processPath,
        startStepPath: seed.startStepPath,
        todoStepPath: seed.todoStepPath,
        state: {},
      })
      const ref = yield* UserDetails
      yield* completeStep(
        active.todoId,
        { status: "hide", alwaysRequired: "present" },
        seed.form,
        seed.form.submissionEffectSchema,
        context,
      ).pipe(Effect.locally(ref, context._userDetails))
      const db = yield* TypedSqliteDrizzle
      const todos = yield* db
        .select()
        .from(sqliteSchema.toDo)
        .where(eq(sqliteSchema.toDo.id, active.todoId))
      expect(todos[0]?.completedByUserId).toBe("employee@example.com")
      expect(todos[0]?.updatedBy).toBe(by)
      const handoffs = yield* db
        .select()
        .from(sqliteSchema.scheduledFlow)
        .where(
          eq(sqliteSchema.scheduledFlow.processExecutionId, active.executionId),
        )
      expect(handoffs[0]?.createdBy).toBe(by)
    }),
    true,
    LocalCedarAuthorizationLive.pipe(Layer.provide(LocalCedarConfigDefault())),
  )
})

const runSuite = <R>(db: GraphqlDbCase<R>) => {
  describe(`startProcess and completeStep (${db.name})`, () => {
    it("rejects explicit restricted start fields before writing process state", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRestrictedStartOrganisation(
        `${db.name}-restricted-start-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          const error = yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            { title: "Request", requestedFor: "other@example.com" },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          ).pipe(Effect.flip)
          const processStates = yield* db.getProcessStatesByProcessId(processId)
          return { error, processStates }
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result.error).toBeInstanceOf(NotAuthorized)
      if (!(result.error instanceof NotAuthorized)) {
        throw result.error
      }
      expect(result.error.resource).toBe(`${seed.startStepPath}/requestedFor`)
      expect(result.processStates).toEqual([])
      expect(enqueuedJobs).toEqual([])
    })

    for (const lazy of [false, true]) {
      for (const phase of ["start", "completion"] as const) {
        for (const scenario of [
          {
            name: "partial object and replaced list",
            input: {
              mode: "edit",
              section: { edit: "client" },
              rows: [{ edit: "client row" }],
            },
            expected: {
              mode: "edit",
              section: {
                edit: "client",
                keep: "keep default",
                details: "details default",
              },
              rows: [{ edit: "client row" }],
            },
          },
          {
            name: "omitted nested keys and empty list",
            input: { mode: "edit", section: {}, rows: [] },
            expected: {
              mode: "edit",
              section: {
                edit: "edit default",
                keep: "keep default",
                details: "details default",
              },
              rows: [],
            },
          },
          {
            name: "explicit null without backfilling defaults",
            input: { mode: "edit", section: null, rows: [] },
            // Completion uses JSON Merge Patch: an explicit null deletes the existing key.
            expected:
              phase === "start"
                ? { mode: "edit", section: null, rows: [] }
                : { mode: "edit", rows: [] },
          },
          {
            name: "disabled original and hidden default",
            input: {
              mode: "locked",
              section: { edit: "tampered", details: "tampered" },
              rows: [],
            },
            expected: {
              mode: "locked",
              section: {
                edit: phase === "start" ? "edit default" : "original",
                keep: "keep default",
              },
              rows: [],
            },
          },
        ]) {
          it(`preserves ${lazy ? "lazy" : "static"} ${scenario.name} at ${phase}`, async () => {
            const seed = makePartialDefaultsOrganisation(uniqueSuffix(), lazy)
            const context = makeContext(
              "employee@example.com",
              seed.rolePath,
              seed.orgUnitPath,
            )
            const stored = await runDbEffect(
              db,
              [],
              Effect.gen(function* () {
                if (phase === "start") {
                  yield* db.storeOrganisation(seed.org)
                  yield* db.ensureProviderUser({
                    email: "employee@example.com",
                    rolePaths: [seed.rolePath],
                    orgUnitPath: seed.orgUnitPath,
                  })
                  const processId = yield* db.getProcessIdByPath(
                    seed.processPath,
                  )
                  const started = yield* startProcess(
                    processId,
                    seed.processPath,
                    seed.startStepPath,
                    scenario.input,
                    seed.start.submissionEffectSchema,
                    seed.start,
                    context,
                  )
                  return yield* db.getProcessStateByExecutionId(
                    started.executionId,
                  )
                }
                const active = yield* seedActiveTodo(db, {
                  organisation: seed.org,
                  orgUnitPath: seed.orgUnitPath,
                  rolePath: seed.rolePath,
                  processPath: seed.processPath,
                  startStepPath: seed.startStepPath,
                  todoStepPath: seed.todoStepPath,
                  state: {
                    section: { edit: "original", details: "old hidden" },
                  },
                })
                yield* completeStep(
                  active.todoId,
                  scenario.input,
                  seed.complete,
                  seed.complete.submissionEffectSchema,
                  context,
                )
                return yield* db.getProcessStateByExecutionId(
                  active.executionId,
                )
              }),
              true,
              makeAuthorizationLayer(),
            )
            expect(stored?.state).toEqual(scenario.expected)
          })
        }
        for (const scenario of [
          {
            name: "resolved default",
            defaultValue: "12",
            input: {},
            expected: 12,
          },
          {
            name: "explicit input",
            defaultValue: "12",
            input: { count: "7" },
            expected: 7,
          },
          {
            name: "intrinsic fallback",
            defaultValue: undefined,
            input: {},
            expected: 5,
          },
          {
            name: "invalid default",
            defaultValue: "invalid",
            input: {},
            expected: undefined,
          },
          {
            name: "invalid input",
            defaultValue: "12",
            input: { count: "invalid" },
            expected: undefined,
          },
        ]) {
          it(`validates optional ${lazy ? "lazy" : "static"} ${scenario.name} at ${phase} and omits read-only client values`, async () => {
            const seed = makeOptionalSubmissionOrganisation(
              uniqueSuffix(),
              scenario.defaultValue,
              lazy,
            )
            const context = makeContext(
              "employee@example.com",
              seed.rolePath,
              seed.orgUnitPath,
            )
            const supplied = { edit: "ok", display: "client", help: "client" }
            const input = {
              ...scenario.input,
              leaf: "client",
              nested: supplied,
              list: [supplied, supplied],
            }
            expect(
              Schema.decodeUnknownSync(
                Schema.make(seed.start.submissionEffectSchema.ast),
              )({}),
            ).toEqual({ count: 5 })
            const result = await runDbEffect(
              db,
              [],
              Effect.gen(function* () {
                if (phase === "start") {
                  yield* db.storeOrganisation(seed.org)
                  yield* db.ensureProviderUser({
                    email: "employee@example.com",
                    rolePaths: [seed.rolePath],
                    orgUnitPath: seed.orgUnitPath,
                  })
                  const processId = yield* db.getProcessIdByPath(
                    seed.processPath,
                  )
                  const started = yield* startProcess(
                    processId,
                    seed.processPath,
                    seed.startStepPath,
                    input,
                    seed.start.submissionEffectSchema,
                    seed.start,
                    context,
                  ).pipe(Effect.either)
                  if (Either.isLeft(started)) {
                    expect(
                      yield* db.getProcessStatesByProcessId(processId),
                    ).toEqual([])
                    return started.left
                  }
                  return (yield* db.getProcessStateByExecutionId(
                    started.right.executionId,
                  ))?.state
                }
                const active = yield* seedActiveTodo(db, {
                  organisation: seed.org,
                  orgUnitPath: seed.orgUnitPath,
                  rolePath: seed.rolePath,
                  processPath: seed.processPath,
                  startStepPath: seed.startStepPath,
                  todoStepPath: seed.todoStepPath,
                  state: {},
                })
                const completed = yield* completeStep(
                  active.todoId,
                  input,
                  seed.complete,
                  seed.complete.submissionEffectSchema,
                  context,
                ).pipe(Effect.either)
                const stored = yield* db.getProcessStateByExecutionId(
                  active.executionId,
                )
                if (Either.isLeft(completed)) {
                  expect(stored?.state).toEqual({})
                  return completed.left
                }
                return stored?.state
              }),
              true,
              makeAuthorizationLayer(),
            )
            if (scenario.expected === undefined)
              expect(result).toBeInstanceOf(InputValidationError)
            else
              expect(result).toEqual({
                count: scenario.expected,
                nested: { edit: "ok" },
                list: [{ edit: "ok" }, { edit: "ok" }],
              })
          })
        }
      }
    }

    it("defaults omitted CurrentProviderUser start fields before validation", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRestrictedStartOrganisation(
        `${db.name}-default-start-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          const started = yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            { title: "Request" },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          )
          const processState = yield* db.getProcessStateByExecutionId(
            started.executionId,
          )
          return { processState, started }
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result.processState?.state).toEqual({
        title: "Request",
        requestedFor: "employee@example.com",
      })
      expect(result.started.deduplicated).toBe(false)
    })

    it("rejects explicit wrapped restricted start fields before writing process state", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeWrappedRestrictedStartOrganisation(
        `${db.name}-wrapped-restricted-start-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          const error = yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            { title: "Request", requestedFor: "other@example.com" },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          ).pipe(Effect.flip)
          const processStates = yield* db.getProcessStatesByProcessId(processId)
          return { error, processStates }
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result.error).toBeInstanceOf(NotAuthorized)
      if (!(result.error instanceof NotAuthorized)) {
        throw result.error
      }
      expect(result.error.resource).toBe(`${seed.startStepPath}/requestedFor`)
      expect(result.processStates).toEqual([])
    })

    it("leaves CurrentProviderUser unresolved for service-account process starts", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRestrictedStartOrganisation(
        `${db.name}-service-start-${uniqueSuffix()}`,
      )
      const context = makeServiceAccountContext(seed.rolePath, seed.orgUnitPath)

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          const error = yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            { title: "Request" },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          ).pipe(Effect.flip)
          const processStates = yield* db.getProcessStatesByProcessId(processId)
          return { error, processStates }
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result.error).toBeInstanceOf(InputValidationError)
      if (!(result.error instanceof InputValidationError)) {
        throw result.error
      }
      expect(
        result.error.errors.some((item) => item.field === "requestedFor"),
      ).toBe(true)
      expect(result.processStates).toEqual([])
    })

    it("rejects non-self provider-user targets during process start when actOnBehalfOf denies", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRestrictedStartOrganisation(
        `${db.name}-start-behalf-deny-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "manager@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "other@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          const error = yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            { title: "Request", requestedFor: "other@example.com" },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          ).pipe(Effect.flip)
          const processStates = yield* db.getProcessStatesByProcessId(processId)
          return { error, processStates }
        }),
        true,
        makeAuthorizationLayer({
          canModifyField: true,
          canActOnBehalfOf: false,
        }),
      )

      expect(result.error).toBeInstanceOf(NotAuthorized)
      if (!(result.error instanceof NotAuthorized)) {
        throw result.error
      }
      expect(result.error.action).toBe("actOnBehalfOf")
      expect(result.processStates).toEqual([])
    })

    it("attributes embedded starts to the configured external email", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeEmbeddedStartOrganisation(
        `${db.name}-embedded-start-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          const started = yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            { email: " Parent@Example.com ", title: "Request" },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          )
          const processState = yield* db.getProcessStateByExecutionId(
            started.executionId,
          )
          const externalParticipantIds =
            yield* db.getExternalParticipantIdsByEmail("parent@example.com")
          return { externalParticipantIds, processState }
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result.externalParticipantIds).toHaveLength(1)
      expect(result.processState?.startedByExternalParticipantId).toBe(
        result.externalParticipantIds[0],
      )
      expect(result.processState?.state).toEqual({
        email: "Parent@Example.com",
        title: "Request",
      })
    })

    it("sanitizes hidden stale values during process start", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleStartOrganisation(
        `${db.name}-rule-start-hidden-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          const started = yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            {
              status: "hide",
              details: "stale client value",
              alwaysRequired: "present",
            },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          )
          const processState = yield* db.getProcessStateByExecutionId(
            started.executionId,
          )
          return processState
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result?.state).toEqual({
        disabledDefault: "server default",
        status: "hide",
        alwaysRequired: "present",
      })
    })

    it("keeps hidden disabled start fields filtered", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleStartOrganisation(
        `${db.name}-rule-start-hidden-disabled-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          const started = yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            {
              status: "hide-disabled",
              details: "tampered client value",
              alwaysRequired: "present",
            },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          )
          return yield* db.getProcessStateByExecutionId(started.executionId)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result?.state).toEqual({
        disabledDefault: "server default",
        status: "hide-disabled",
        alwaysRequired: "present",
      })
    })

    it("preserves disabled default values during process start", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleStartOrganisation(
        `${db.name}-rule-start-disabled-default-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          const started = yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            {
              status: "disable-default",
              disabledDefault: "tampered client value",
              alwaysRequired: "present",
            },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          )
          return yield* db.getProcessStateByExecutionId(started.executionId)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result?.state).toEqual({
        status: "disable-default",
        disabledDefault: "server default",
        alwaysRequired: "present",
      })
    })

    it("rejects disabled required start fields without preservable values", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleStartOrganisation(
        `${db.name}-rule-start-disabled-required-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          return yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            {
              status: "disable-required-missing",
              disabledRequired: "tampered client value",
              alwaysRequired: "present",
            },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          ).pipe(Effect.flip)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result).toBeInstanceOf(InputValidationError)
      if (!(result instanceof InputValidationError)) {
        throw result
      }
      expect(result.errors).toContainEqual({
        field: "disabledRequired",
        message: "Required",
      })
    })

    it.each(["hide-choice-wrapper", "disable-choice-wrapper"])(
      "ignores flattened Select input for %s",
      async (status) => {
        const enqueuedJobs: EnqueuedJob[] = []
        const seed = makeRuleStartOrganisation(
          `${db.name}-choice-${uniqueSuffix()}`,
        )
        const context = makeContext(
          "employee@example.com",
          seed.rolePath,
          seed.orgUnitPath,
        )
        const result = await runDbEffect(
          db,
          enqueuedJobs,
          Effect.gen(function* () {
            yield* db.storeOrganisation(seed.org)
            yield* db.ensureProviderUser({
              email: "employee@example.com",
              rolePaths: [seed.rolePath],
              orgUnitPath: seed.orgUnitPath,
            })
            const processId = yield* db.getProcessIdByPath(seed.processPath)
            const started = yield* startProcess(
              processId,
              seed.processPath,
              seed.startStepPath,
              { status, category: "Guest", alwaysRequired: "present" },
              seed.form.submissionEffectSchema,
              seed.form,
              context,
            )
            return yield* db.getProcessStateByExecutionId(started.executionId)
          }),
          true,
          makeAuthorizationLayer(),
        )
        expect(result?.state).toMatchObject({
          status,
          alwaysRequired: "present",
        })
        expect(result?.state).not.toHaveProperty("category")
        expect(result?.state).not.toHaveProperty("choices")
      },
    )

    it("ignores inherited disabled child edits during process start", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleStartOrganisation(
        `${db.name}-rule-start-disabled-section-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          const started = yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            {
              status: "disable-section",
              section: { inheritedDisabled: "tampered client value" },
              alwaysRequired: "present",
            },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          )
          return yield* db.getProcessStateByExecutionId(started.executionId)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result?.state).toEqual({
        disabledDefault: "server default",
        status: "disable-section",
        alwaysRequired: "present",
      })
    })

    it("ignores hidden stale provider-user targets during process start", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeHiddenProviderUserRuleStartOrganisation(
        `${db.name}-rule-start-hidden-provider-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          yield* db.ensureProviderUser({
            email: "other@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          const started = yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            { status: "hide", requestedFor: "other@example.com" },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          )
          return yield* db.getProcessStateByExecutionId(started.executionId)
        }),
        true,
        makeAuthorizationLayer({ canActOnBehalfOf: false }),
      )

      expect(result?.state).toEqual({ status: "hide" })
    })

    it("requires conditionally required fields from authoritative start rules", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleStartOrganisation(
        `${db.name}-rule-start-required-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          const error = yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            { status: "show", alwaysRequired: "present" },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          ).pipe(Effect.flip)
          const processStates = yield* db.getProcessStatesByProcessId(processId)
          return { error, processStates }
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result.error).toBeInstanceOf(InputValidationError)
      if (!(result.error instanceof InputValidationError)) {
        throw result.error
      }
      expect(result.error.errors).toContainEqual({
        field: "details",
        message: "Required",
      })
      expect(result.processStates).toEqual([])
    })

    it("rejects whitespace-only conditionally required start fields", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleStartOrganisation(
        `${db.name}-rule-start-whitespace-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          return yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            { status: "show", details: "   ", alwaysRequired: "present" },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          ).pipe(Effect.flip)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result).toBeInstanceOf(InputValidationError)
      if (!(result instanceof InputValidationError)) {
        throw result
      }
      expect(result.errors).toContainEqual({
        field: "details",
        message: "Required",
      })
    })

    it("rejects empty conditionally required arrays during process start", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleStartOrganisation(
        `${db.name}-rule-start-empty-array-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          return yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            {
              status: "needs-list",
              approvers: [],
              alwaysRequired: "present",
            },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          ).pipe(Effect.flip)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result).toBeInstanceOf(InputValidationError)
      if (!(result instanceof InputValidationError)) {
        throw result
      }
      expect(result.errors).toContainEqual({
        field: "approvers",
        message: "Required",
      })
    })

    it("ignores tampered client rule state during process start", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleStartOrganisation(
        `${db.name}-rule-start-tamper-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          return yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            {
              status: "show",
              alwaysRequired: "present",
              details: "",
              rules: [{ target: ["details"], state: { hidden: true } }],
            },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          ).pipe(Effect.flip)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result).toBeInstanceOf(InputValidationError)
      if (!(result instanceof InputValidationError)) {
        throw result
      }
      expect(result.errors).toContainEqual({
        field: "details",
        message: "Required",
      })
    })

    it("rejects effective required fields that are also hidden", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleStartOrganisation(
        `${db.name}-rule-start-conflict-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          return yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            {
              status: "invalid-model-state",
              details: "not relevant",
              alwaysRequired: "present",
            },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          ).pipe(Effect.flip)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result).toBeInstanceOf(InputValidationError)
      if (!(result instanceof InputValidationError)) {
        throw result
      }
      expect(result.errors).toContainEqual({
        field: "alwaysRequired",
        message: "Field cannot be required while hidden",
      })
    })

    it("does not let rules loosen static required start fields", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleStartOrganisation(
        `${db.name}-rule-start-static-required-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          return yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            { status: "loosen-static" },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          ).pipe(Effect.flip)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result).toBeInstanceOf(InputValidationError)
      if (!(result instanceof InputValidationError)) {
        throw result
      }
      expect(result.errors).toContainEqual({
        field: "alwaysRequired",
        message: "Required",
      })
    })

    it("sanitizes nested hidden values without mutating submitted input", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeNestedRuleStartOrganisation(
        `${db.name}-nested-rule-start-hidden-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )
      const input = {
        section: {
          status: "hide-child",
          details: "stale nested value",
          alwaysRequired: "present",
        },
      }

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          const started = yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            input,
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          )
          const processState = yield* db.getProcessStateByExecutionId(
            started.executionId,
          )
          return processState
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result?.state).toEqual({
        section: { status: "hide-child", alwaysRequired: "present" },
      })
      expect(input.section.details).toBe("stale nested value")
    })

    it("rejects static required children hidden by parent rules", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeNestedRuleStartOrganisation(
        `${db.name}-nested-rule-start-conflict-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          return yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            {
              section: {
                status: "hide-parent",
                alwaysRequired: "present",
              },
            },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
          ).pipe(Effect.flip)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result).toBeInstanceOf(InputValidationError)
      if (!(result instanceof InputValidationError)) {
        throw result
      }
      expect(result.errors).toContainEqual({
        field: "section.alwaysRequired",
        message: "Field cannot be required while hidden",
      })
    })

    it("rejects explicit restricted completion fields before updating state", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRestrictedTodoOrganisation(
        `${db.name}-restricted-complete-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          const error = yield* completeStep(
            activeTodo.todoId,
            { title: "Request", requestedFor: "other@example.com" },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          ).pipe(Effect.flip)
          const processState = yield* db.getProcessStateByExecutionId(
            activeTodo.executionId,
          )
          return { error, processState }
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result.error).toBeInstanceOf(NotAuthorized)
      if (!(result.error instanceof NotAuthorized)) {
        throw result.error
      }
      expect(result.error.resource).toBe(`${seed.todoStepPath}/requestedFor`)
      expect(result.processState?.state).toEqual({})
      expect(enqueuedJobs).toEqual([])
    })

    it("sanitizes hidden stale values during todo completion", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleTodoOrganisation(
        `${db.name}-rule-complete-hidden-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          yield* completeStep(
            activeTodo.todoId,
            {
              status: "hide",
              details: "stale client value",
              alwaysRequired: "present",
            },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          )
          return yield* db.getProcessStateByExecutionId(activeTodo.executionId)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result?.state).toEqual({
        originalOnly: expect.stringMatching(/^pex-/),
        status: "hide",
        alwaysRequired: "present",
      })
    })

    it("keeps hidden disabled completion fields filtered", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleTodoOrganisation(
        `${db.name}-rule-complete-hidden-disabled-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
            state: { details: "original value" },
          })
          yield* completeStep(
            activeTodo.todoId,
            {
              status: "hide-disabled",
              details: "tampered client value",
              alwaysRequired: "present",
            },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          )
          return yield* db.getProcessStateByExecutionId(activeTodo.executionId)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result?.state).toEqual({
        originalOnly: expect.stringMatching(/^pex-/),
        status: "hide-disabled",
        alwaysRequired: "present",
      })
    })

    it("preserves original disabled values during todo completion", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleTodoOrganisation(
        `${db.name}-rule-complete-disabled-original-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
            state: { originalOnly: "original value" },
          })
          yield* completeStep(
            activeTodo.todoId,
            {
              status: "disable-original",
              originalOnly: "tampered client value",
              alwaysRequired: "present",
            },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          )
          return yield* db.getProcessStateByExecutionId(activeTodo.executionId)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result?.state).toEqual({
        status: "disable-original",
        originalOnly: "original value",
        alwaysRequired: "present",
      })
    })

    it("persists a decorated default from the actual execution when a disabled field has no original", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleTodoOrganisation(
        `${db.name}-rule-complete-decorated-default-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
            state: {},
          })
          yield* completeStep(
            activeTodo.todoId,
            {
              status: "disable-original",
              originalOnly: "tampered client value",
              alwaysRequired: "present",
            },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          )
          return {
            executionId: activeTodo.executionId,
            stored: yield* db.getProcessStateByExecutionId(
              activeTodo.executionId,
            ),
          }
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result.stored?.state).toEqual({
        status: "disable-original",
        originalOnly: result.executionId,
        alwaysRequired: "present",
      })
    })

    it("rejects disabled required completion fields without preservable values", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleTodoOrganisation(
        `${db.name}-rule-complete-disabled-required-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          return yield* completeStep(
            activeTodo.todoId,
            {
              status: "disable-required-missing",
              disabledRequired: "tampered client value",
              alwaysRequired: "present",
            },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          ).pipe(Effect.flip)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result).toBeInstanceOf(InputValidationError)
      if (!(result instanceof InputValidationError)) {
        throw result
      }
      expect(result.errors).toContainEqual({
        field: "disabledRequired",
        message: "Required",
      })
    })

    it("preserves inherited disabled child values during todo completion", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleTodoOrganisation(
        `${db.name}-rule-complete-disabled-section-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
            state: { section: { inheritedDisabled: "original value" } },
          })
          yield* completeStep(
            activeTodo.todoId,
            {
              status: "disable-section",
              section: { inheritedDisabled: "tampered client value" },
              alwaysRequired: "present",
            },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          )
          return yield* db.getProcessStateByExecutionId(activeTodo.executionId)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result?.state).toEqual({
        originalOnly: expect.stringMatching(/^pex-/),
        status: "disable-section",
        section: { inheritedDisabled: "original value" },
        alwaysRequired: "present",
      })
    })

    it("preserves disabled list item child values during todo completion", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleTodoOrganisation(
        `${db.name}-rule-complete-disabled-list-child-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
            state: { approvers: [{ name: "original approver" }] },
          })
          yield* completeStep(
            activeTodo.todoId,
            {
              status: "disable-list-child",
              approvers: [{ name: "tampered approver" }],
              alwaysRequired: "present",
            },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          )
          return yield* db.getProcessStateByExecutionId(activeTodo.executionId)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result?.state).toEqual({
        originalOnly: expect.stringMatching(/^pex-/),
        status: "disable-list-child",
        approvers: [{ name: "original approver" }],
        alwaysRequired: "present",
      })
    })

    it("rejects extra disabled list item child values without preserved rows", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleTodoOrganisation(
        `${db.name}-rule-complete-disabled-list-extra-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
            state: { approvers: [{ name: "original approver" }] },
          })
          return yield* completeStep(
            activeTodo.todoId,
            {
              status: "disable-list-child",
              approvers: [
                { name: "tampered approver" },
                { name: "extra tampered approver" },
              ],
              alwaysRequired: "present",
            },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          ).pipe(Effect.flip)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result).toBeInstanceOf(InputValidationError)
      if (!(result instanceof InputValidationError)) {
        throw result
      }
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "approvers.1.name" }),
      )
    })

    it("rejects whitespace-only conditionally required fields during todo completion", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleTodoOrganisation(
        `${db.name}-rule-complete-required-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          return yield* completeStep(
            activeTodo.todoId,
            { status: "show", details: "   ", alwaysRequired: "present" },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          ).pipe(Effect.flip)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result).toBeInstanceOf(InputValidationError)
      if (!(result instanceof InputValidationError)) {
        throw result
      }
      expect(result.errors).toContainEqual({
        field: "details",
        message: "Required",
      })
    })

    it("rejects empty conditionally required arrays during todo completion", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleTodoOrganisation(
        `${db.name}-rule-complete-empty-array-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          return yield* completeStep(
            activeTodo.todoId,
            {
              status: "needs-list",
              approvers: [],
              alwaysRequired: "present",
            },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          ).pipe(Effect.flip)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result).toBeInstanceOf(InputValidationError)
      if (!(result instanceof InputValidationError)) {
        throw result
      }
      expect(result.errors).toContainEqual({
        field: "approvers",
        message: "Required",
      })
    })

    it("ignores tampered client rule state during todo completion", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleTodoOrganisation(
        `${db.name}-rule-complete-tamper-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          return yield* completeStep(
            activeTodo.todoId,
            {
              status: "show",
              details: "",
              alwaysRequired: "present",
              rules: [{ target: ["details"], state: { hidden: true } }],
            },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          ).pipe(Effect.flip)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result).toBeInstanceOf(InputValidationError)
      if (!(result instanceof InputValidationError)) {
        throw result
      }
      expect(result.errors).toContainEqual({
        field: "details",
        message: "Required",
      })
    })

    it("rejects required fields hidden by rules during todo completion", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRuleTodoOrganisation(
        `${db.name}-rule-complete-conflict-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          return yield* completeStep(
            activeTodo.todoId,
            { status: "invalid-model-state", alwaysRequired: "present" },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          ).pipe(Effect.flip)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result).toBeInstanceOf(InputValidationError)
      if (!(result instanceof InputValidationError)) {
        throw result
      }
      expect(result.errors).toContainEqual({
        field: "alwaysRequired",
        message: "Field cannot be required while hidden",
      })
    })

    it("defaults omitted CurrentProviderUser completion fields before validation", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRestrictedTodoOrganisation(
        `${db.name}-default-complete-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          yield* completeStep(
            activeTodo.todoId,
            { title: "Request" },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          )
          return yield* db.getProcessStateByExecutionId(activeTodo.executionId)
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result?.state).toEqual({
        title: "Request",
        requestedFor: "employee@example.com",
      })
    })

    it("rejects explicit wrapped restricted completion fields before updating state", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeWrappedRestrictedTodoOrganisation(
        `${db.name}-wrapped-restricted-complete-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          const error = yield* completeStep(
            activeTodo.todoId,
            { title: "Request", requestedFor: "other@example.com" },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          ).pipe(Effect.flip)
          const processState = yield* db.getProcessStateByExecutionId(
            activeTodo.executionId,
          )
          return { error, processState }
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result.error).toBeInstanceOf(NotAuthorized)
      if (!(result.error instanceof NotAuthorized)) {
        throw result.error
      }
      expect(result.error.resource).toBe(`${seed.todoStepPath}/requestedFor`)
      expect(result.processState?.state).toEqual({})
    })

    it("leaves CurrentProviderUser unresolved for service-account step completions", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRestrictedTodoOrganisation(
        `${db.name}-service-complete-${uniqueSuffix()}`,
      )
      const context = makeServiceAccountContext(seed.rolePath, seed.orgUnitPath)

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          const error = yield* completeStep(
            activeTodo.todoId,
            { title: "Request" },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          ).pipe(Effect.flip)
          const processState = yield* db.getProcessStateByExecutionId(
            activeTodo.executionId,
          )
          return { error, processState }
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result.error).toBeInstanceOf(InputValidationError)
      if (!(result.error instanceof InputValidationError)) {
        throw result.error
      }
      expect(
        result.error.errors.some((item) => item.field === "requestedFor"),
      ).toBe(true)
      expect(result.processState?.state).toEqual({})
    })

    it("allows non-self provider-user targets when actOnBehalfOf permits", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRestrictedTodoOrganisation(
        `${db.name}-complete-behalf-allow-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "manager@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          yield* db.ensureProviderUser({
            email: "other@example.com",
            id: "pu-other",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          yield* completeStep(
            activeTodo.todoId,
            { title: "Request", requestedFor: "pu-other" },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          )
          return yield* db.getProcessStateByExecutionId(activeTodo.executionId)
        }),
        true,
        makeAuthorizationLayer({
          canModifyField: true,
          canActOnBehalfOf: true,
        }),
      )

      expect(result?.state).toEqual({
        title: "Request",
        requestedFor: "pu-other",
      })
    })

    it("rejects non-self provider-user targets when actOnBehalfOf denies", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRestrictedTodoOrganisation(
        `${db.name}-complete-behalf-deny-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "manager@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          yield* db.ensureProviderUser({
            email: "other@example.com",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const error = yield* completeStep(
            activeTodo.todoId,
            { title: "Request", requestedFor: "other@example.com" },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          ).pipe(Effect.flip)
          const processState = yield* db.getProcessStateByExecutionId(
            activeTodo.executionId,
          )
          return { error, processState }
        }),
        true,
        makeAuthorizationLayer({
          canModifyField: true,
          canActOnBehalfOf: false,
        }),
      )

      expect(result.error).toBeInstanceOf(NotAuthorized)
      if (!(result.error instanceof NotAuthorized)) {
        throw result.error
      }
      expect(result.error.action).toBe("actOnBehalfOf")
      expect(result.processState?.state).toEqual({})
    })

    it("rejects nested list provider-user targets when actOnBehalfOf denies", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeNestedProviderUserTodoOrganisation(
        `${db.name}-nested-behalf-deny-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "manager@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          yield* db.ensureProviderUser({
            email: "other@example.com",
            id: "pu-other",
            rolePaths: [seed.rolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const error = yield* completeStep(
            activeTodo.todoId,
            { approvers: [{ requestedFor: "pu-other" }] },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          ).pipe(Effect.flip)
          const processState = yield* db.getProcessStateByExecutionId(
            activeTodo.executionId,
          )
          return { error, processState }
        }),
        true,
        makeAuthorizationLayer({ canActOnBehalfOf: false }),
      )

      expect(result.error).toBeInstanceOf(NotAuthorized)
      if (!(result.error instanceof NotAuthorized)) {
        throw result.error
      }
      expect(result.error.action).toBe("actOnBehalfOf")
      expect(result.processState?.state).toEqual({})
    })

    it("does not authorize provider-user targets from non-matching union branches", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeUnionProviderUserTodoOrganisation(
        `${db.name}-union-non-provider-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "manager@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          yield* completeStep(
            activeTodo.todoId,
            { target: { kind: "note", requestedFor: "free text" } },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          )
          return yield* db.getProcessStateByExecutionId(activeTodo.executionId)
        }),
        true,
        makeAuthorizationLayer({ canActOnBehalfOf: false }),
      )

      expect(result?.state).toEqual({
        target: { kind: "note", requestedFor: "free text" },
      })
    })

    it("rejects clearing provider-user targets with an empty value", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRestrictedTodoOrganisation(
        `${db.name}-empty-provider-target-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "manager@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          const error = yield* completeStep(
            activeTodo.todoId,
            { title: "Request", requestedFor: "" },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          ).pipe(Effect.flip)
          const processState = yield* db.getProcessStateByExecutionId(
            activeTodo.executionId,
          )
          return { error, processState }
        }),
        true,
        makeAuthorizationLayer({
          canModifyField: true,
          canActOnBehalfOf: true,
        }),
      )

      expect(result.error).toBeInstanceOf(NotAuthorized)
      if (!(result.error instanceof NotAuthorized)) {
        throw result.error
      }
      expect(result.error.action).toBe("actOnBehalfOf")
      expect(result.error.message).toBe(
        "Provider user field requestedFor requires a non-empty value",
      )
      expect(result.processState?.state).toEqual({})
    })

    it("rejects roleless provider-user targets", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRestrictedTodoOrganisation(
        `${db.name}-roleless-provider-target-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "manager@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          yield* db.ensureProviderUser({
            email: "other@example.com",
            rolePaths: [],
            orgUnitPath: seed.orgUnitPath,
          })
          const error = yield* completeStep(
            activeTodo.todoId,
            { title: "Request", requestedFor: "other@example.com" },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          ).pipe(Effect.flip)
          const processState = yield* db.getProcessStateByExecutionId(
            activeTodo.executionId,
          )
          return { error, processState }
        }),
        true,
        makeAuthorizationLayer({
          canModifyField: true,
          canActOnBehalfOf: true,
        }),
      )

      expect(result.error).toBeInstanceOf(NotAuthorized)
      if (!(result.error instanceof NotAuthorized)) {
        throw result.error
      }
      expect(result.error.action).toBe("actOnBehalfOf")
      expect(result.processState?.state).toEqual({})
    })

    it("rejects unknown provider-user targets", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeRestrictedTodoOrganisation(
        `${db.name}-unknown-provider-target-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "manager@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          const error = yield* completeStep(
            activeTodo.todoId,
            { title: "Request", requestedFor: "unknown@example.com" },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          ).pipe(Effect.flip)
          const processState = yield* db.getProcessStateByExecutionId(
            activeTodo.executionId,
          )
          return { error, processState }
        }),
        true,
        makeAuthorizationLayer({
          canModifyField: true,
          canActOnBehalfOf: true,
        }),
      )

      expect(result.error).toBeInstanceOf(NotAuthorized)
      if (!(result.error instanceof NotAuthorized)) {
        throw result.error
      }
      expect(result.error.action).toBe("actOnBehalfOf")
      expect(result.processState?.state).toEqual({})
    })

    it("retries the full completion after a state conflict", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const completionLogs: Array<Record<string, unknown>> = []
      const capturingLogger = Logger.make(({ message, annotations }) => {
        if (String(message) === "Completing step transaction") {
          completionLogs.push(Object.fromEntries(annotations))
        }
      })
      const seed = makeSupportingRoleTodoOrganisation(
        `${db.name}-complete-retry-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const todo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          const operations = yield* StepCompletionOperations
          let stateUpdateAttempts = 0
          const retryingOperations: StepCompletionOperations["Type"] = {
            ...operations,
            updateProcessStateIfUnchanged: (stateId, updatedAt, state) =>
              Effect.gen(function* () {
                stateUpdateAttempts += 1
                if (stateUpdateAttempts === 1) {
                  return { kind: "conflict" as const }
                }
                return yield* operations.updateProcessStateIfUnchanged(
                  stateId,
                  updatedAt,
                  state,
                )
              }),
          }

          const completed = yield* completeStep(
            todo.todoId,
            { title: "Request" },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          ).pipe(
            Effect.provideService(StepCompletionOperations, retryingOperations),
            Effect.provide(
              Logger.replace(Logger.defaultLogger, capturingLogger),
            ),
            Logger.withMinimumLogLevel(LogLevel.Info),
          )
          const processState = yield* db.getProcessStateByExecutionId(
            todo.executionId,
          )
          const scheduledFlowIds = yield* db.getScheduledFlowIdsForExecution(
            todo.executionId,
          )
          return {
            completed,
            processState,
            scheduledFlowIds,
            stateUpdateAttempts,
            todoId: todo.todoId,
          }
        }),
        false,
        makeAuthorizationLayer(),
      )

      expect(result.stateUpdateAttempts).toBe(2)
      expect(completionLogs).toEqual([
        {
          todoId: result.todoId,
          txMode: "immediate",
          completeStepAttempt: 1,
          completeStepRetryCount: 0,
        },
        {
          todoId: result.todoId,
          txMode: "immediate",
          completeStepAttempt: 2,
          completeStepRetryCount: 1,
        },
      ])
      expect(result.processState?.state).toEqual({ title: "Request" })
      expect(result.scheduledFlowIds).toEqual([result.todoId])
      expect(enqueuedJobs).toHaveLength(4)
      expect(
        enqueuedJobs.filter((job) => job.queue === FLOW_EXECUTION_QUEUE),
      ).toHaveLength(1)
    })

    it("completes a double-submitted todo once", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeSupportingRoleTodoOrganisation(
        `${db.name}-complete-double-submit-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const todo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          const sqlClient = yield* SqlClient.SqlClient
          const concurrent = makeConcurrentTestClient(sqlClient)
          const complete = completeStep(
            todo.todoId,
            { title: "Request" },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          )
          const completions = yield* Effect.all([complete, complete], {
            concurrency: "unbounded",
          }).pipe(Effect.provideService(SqlClient.SqlClient, concurrent.client))
          const processState = yield* db.getProcessStateByExecutionId(
            todo.executionId,
          )
          const scheduledFlowIds = yield* db.getScheduledFlowIdsForExecution(
            todo.executionId,
          )
          return {
            completions,
            processState,
            scheduledFlowIds,
            transactionAttempts: concurrent.transactionAttempts(),
          }
        }),
        false,
        makeAuthorizationLayer(),
      )

      expect(result.completions).toHaveLength(2)
      expect(result.transactionAttempts).toBeGreaterThanOrEqual(2)
      expect(result.processState?.state).toEqual({ title: "Request" })
      expect(result.scheduledFlowIds).toHaveLength(1)
      expect(enqueuedJobs).toHaveLength(4)
      expect(
        enqueuedJobs.filter((job) => job.queue === FLOW_EXECUTION_QUEUE),
      ).toHaveLength(1)
    })

    it("preserves both state patches from overlapping todo completions", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const completionLogs: Array<Record<string, unknown>> = []
      const capturingLogger = Logger.make(({ message, annotations }) => {
        if (String(message) === "Completing step transaction") {
          completionLogs.push(Object.fromEntries(annotations))
        }
      })
      const seed = makeOverlappingTodoOrganisation(
        `${db.name}-overlapping-completions-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const firstTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.givenNameStepPath,
          })
          const secondFlowId = yield* db.getFlowIdByStepPaths(
            seed.startStepPath,
            seed.familyNameStepPath,
          )
          const flowOps = yield* FlowExecutionOperations
          const secondTodoId = yield* flowOps.insertToDo({
            processExecutionId: firstTodo.executionId,
            flowId: secondFlowId,
            slaTargetAt: null,
            slaWarningAt: null,
            itemData: null,
          })
          const operations = yield* StepCompletionOperations
          const sqlClient = yield* SqlClient.SqlClient
          const concurrent = makeConcurrentTestClient(
            sqlClient,
            (transactionAttempt) => transactionAttempt === 1,
          )
          const bothInitialStatesRead = yield* Deferred.make<void>()
          let initialStateReads = 0
          const overlappingOperations: StepCompletionOperations["Type"] = {
            ...operations,
            getProcessStateByTodoId: (todoId) =>
              operations.getProcessStateByTodoId(todoId).pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    initialStateReads += 1
                    if (initialStateReads === 2) {
                      yield* Deferred.succeed(bothInitialStatesRead, undefined)
                    }
                    if (initialStateReads <= 2) {
                      yield* Deferred.await(bothInitialStatesRead)
                    }
                  }),
                ),
              ),
          }

          const completions = yield* Effect.all(
            [
              completeStep(
                firstTodo.todoId,
                { givenName: "Ada" },
                seed.givenName,
                seed.givenName.submissionEffectSchema,
                context,
              ),
              completeStep(
                secondTodoId,
                { familyName: "Lovelace" },
                seed.familyName,
                seed.familyName.submissionEffectSchema,
                context,
              ),
            ],
            { concurrency: "unbounded" },
          ).pipe(
            Effect.provideService(
              StepCompletionOperations,
              overlappingOperations,
            ),
            Effect.provideService(SqlClient.SqlClient, concurrent.client),
            Effect.provide(
              Logger.replace(Logger.defaultLogger, capturingLogger),
            ),
            Logger.withMinimumLogLevel(LogLevel.Info),
          )
          const processState = yield* db.getProcessStateByExecutionId(
            firstTodo.executionId,
          )
          return {
            completions,
            initialStateReads,
            processState,
            transactionAttempts: concurrent.transactionAttempts(),
          }
        }),
        false,
        makeAuthorizationLayer(),
      )

      expect(result.completions).toHaveLength(2)
      expect(result.transactionAttempts).toBeGreaterThanOrEqual(3)
      expect(completionLogs).toContainEqual(
        expect.objectContaining({
          txMode: "concurrent",
          completeStepAttempt: 2,
          completeStepRetryCount: 1,
        }),
      )
      expect(result.initialStateReads).toBeGreaterThanOrEqual(3)
      expect(result.processState?.state).toEqual({
        givenName: "Ada",
        familyName: "Lovelace",
      })
      expect(enqueuedJobs).toHaveLength(8)
    })

    it("accepts a sequential replay of a completed todo", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeSupportingRoleTodoOrganisation(
        `${db.name}-complete-replay-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const todo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          const complete = () =>
            completeStep(
              todo.todoId,
              { title: "Request" },
              seed.form,
              seed.form.submissionEffectSchema,
              context,
            )
          const first = yield* complete()
          const replayed = yield* complete()
          const processState = yield* db.getProcessStateByExecutionId(
            todo.executionId,
          )
          const scheduledFlowIds = yield* db.getScheduledFlowIdsForExecution(
            todo.executionId,
          )
          return { first, processState, replayed, scheduledFlowIds }
        }),
        false,
        makeAuthorizationLayer(),
      )

      expect(result.replayed).toEqual(result.first)
      expect(result.processState?.state).toEqual({ title: "Request" })
      expect(result.scheduledFlowIds).toHaveLength(1)
      expect(enqueuedJobs).toHaveLength(4)
    })

    it("recovers external enqueue after the completion commit", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeSupportingRoleTodoOrganisation(
        `${db.name}-complete-enqueue-recovery-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const todo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          const queueService = yield* QueueService
          let enqueueAttempts = 0
          const failingQueueService = {
            ...queueService,
            enqueue: (
              queue: string,
              payload: Payload,
              enqueueOptions?: {
                readonly logicalJobId?: string
                readonly retryLimit?: number
              },
            ) => {
              enqueueAttempts += 1
              return enqueueAttempts === 2
                ? Effect.fail(
                    new EnqueueError({
                      queue,
                      message: "Simulated post-commit enqueue failure",
                    }),
                  )
                : queueService.enqueue(queue, payload, enqueueOptions)
            },
          } as unknown as QueueService["Type"]
          const complete = () =>
            completeStep(
              todo.todoId,
              { title: "Request" },
              seed.form,
              seed.form.submissionEffectSchema,
              context,
            )

          const firstError = yield* complete().pipe(
            Effect.provideService(QueueService, failingQueueService),
            Effect.flip,
          )
          const flowExecutionOps = yield* FlowExecutionOperations
          const pendingAfterFailure =
            yield* flowExecutionOps.queryFlowDispatchJobs(
              `step-completion:${todo.todoId}`,
            )
          const claimTime = yield* DateTime.now
          yield* flowExecutionOps.claimFlowDispatchJobs(
            `step-completion:${todo.todoId}`,
            claimTime,
            DateTime.add(claimTime, { minutes: 5 }),
            "held-by-another-drainer",
          )
          const deferredDispatches =
            yield* recoverPendingExternalCompletionEnqueues
          yield* flowExecutionOps.releaseFlowDispatchJobs(
            `step-completion:${todo.todoId}`,
            "held-by-another-drainer",
          )
          const recoveredDispatches =
            yield* recoverPendingExternalCompletionEnqueues
          const pendingAfterReplay =
            yield* flowExecutionOps.queryFlowDispatchJobs(
              `step-completion:${todo.todoId}`,
            )
          const scheduledFlowIds = yield* db.getScheduledFlowIdsForExecution(
            todo.executionId,
          )
          return {
            firstError,
            deferredDispatches,
            pendingAfterFailure,
            pendingAfterReplay,
            recoveredDispatches,
            scheduledFlowIds,
          }
        }),
        false,
        makeAuthorizationLayer(),
      )

      expect(result.firstError).toBeInstanceOf(EnqueueError)
      expect(result.deferredDispatches).toBe(0)
      expect(result.pendingAfterFailure).toHaveLength(3)
      expect(result.pendingAfterReplay).toEqual([])
      expect(result.recoveredDispatches).toBe(1)
      expect(result.scheduledFlowIds).toHaveLength(1)
      expect(enqueuedJobs).toHaveLength(4)
      expect(enqueuedJobs.at(-1)?.queue).toBe(FLOW_EXECUTION_QUEUE)
    })

    it("publishes external completion jobs once across concurrent replays", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeSupportingRoleTodoOrganisation(
        `${db.name}-concurrent-enqueue-replay-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const todo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          const queueService = yield* QueueService
          const failingQueueService = {
            ...queueService,
            enqueue: (queue: string) =>
              Effect.fail(
                new EnqueueError({
                  queue,
                  message: "Simulated post-commit enqueue failure",
                }),
              ),
          } as unknown as QueueService["Type"]
          const complete = () =>
            completeStep(
              todo.todoId,
              { title: "Request" },
              seed.form,
              seed.form.submissionEffectSchema,
              context,
            )

          yield* complete().pipe(
            Effect.provideService(QueueService, failingQueueService),
            Effect.flip,
          )
          const replayed = yield* Effect.all([complete(), complete()], {
            concurrency: "unbounded",
          })
          return { replayed }
        }),
        false,
        makeAuthorizationLayer(),
      )

      expect(result.replayed).toHaveLength(2)
      expect(enqueuedJobs).toHaveLength(4)
      expect(
        enqueuedJobs.filter((job) => job.queue === FLOW_EXECUTION_QUEUE),
      ).toHaveLength(1)
    })

    it("returns a client conflict after five concurrent commit conflicts", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeSupportingRoleTodoOrganisation(
        `${db.name}-complete-conflict-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const todo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          const sqlClient = yield* SqlClient.SqlClient
          const concurrent = makeConcurrentTestClient(sqlClient, () => true)

          const error = yield* completeStep(
            todo.todoId,
            { title: "Request" },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
          ).pipe(
            Effect.provideService(SqlClient.SqlClient, concurrent.client),
            Effect.flip,
          )
          const processState = yield* db.getProcessStateByExecutionId(
            todo.executionId,
          )
          const storedTodo = yield* db.getTodoById(todo.todoId)
          const scheduledFlowIds = yield* db.getScheduledFlowIdsForExecution(
            todo.executionId,
          )
          return {
            error,
            processState,
            scheduledFlowIds,
            transactionAttempts: concurrent.transactionAttempts(),
            storedTodo,
          }
        }),
        false,
        makeAuthorizationLayer(),
      )

      expect(result.error).toBeInstanceOf(StepCompletionConflictError)
      expect(result.transactionAttempts).toBe(5)
      expect(result.processState?.state).toEqual({})
      expect(result.storedTodo?.deleted).toBe(false)
      expect(result.scheduledFlowIds).toEqual([])
      expect(enqueuedJobs).toEqual([])
    })

    it("appends forEach completion output once after an in-transaction retry", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const seed = makeForEachTodoOrganisation(
        `${db.name}-for-each-complete-${uniqueSuffix()}`,
      )
      const context = makeContext(
        "employee@example.com",
        seed.rolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const activeTodo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
          })
          const operations = yield* StepCompletionOperations
          let todoCompletionAttempts = 0
          const retryingOperations: StepCompletionOperations["Type"] = {
            ...operations,
            completeToDoIfOpen: (completion) =>
              Effect.gen(function* () {
                todoCompletionAttempts += 1
                if (todoCompletionAttempts === 1) {
                  return { kind: "conflict" as const }
                }
                return yield* operations.completeToDoIfOpen(completion)
              }),
          }
          yield* completeStep(
            activeTodo.todoId,
            { title: "Request" },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
            { completingRolePath: seed.rolePath },
          ).pipe(
            Effect.provideService(StepCompletionOperations, retryingOperations),
          )
          return {
            processState: yield* db.getProcessStateByExecutionId(
              activeTodo.executionId,
            ),
            todoCompletionAttempts,
          }
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result.todoCompletionAttempts).toBe(2)
      expect(result.processState?.state).toEqual({
        _completionIdentity: {
          [seed.todoStepPath]: expect.objectContaining({
            email: "employee@example.com",
            rolePath: seed.rolePath,
          }),
        },
        submit: [{ title: "Request" }],
      })
    })
  })

  describe(`supporting roles (${db.name})`, () => {
    it("stores completingRolePath on scheduled_flow when starting a process", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const suffix = `${db.name}-sr-start-${uniqueSuffix()}`
      const seed = makeSupportingRoleStartOrganisation(suffix)

      const context = makeContext(
        "employee@example.com",
        seed.supportingRolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          yield* db.storeOrganisation(seed.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath, seed.supportingRolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const processId = yield* db.getProcessIdByPath(seed.processPath)
          const started = yield* startProcess(
            processId,
            seed.processPath,
            seed.startStepPath,
            { title: "Request" },
            seed.form.submissionEffectSchema,
            seed.form,
            context,
            { completingRolePath: seed.supportingRolePath },
          )
          const sf = yield* db.getFirstScheduledFlowForExecution(
            started.executionId,
          )
          const managerRoleId = yield* db.getRoleIdByPath(
            seed.supportingRolePath,
          )
          const employeeRoleId = yield* db.getRoleIdByPath(seed.rolePath)
          const startedByRole = yield* db.getProcessStateStartedByRole(
            started.executionId,
          )
          return {
            started,
            scheduledFlow: sf,
            managerRoleId,
            employeeRoleId,
            startedByRole,
          }
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result.scheduledFlow).not.toBeNull()
      expect(result.scheduledFlow!.completedByRoleId).toBe(result.managerRoleId)
      expect(result.scheduledFlow!.completedByRoleId).not.toBe(
        result.employeeRoleId,
      )
      expect(result.startedByRole).toBe(result.managerRoleId)
      expect(enqueuedJobs).toHaveLength(2)
      expect(enqueuedJobs[0]?.queue).toBe(FLOW_EXECUTION_QUEUE)
      expect(enqueuedJobs[1]?.queue).toBe(EXECUTION_EVENT_QUEUE)
    })

    it("stores completingRolePath on to_do when completing a step", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const suffix = `${db.name}-sr-todo-${uniqueSuffix()}`
      const seed = makeSupportingRoleTodoOrganisation(suffix)

      const context = makeContext(
        "employee@example.com",
        seed.supportingRolePath,
        seed.orgUnitPath,
      )

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const todo = yield* seedActiveTodo(db, {
            organisation: seed.org,
            orgUnitPath: seed.orgUnitPath,
            rolePath: seed.rolePath,
            processPath: seed.processPath,
            startStepPath: seed.startStepPath,
            todoStepPath: seed.todoStepPath,
            providerEmail: "employee@example.com",
            state: {},
          })
          // Also grant supporting role to the user
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            rolePaths: [seed.rolePath, seed.supportingRolePath],
            orgUnitPath: seed.orgUnitPath,
          })
          const completed = yield* completeStep(
            todo.todoId,
            { title: "Done" },
            seed.form,
            seed.form.submissionEffectSchema,
            context,
            { completingRolePath: seed.supportingRolePath },
          )
          const storedTodo = yield* db.getTodoById(todo.todoId)
          const managerRoleId = yield* db.getRoleIdByPath(
            seed.supportingRolePath,
          )
          const employeeRoleId = yield* db.getRoleIdByPath(seed.rolePath)
          return {
            completed,
            storedTodo,
            managerRoleId,
            employeeRoleId,
          }
        }),
        true,
        makeAuthorizationLayer(),
      )

      expect(result.storedTodo).not.toBeNull()
      expect(result.storedTodo!.completedByRoleId).toBe(result.managerRoleId)
      expect(result.storedTodo!.completedByRoleId).not.toBe(
        result.employeeRoleId,
      )
    })
  })

  describe(`startProcessExecution (${db.name})`, () => {
    it("counts only committed, non-deduplicated starts", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const suffix = `${db.name}-metric-${uniqueSuffix()}`
      const project = `metric-${suffix}`
      const executionId = `pex-${db.name}-metric-${uniqueSuffix()}`

      await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const seed = yield* seedStartOrganisation(db, suffix)
          yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            {},
            { executionId, trigger: "human" },
          )
          yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            {},
            { executionId, trigger: "human" },
          )
          yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            `${seed.startStepPath}/missing`,
            {},
            { trigger: "human" },
          ).pipe(Effect.either)
        }),
        true,
        makeBusinessMetricDimensionsLayer({
          account: { name: "CustomerOne", scope: "customer" },
          accountId: "111111111111",
          project,
          environment: "development",
        }),
      )

      const series = Metric.globalMetricRegistry
        .snapshot()
        .filter(
          (pair) =>
            pair.metricKey.name === "pf.business.process.starts" &&
            pair.metricKey.tags.some(
              (label) => label.key === "pf_project" && label.value === project,
            ),
        )
      expect(series).toHaveLength(1)
      const counter = series[0]?.metricState
      expect(MetricState.isCounterState(counter)).toBe(true)
      if (!MetricState.isCounterState(counter)) {
        throw new Error("Expected process starts to be a counter")
      }
      expect(counter.count).toBe(1)
    })

    it("keeps ordinary starts on the flow-execution path", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const suffix = `${db.name}-ordinary-${uniqueSuffix()}`

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const seed = yield* seedStartOrganisation(db, suffix)
          const started = yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            {},
          )
          const scheduledFlowIds = yield* db.getScheduledFlowIdsForExecution(
            started.executionId,
          )
          return { started, scheduledFlowIds }
        }),
      )

      expect(result.started.deduplicated).toBe(false)
      expect(result.scheduledFlowIds).toHaveLength(1)
      expect(enqueuedJobs).toEqual([
        {
          queue: FLOW_EXECUTION_QUEUE,
          payload: { scheduledFlowId: result.scheduledFlowIds[0] },
        },
        {
          queue: EXECUTION_EVENT_QUEUE,
          payload: { executionId: result.started.executionId },
        },
      ])
    })

    it("enqueues system-start steps for worker execution instead of flow evaluation", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const suffix = `${db.name}-system-${uniqueSuffix()}`

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const seed = yield* seedStartOrganisation(db, suffix, true)
          const started = yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            {},
            { enqueueStartSystemStep: true },
          )
          return { seed, started }
        }),
      )

      expect(result.started.deduplicated).toBe(false)
      expect(enqueuedJobs).toEqual([
        {
          queue: SYSTEM_STEP_EXECUTION_QUEUE,
          payload: {
            startsProcess: true,
            processExecutionId: result.started.executionId,
            stepId: result.seed.stepId,
            stepPath: result.seed.startStepPath,
          },
        },
        {
          queue: EXECUTION_EVENT_QUEUE,
          payload: { executionId: result.started.executionId },
        },
      ])
    })

    it("persists a caller-supplied executionId when provided", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const suffix = `${db.name}-caller-${uniqueSuffix()}`
      const executionId = `pex-${db.name}-caller-${uniqueSuffix()}`

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const seed = yield* seedStartOrganisation(db, suffix)
          const started = yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            {},
            { executionId },
          )
          const processState =
            yield* db.getProcessStateByExecutionId(executionId)
          return { started, processState }
        }),
      )

      expect(result.started.executionId).toBe(executionId)
      expect(result.started.deduplicated).toBe(false)
      expect(result.processState?.state).toEqual({})
      expect(enqueuedJobs.at(-1)).toEqual({
        queue: EXECUTION_EVENT_QUEUE,
        payload: { executionId },
      })
    })

    it("accepts a caller-supplied executionId at the 41-character limit", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const suffix = `${db.name}-limit-${uniqueSuffix()}`
      const executionId = `pex-${"a".repeat(37)}`

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const seed = yield* seedStartOrganisation(db, suffix)
          return yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            {},
            { executionId },
          )
        }),
      )

      expect(result.executionId).toBe(executionId)
      expect(result.deduplicated).toBe(false)
    })

    it("returns the existing execution for a duplicate caller-supplied executionId", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const suffix = `${db.name}-duplicate-${uniqueSuffix()}`
      const executionId = `pex-${db.name}-dup-${uniqueSuffix()}`

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const seed = yield* seedStartOrganisation(db, suffix)
          yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            { hello: "world" },
            { executionId },
          )
          enqueuedJobs.length = 0

          const started = yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            { hello: "world" },
            { executionId },
          )
          const processStates = yield* db.getProcessStatesByProcessId(
            seed.processId,
          )
          return { started, processStates }
        }),
      )

      expect(result.started.executionId).toBe(executionId)
      expect(result.started.deduplicated).toBe(true)
      expect(result.processStates).toHaveLength(1)
      expect(enqueuedJobs).toEqual([])
    })

    it("returns the existing execution when reused with different inbound start state", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const suffix = `${db.name}-state-${uniqueSuffix()}`
      const executionId = `pex-${db.name}-state-${uniqueSuffix()}`

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const seed = yield* seedStartOrganisation(db, suffix)
          yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            { hello: "different" },
            { executionId },
          )
          enqueuedJobs.length = 0

          const started = yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            { hello: "world" },
            { executionId },
          )
          const processStates = yield* db.getProcessStatesByProcessId(
            seed.processId,
          )
          return { started, processStates }
        }),
      )

      expect(result.started.executionId).toBe(executionId)
      expect(result.started.deduplicated).toBe(true)
      expect(result.processStates).toHaveLength(1)
      expect(result.processStates[0]?.state).toEqual({ hello: "different" })
      expect(enqueuedJobs).toEqual([])
    })

    it("does not require CompletedJobOperations for auto-generated executionIds", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const suffix = `${db.name}-autogen-${uniqueSuffix()}`

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const seed = yield* seedStartOrganisation(db, suffix)
          return yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            { hello: "world" },
          )
        }),
      )

      expect(result.executionId).toStartWith("pex-")
      expect(result.deduplicated).toBe(false)
    })

    it("re-enqueues the pending start flow for duplicate external-queue replays", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const suffix = `${db.name}-external-flow-${uniqueSuffix()}`
      const executionId = `pex-${db.name}-ext-${uniqueSuffix()}`

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const seed = yield* seedStartOrganisation(db, suffix)
          yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            { hello: "world" },
            { executionId },
          )
          const scheduledFlowIds =
            yield* db.getScheduledFlowIdsForExecution(executionId)
          enqueuedJobs.length = 0

          const started = yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            { hello: "world" },
            { executionId },
          )
          return { scheduledFlowIds, started, seed }
        }),
        false,
      )

      expect(result.started.deduplicated).toBe(true)
      expect(enqueuedJobs).toEqual([
        {
          queue: FLOW_EXECUTION_QUEUE,
          payload: { scheduledFlowId: result.scheduledFlowIds[0] },
        },
        {
          queue: EXECUTION_EVENT_QUEUE,
          payload: { executionId },
        },
      ])
    })

    it("re-enqueues a missed started-system-step job for duplicate external-queue replays", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const suffix = `${db.name}-external-system-${uniqueSuffix()}`
      const executionId = `pex-${db.name}-sys-${uniqueSuffix()}`

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const seed = yield* seedStartOrganisation(db, suffix, true)
          yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            { hello: "world" },
            { executionId, enqueueStartSystemStep: true },
          )
          enqueuedJobs.length = 0

          const started = yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            { hello: "world" },
            { executionId, enqueueStartSystemStep: true },
          )
          return { seed, started }
        }),
        false,
      )

      expect(result.started.deduplicated).toBe(true)
      expect(enqueuedJobs).toEqual([
        {
          queue: SYSTEM_STEP_EXECUTION_QUEUE,
          payload: {
            startsProcess: true,
            processExecutionId: executionId,
            stepId: result.seed.stepId,
            stepPath: result.seed.startStepPath,
          },
        },
        {
          queue: EXECUTION_EVENT_QUEUE,
          payload: { executionId },
        },
      ])
    })

    it("re-enqueues the downstream flow when a started system step already completed", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const suffix = `${db.name}-system-downstream-${uniqueSuffix()}`
      const executionId = `pex-${db.name}-down-${uniqueSuffix()}`

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const seed = yield* seedStartOrganisation(db, suffix, true)
          yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            { hello: "world" },
            { executionId, enqueueStartSystemStep: true },
          )
          const scheduledFlowOps = yield* ScheduledFlowOperations
          const scheduledFlowId = yield* scheduledFlowOps.insertScheduledFlow(
            executionId,
            seed.stepId,
          )
          enqueuedJobs.length = 0

          const started = yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            { hello: "world" },
            { executionId, enqueueStartSystemStep: true },
          )
          return { scheduledFlowId, started }
        }),
        false,
      )

      expect(result.started.deduplicated).toBe(true)
      expect(enqueuedJobs).toEqual([
        {
          queue: FLOW_EXECUTION_QUEUE,
          payload: { scheduledFlowId: result.scheduledFlowId },
        },
      ])
    })

    it("does not re-enqueue a completed started-system-step replay", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const suffix = `${db.name}-system-completed-${uniqueSuffix()}`
      const executionId = `pex-${db.name}-done-${uniqueSuffix()}`

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const seed = yield* seedStartOrganisation(db, suffix, true)
          yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            { hello: "world" },
            { executionId, enqueueStartSystemStep: true },
          )
          const completedJobOps = yield* CompletedJobOperations
          yield* completedJobOps.markJobCompleted(
            SYSTEM_STEP_EXECUTION_QUEUE,
            getStartedSystemStepCompletedJobId(executionId),
          )
          enqueuedJobs.length = 0

          return yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            { hello: "world" },
            { executionId, enqueueStartSystemStep: true },
          )
        }),
        false,
      )

      expect(result.deduplicated).toBe(true)
      expect(enqueuedJobs).toEqual([])
    })

    it("returns the existing execution after the start system step has written output", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const suffix = `${db.name}-patched-${uniqueSuffix()}`
      const executionId = `pex-${db.name}-patch-${uniqueSuffix()}`

      const result = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const seed = yield* seedStartOrganisation(db, suffix, true)
          yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            {},
            { executionId, enqueueStartSystemStep: true },
          )
          const processState =
            yield* db.getProcessStateByExecutionId(executionId)
          if (processState === null) {
            return yield* Effect.dieMessage(
              "Expected process state after start",
            )
          }
          const stepCompletionOps = yield* StepCompletionOperations
          yield* stepCompletionOps.updateProcessState(processState.id, {
            evaluation: "done",
          })
          enqueuedJobs.length = 0

          const started = yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            {},
            { executionId, enqueueStartSystemStep: true },
          )
          const patchedProcessState =
            yield* db.getProcessStateByExecutionId(executionId)
          return { started, patchedProcessState }
        }),
      )

      expect(result.started.executionId).toBe(executionId)
      expect(result.started.deduplicated).toBe(true)
      expect(result.patchedProcessState?.state).toEqual({
        evaluation: "done",
      })
      expect(enqueuedJobs).toEqual([])
    })

    it("rejects reusing a caller-supplied executionId for a different process or start step", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const suffix = `${db.name}-conflict-${uniqueSuffix()}`
      const executionId = `pex-${db.name}-conf-${uniqueSuffix()}`

      const error = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const seed = yield* seedTwoProcessStartOrganisation(db, suffix)
          yield* startProcessExecution(
            seed.firstProcessId,
            seed.firstProcessPath,
            seed.firstStartStepPath,
            {},
            { executionId },
          )
          enqueuedJobs.length = 0

          return yield* startProcessExecution(
            seed.secondProcessId,
            seed.secondProcessPath,
            seed.secondStartStepPath,
            {},
            { executionId },
          ).pipe(Effect.flip)
        }),
      )

      expect(error).toBeInstanceOf(ExecutionIdConflictError)
      if (!(error instanceof ExecutionIdConflictError)) {
        throw error
      }
      expect(error.executionId).toBe(executionId)
      expect(enqueuedJobs).toEqual([])
    })

    it("rejects invalid caller-supplied executionIds before insert", async () => {
      const enqueuedJobs: EnqueuedJob[] = []
      const suffix = `${db.name}-invalid-${uniqueSuffix()}`

      const errors = await runDbEffect(
        db,
        enqueuedJobs,
        Effect.gen(function* () {
          const seed = yield* seedStartOrganisation(db, suffix)
          const invalid = yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            {},
            { executionId: "invalid" },
          ).pipe(Effect.flip)
          const tooLong = yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            {},
            { executionId: `pex-${"a".repeat(38)}` },
          ).pipe(Effect.flip)
          const onlyHyphens = yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            {},
            { executionId: "pex----" },
          ).pipe(Effect.flip)
          const processStates = yield* db.getProcessStatesByProcessId(
            seed.processId,
          )
          return { invalid, tooLong, onlyHyphens, processStates }
        }),
      )

      for (const error of [
        errors.invalid,
        errors.tooLong,
        errors.onlyHyphens,
      ]) {
        expect(error).toBeInstanceOf(InputValidationError)
        if (!(error instanceof InputValidationError)) {
          throw error
        }
        expect(error.errors).toEqual([
          {
            field: "executionId",
            message:
              "must start with 'pex-', be followed by a letter or number, contain only letters, numbers, and hyphens, and be at most 41 characters",
          },
        ])
      }
      expect(errors.processStates).toEqual([])
      expect(enqueuedJobs).toEqual([])
    })
  })
}

runSuite(sqliteDbCase)
if (runPostgresDbSpecs) {
  runSuite(postgresDbCase)
}

const businessMetricsIntegrationIt =
  businessMetricsOtlpUrl !== null && businessMetricsPrometheusUrl !== null
    ? it
    : it.skip

businessMetricsIntegrationIt(
  "exports persisted process starts through OTLP and returns dashboard query results",
  async () => {
    if (
      businessMetricsOtlpUrl === null ||
      businessMetricsPrometheusUrl === null
    ) {
      throw new Error("Business metrics integration endpoints are required")
    }

    const suffix = `analytics-${uniqueSuffix()}`
    const projectPrefix = `metric-${suffix}`
    const primaryProject = `${projectPrefix}-primary`
    const stagingProject = `${projectPrefix}-staging`
    const secondAccountProject = `${projectPrefix}-second-account`
    const consoleProject = `${projectPrefix}-console`
    const firstHumanExecutionId = `pex-human-a-${uniqueSuffix()}`
    const secondHumanExecutionId = `pex-human-b-${uniqueSuffix()}`
    const secondsPerDay = 24 * 60 * 60
    const currentUtcDayStart =
      Math.floor(Date.now() / (secondsPerDay * 1_000)) * secondsPerDay
    const boundarySampleTimestamps: [number, ...number[]] = [
      (currentUtcDayStart - 2 * secondsPerDay + 60) * 1_000,
      (currentUtcDayStart - secondsPerDay - 60) * 1_000,
      (currentUtcDayStart - secondsPerDay + 60) * 1_000,
      (currentUtcDayStart - 60) * 1_000,
    ]
    const metricReader = new PeriodicExportingMetricReader({
      exporter: makeTimestampedMetricExporter(
        new OTLPMetricExporter({ url: businessMetricsOtlpUrl }),
        boundarySampleTimestamps,
      ),
      exportIntervalMillis: 60_000,
    })
    const telemetryLayer = Otel.NodeSdk.layer(() => ({
      resource: { serviceName: "process-start-analytics-integration" },
      metricReader,
    }))

    await runDbEffect(
      sqliteDbCase,
      [],
      Effect.gen(function* () {
        const seed = yield* seedStartOrganisation(sqliteDbCase, suffix)

        yield* Effect.gen(function* () {
          yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            {},
            { executionId: firstHumanExecutionId, trigger: "human" },
          )
          yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            {},
            { trigger: "automated" },
          )
        }).pipe(
          Effect.provide(
            makeBusinessMetricDimensionsLayer({
              account: { name: "CustomerOne", scope: "customer" },
              accountId: "111111111111",
              project: primaryProject,
              environment: "development",
            }),
          ),
        )
        yield* startProcessExecution(
          seed.processId,
          seed.processPath,
          seed.startStepPath,
          {},
          { trigger: "human" },
        ).pipe(
          Effect.provide(
            makeBusinessMetricDimensionsLayer({
              account: { name: "CustomerOne", scope: "customer" },
              accountId: "111111111111",
              project: stagingProject,
              environment: "staging",
            }),
          ),
        )
        yield* startProcessExecution(
          seed.processId,
          seed.processPath,
          seed.startStepPath,
          {},
          { trigger: "automated" },
        ).pipe(
          Effect.provide(
            makeBusinessMetricDimensionsLayer({
              account: { name: "CustomerTwo", scope: "customer" },
              accountId: "222222222222",
              project: secondAccountProject,
              environment: "production",
            }),
          ),
        )
        yield* startProcessExecution(
          seed.processId,
          seed.processPath,
          seed.startStepPath,
          {},
          { trigger: "human" },
        ).pipe(
          Effect.provide(
            makeBusinessMetricDimensionsLayer({
              account: { name: "Internal", scope: "internal" },
              accountId: "333333333333",
              project: consoleProject,
              environment: "production",
            }),
          ),
        )
        yield* Effect.promise(() => metricReader.forceFlush())
        yield* Effect.sleep("100 millis")

        yield* Effect.gen(function* () {
          yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            {},
            { executionId: firstHumanExecutionId, trigger: "human" },
          )
          yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            `${seed.startStepPath}/missing`,
            {},
            { trigger: "human" },
          ).pipe(Effect.either)
          yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            {},
            { executionId: secondHumanExecutionId, trigger: "human" },
          )
          yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            {},
            { trigger: "automated" },
          )
        }).pipe(
          Effect.provide(
            makeBusinessMetricDimensionsLayer({
              account: { name: "CustomerOne", scope: "customer" },
              accountId: "111111111111",
              project: primaryProject,
              environment: "development",
            }),
          ),
        )
        yield* startProcessExecution(
          seed.processId,
          seed.processPath,
          seed.startStepPath,
          {},
          { trigger: "human" },
        ).pipe(
          Effect.provide(
            makeBusinessMetricDimensionsLayer({
              account: { name: "CustomerOne", scope: "customer" },
              accountId: "111111111111",
              project: stagingProject,
              environment: "staging",
            }),
          ),
        )
        yield* startProcessExecution(
          seed.processId,
          seed.processPath,
          seed.startStepPath,
          {},
          { trigger: "automated" },
        ).pipe(
          Effect.provide(
            makeBusinessMetricDimensionsLayer({
              account: { name: "CustomerTwo", scope: "customer" },
              accountId: "222222222222",
              project: secondAccountProject,
              environment: "production",
            }),
          ),
        )
        yield* startProcessExecution(
          seed.processId,
          seed.processPath,
          seed.startStepPath,
          {},
          { trigger: "human" },
        ).pipe(
          Effect.provide(
            makeBusinessMetricDimensionsLayer({
              account: { name: "Internal", scope: "internal" },
              accountId: "333333333333",
              project: consoleProject,
              environment: "production",
            }),
          ),
        )
        yield* Effect.promise(() => metricReader.forceFlush())

        for (let boundarySample = 0; boundarySample < 2; boundarySample += 1) {
          yield* startProcessExecution(
            seed.processId,
            seed.processPath,
            seed.startStepPath,
            {},
            { trigger: "automated" },
          ).pipe(
            Effect.provide(
              makeBusinessMetricDimensionsLayer({
                account: { name: "CustomerOne", scope: "customer" },
                accountId: "111111111111",
                project: primaryProject,
                environment: "development",
              }),
            ),
          )
          yield* Effect.promise(() => metricReader.forceFlush())
        }
      }),
      true,
      telemetryLayer,
    )

    const selector = `pf_business_process_starts_total{pf_account_scope="customer",pf_project=~"${projectPrefix}-.+"}`
    const totals = await queryPrometheusUntil({
      prometheusUrl: businessMetricsPrometheusUrl,
      query: selector,
      ready: (results) =>
        results.length === 4 &&
        results.reduce(
          (total, result) => total + Number(result.value[1]),
          0,
        ) === 10,
      time: currentUtcDayStart - 60,
    })
    const totalBySeries = Object.fromEntries(
      totals.map((result) => [
        [
          result.metric["pf_account_name"],
          result.metric["pf_project"],
          result.metric["pf_environment"],
          result.metric["pf_trigger"],
        ].join("|"),
        Number(result.value[1]),
      ]),
    )
    expect(totalBySeries).toEqual({
      [`CustomerOne|${primaryProject}|development|automated`]: 4,
      [`CustomerOne|${primaryProject}|development|human`]: 2,
      [`CustomerOne|${stagingProject}|staging|human`]: 2,
      [`CustomerTwo|${secondAccountProject}|production|automated`]: 2,
    })

    const startCompletions = await queryPrometheusUntil({
      prometheusUrl: businessMetricsPrometheusUrl,
      query: selector.replace(
        "pf_business_process_starts_total",
        "pf_business_step_completions_total",
      ),
      ready: (results) =>
        results.length === 4 &&
        results.reduce((sum, row) => sum + Number(row.value[1]), 0) === 10,
      time: currentUtcDayStart - 60,
    })
    expect(startCompletions.map((row) => Number(row.value[1])).sort()).toEqual([
      2, 2, 2, 4,
    ])

    const excluded = await queryPrometheusUntil({
      prometheusUrl: businessMetricsPrometheusUrl,
      query: `pf_business_process_starts_total{pf_project="${consoleProject}"}`,
      ready: (results) => results.length === 0,
      time: currentUtcDayStart - 60,
    })
    expect(excluded).toEqual([])

    const utcDaily = await queryPrometheusRangeUntil({
      prometheusUrl: businessMetricsPrometheusUrl,
      query: `increase(pf_business_process_starts_total{pf_project="${primaryProject}",pf_trigger="automated"}[1d])`,
      start: currentUtcDayStart - secondsPerDay,
      end: currentUtcDayStart,
      step: secondsPerDay,
      ready: (results) =>
        results.length === 1 &&
        results[0]?.values.length === 2 &&
        results[0].values.every((value) => Number(value[1]) > 0),
    })
    expect(utcDaily[0]?.values).toEqual([
      [currentUtcDayStart - secondsPerDay, expect.any(String)],
      [currentUtcDayStart, expect.any(String)],
    ])
    for (const [, value] of utcDaily[0]?.values ?? []) {
      expect(Number(value)).toBeCloseTo(1, 2)
    }
  },
  { timeout: 30_000 },
)

businessMetricsIntegrationIt(
  "exports persisted step completions through OTLP and returns dashboard query results",
  async () => {
    if (
      businessMetricsOtlpUrl === null ||
      businessMetricsPrometheusUrl === null
    ) {
      throw new Error("Business metrics integration endpoints are required")
    }
    const projectPrefix = `completions-${uniqueSuffix()}`
    const day = 86_400
    const midnight = Math.floor(Date.now() / (day * 1000)) * day
    const metricReader = new PeriodicExportingMetricReader({
      exporter: makeTimestampedMetricExporter(
        new OTLPMetricExporter({ url: businessMetricsOtlpUrl }),
        [
          (midnight - 2 * day + 60) * 1000,
          (midnight - day - 60) * 1000,
          (midnight - day + 60) * 1000,
          (midnight - 60) * 1000,
        ],
      ),
      exportIntervalMillis: 60_000,
    })
    const telemetry = Otel.NodeSdk.layer(() => ({
      resource: { serviceName: "step-completion-analytics-integration" },
      metricReader,
    }))
    const scopes = [
      {
        account: { name: "CustomerOne", scope: "customer" as const },
        accountId: "111111111111",
        project: `${projectPrefix}-first`,
        environment: "development",
      },
      {
        account: { name: "CustomerOne", scope: "customer" as const },
        accountId: "111111111111",
        project: `${projectPrefix}-first`,
        environment: "staging",
      },
      {
        account: { name: "CustomerTwo", scope: "customer" as const },
        accountId: "222222222222",
        project: `${projectPrefix}-second`,
        environment: "production",
      },
      {
        account: { name: "Internal", scope: "internal" as const },
        accountId: "333333333333",
        project: `${projectPrefix}-console`,
        environment: "production",
      },
    ]

    await runDbEffect(
      sqliteDbCase,
      [],
      Effect.gen(function* () {
        for (let sample = 0; sample < 4; sample += 1) {
          for (const scope of scopes) {
            yield* Effect.gen(function* () {
              const suffix = uniqueSuffix()
              const seed = makeRestrictedTodoOrganisation(suffix)
              const context = makeContext(
                "employee@example.com",
                seed.rolePath,
                seed.orgUnitPath,
              )
              const todo = yield* seedActiveTodo(sqliteDbCase, {
                ...seed,
                organisation: seed.org,
              })
              const complete = completeStep(
                todo.todoId,
                { title: "Request" },
                seed.form,
                seed.form.submissionEffectSchema,
                context,
              )
              const queue = yield* QueueService
              // The real completion writes are rolled back when transactional enqueue fails.
              const rejected = yield* complete.pipe(
                Effect.provideService(QueueService, {
                  ...queue,
                  enqueue: (name) =>
                    Effect.fail(
                      new EnqueueError({
                        queue: name,
                        message: "Rollback completion",
                      }),
                    ),
                }),
                Effect.either,
              )
              expect(Either.isLeft(rejected)).toBe(true)
              expect(
                (yield* (yield* StepCompletionOperations).queryTodoForCompletionById(
                  todo.todoId,
                ))?.completed,
              ).toBe(false)
              // Also exercise a whole-operation retry following an actual rollback.
              const sqlClient = yield* SqlClient.SqlClient
              const concurrent = makeConcurrentTestClient(
                sqlClient,
                (attempt) => attempt === 1,
              )
              yield* complete.pipe(
                Effect.provideService(SqlClient.SqlClient, concurrent.client),
              )
              expect(concurrent.transactionAttempts()).toBe(2)
              // Replaying a completed human todo must not increase the successful count.
              yield* complete.pipe(Effect.either)
              expect(
                (yield* (yield* StepCompletionOperations).queryTodoForCompletionById(
                  todo.todoId,
                ))?.completed,
              ).toBe(true)

              const org = new Organisation({ name: `System metrics ${suffix}` })
              const unit = new OrgUnit(org, "Operations", {
                name: "Operations",
                type: "department",
              })
              const role = new Role(unit, "employee", { name: "Employee" })
              const process = new Process(unit, `automated-${suffix}`, {
                name: "Automated",
                purpose: "Completion analytics",
              })
              const start = new Form(process, "Start", {
                role,
                form: () => ({}),
              })
              const success = new NodeStep(process, "Success", {
                input: () => Effect.succeed({}),
                output: {},
                execute: () => Effect.succeed({}),
              })
              const failed = new NodeStep(process, "Failed", {
                input: () => Effect.succeed({}),
                output: {},
                execute: () =>
                  Effect.fail({
                    _tag: "ExpectedFailure",
                    message: "Failed business operation",
                    retryable: false,
                  }),
              })
              process.start(start).next(success).end()
              process.start(start).next(failed).end()
              const systemLayers = Layer.mergeAll(
                OrganisationProviderTest(org),
                Layer.succeed(SystemStepExecutor, makeSystemStepExecutor(org)),
                Layer.succeed(ConditionEvaluator, makeConditionEvaluator(org)),
              )
              const seedSystemTodo = (stepPath: string) =>
                seedActiveTodo(sqliteDbCase, {
                  organisation: org,
                  orgUnitPath: normalizePath(unit.node.path),
                  rolePath: normalizePath(role.node.path),
                  processPath: normalizePath(process.node.path),
                  startStepPath: normalizePath(start.node.path),
                  todoStepPath: stepPath,
                })
              for (const step of [success, failed]) {
                const stepPath = normalizePath(step.node.path)
                const active = yield* seedSystemTodo(stepPath)
                const now = yield* DateTime.now
                const job = {
                  jobId: `job-${uniqueSuffix()}`,
                  receipt: "test-receipt",
                  queue: SYSTEM_STEP_EXECUTION_QUEUE,
                  payload: { todoId: active.todoId, stepPath },
                  attempts: 1,
                  maxAttempts: 1,
                  availableAt: now,
                  lockedUntil: now,
                }
                yield* systemStepExecutionHandler
                  .handle(job)
                  .pipe(Effect.provide(systemLayers))
                yield* systemStepExecutionHandler
                  .handle(job)
                  .pipe(Effect.provide(systemLayers))
                const persisted = yield* sqliteDbCase.getTodoById(active.todoId)
                expect(persisted?.failureReason !== null).toBe(step === failed)
              }
              const asyncTodo = yield* seedSystemTodo(
                normalizePath(success.node.path),
              )
              const stepCompletionOps = yield* StepCompletionOperations
              const todoInfo = yield* stepCompletionOps.queryTodoById(
                asyncTodo.todoId,
              )
              if (!todoInfo)
                return yield* Effect.dieMessage("Missing callback todo")
              const callback = completeAsyncSystemStep({
                todoId: asyncTodo.todoId,
                stepPath: todoInfo.targetStepPath,
                output: {},
                todoInfo,
                isForEach: false,
                queueService: queue,
                stepCompletionOps,
                scheduledFlowOps: yield* ScheduledFlowOperations,
                flowExecutionOps: yield* FlowExecutionOperations,
                calendarQueries: yield* BusinessCalendarQueries,
                sqlClient,
              })
              expect(yield* callback).toBe(true)
              expect(yield* callback).toBe(false)

              // Starting automation is not itself a completion: only its successful worker result is.
              const systemStart = yield* seedStartOrganisation(
                sqliteDbCase,
                `system-start-${suffix}`,
                true,
              )
              const execution = yield* startProcessExecution(
                systemStart.processId,
                systemStart.processPath,
                systemStart.startStepPath,
                {},
                { enqueueStartSystemStep: true, trigger: "automated" },
              )
              const now = yield* DateTime.now
              const job = {
                jobId: `start-${suffix}`,
                receipt: "test-receipt",
                queue: SYSTEM_STEP_EXECUTION_QUEUE,
                payload: {
                  startsProcess: true as const,
                  processExecutionId: execution.executionId,
                  stepId: systemStart.stepId,
                  stepPath: systemStart.startStepPath,
                },
                attempts: 1,
                maxAttempts: 1,
                availableAt: now,
                lockedUntil: now,
              }
              const startLayers = Layer.mergeAll(
                OrganisationProviderTest(systemStart.org),
                Layer.succeed(
                  SystemStepExecutor,
                  makeSystemStepExecutor(systemStart.org),
                ),
              )
              yield* systemStepExecutionHandler
                .handle(job)
                .pipe(Effect.provide(startLayers))
              yield* systemStepExecutionHandler
                .handle(job)
                .pipe(Effect.provide(startLayers))
            }).pipe(Effect.provide(makeBusinessMetricDimensionsLayer(scope)))
          }
          yield* Effect.promise(() => metricReader.forceFlush())
        }
      }),
      true,
      Layer.merge(telemetry, makeAuthorizationLayer()),
    )

    const selector = `pf_business_step_completions_total{pf_project=~"${projectPrefix}-.+"}`
    const totals = await queryPrometheusUntil({
      prometheusUrl: businessMetricsPrometheusUrl,
      query: selector,
      ready: (results) =>
        results.length === 6 &&
        results.reduce((sum, row) => sum + Number(row.value[1]), 0) === 48,
      time: midnight - 60,
    })
    expect(
      Object.fromEntries(
        totals.map((row) => [
          [
            row.metric["pf_account_name"],
            row.metric["pf_environment"],
            row.metric["pf_trigger"],
          ].join("|"),
          Number(row.value[1]),
        ]),
      ),
    ).toEqual({
      "CustomerOne|development|human": 4,
      "CustomerOne|development|automated": 12,
      "CustomerOne|staging|human": 4,
      "CustomerOne|staging|automated": 12,
      "CustomerTwo|production|human": 4,
      "CustomerTwo|production|automated": 12,
    })
    const dashboard = await Bun.file(
      new URL(
        "../../grafana/dashboards/customer-process-starts.json",
        import.meta.url,
      ),
    ).json()
    const DashboardQueries = Schema.Struct({
      panels: Schema.Array(
        Schema.Struct({
          title: Schema.String,
          targets: Schema.Array(Schema.Struct({ expr: Schema.String })),
        }),
      ),
    })
    const { panels } = Schema.decodeUnknownSync(DashboardQueries)(dashboard)
    for (const title of [
      "Daily completed steps (UTC)",
      "Completed steps by project",
    ]) {
      const expression = panels.find((panel) => panel.title === title)
        ?.targets[0]?.expr
      if (!expression) throw new Error(`Missing ${title} query`)
      const query = expression
        .replaceAll("$account", "CustomerTwo")
        .replaceAll("$project", `${projectPrefix}-second`)
        .replaceAll("$environment", "production")
        .replaceAll("$__range", "1d")
      const results = await queryPrometheusRangeUntil({
        prometheusUrl: businessMetricsPrometheusUrl,
        query,
        start: midnight - day,
        end: midnight,
        step: day,
        ready: (rows) =>
          rows.length === 2 && rows.every((row) => row.values.length === 2),
      })
      for (const row of results) {
        for (const [, value] of row.values) {
          expect(Number(value)).toBeCloseTo(
            row.metric["pf_trigger"] === "human" ? 1 : 3,
            2,
          )
        }
      }
    }
  },
  { timeout: 60_000 },
)

it.each(["start", "completion"])(
  "form onSubmit commits, rolls back and avoids replay writes for %s",
  async (kind) => {
    const org = new Organisation({ name: "Submission callback" })
    const unit = new OrgUnit(org, `submission-${uniqueSuffix()}`, {
      name: "Submissions",
      type: "department",
    })
    const role = new Role(unit, "employee", { name: "Employee" })
    const process = new Process(unit, "request", {
      name: "Request",
      purpose: "Callback transaction test",
    })
    let submissionCalls = 0
    const onSubmit = ({ value }: { readonly value: string }) => {
      submissionCalls += 1
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO callback_records (value) VALUES (${value})`
        if (value === "reject")
          return yield* new FormSubmissionError({
            field: "value",
            message: "Rejected",
          })
      }).pipe(
        Effect.catchTag("SqlError", () =>
          Effect.fail(
            new FormSubmissionError({ field: "", message: "Write failed" }),
          ),
        ),
      )
    }
    const first = new Form(process, "Submit", {
      role,
      form: () => ({ value: Schema.String }),
      ...(kind === "start" ? { onSubmit } : {}),
    })
    const flow = process.start(first)
    const next = new Form(flow, "Confirm", {
      role,
      form: () => ({ value: Schema.String }),
      onSubmit,
    })
    flow.next(next).end()
    const processPath = normalizePath(process.node.path)
    const startStepPath = normalizePath(first.node.path)
    const orgUnitPath = normalizePath(unit.node.path)
    const rolePath = normalizePath(role.node.path)
    const context = makeContext("employee@example.com", rolePath, orgUnitPath)
    await runDbEffect(
      sqliteDbCase,
      [],
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE callback_records (value TEXT NOT NULL)`
        yield* sqliteDbCase.storeOrganisation(org)
        yield* sqliteDbCase.ensureProviderUser({
          email: "employee@example.com",
          rolePaths: [rolePath],
          orgUnitPath,
        })
        const processId = yield* sqliteDbCase.getProcessIdByPath(processPath)
        const active =
          kind === "completion"
            ? yield* seedActiveTodo(sqliteDbCase, {
                organisation: org,
                orgUnitPath,
                rolePath,
                processPath,
                startStepPath,
                todoStepPath: normalizePath(next.node.path),
              })
            : undefined
        const executionId = `pex-callback-${uniqueSuffix()}`
        const submit = (value: unknown) =>
          Effect.gen(function* () {
            if (active) {
              yield* completeStep(
                active.todoId,
                { value },
                next,
                next.submissionEffectSchema,
                context,
              )
            } else {
              yield* startProcess(
                processId,
                processPath,
                startStepPath,
                { value },
                first.submissionEffectSchema,
                first,
                context,
                { executionId },
              )
            }
          })
        expect((yield* submit(17).pipe(Effect.flip))._tag).toBe(
          "InputValidationError",
        )
        expect(yield* sql`SELECT * FROM callback_records`).toEqual([])
        expect(submissionCalls).toBe(0)
        const rejected = yield* submit("reject").pipe(Effect.flip)
        expect(rejected).toBeInstanceOf(InputValidationError)
        expect(submissionCalls).toBe(1)
        expect(yield* sql`SELECT * FROM callback_records`).toEqual([])
        if (kind === "start")
          expect(
            yield* sqliteDbCase.getProcessStatesByProcessId(processId),
          ).toEqual([])
        yield* submit("saved")
        expect(submissionCalls).toBe(2)
        expect(yield* sql`SELECT * FROM callback_records`).toEqual([
          { value: "saved" },
        ])
        yield* submit("saved")
        expect(submissionCalls).toBe(2)
        expect(yield* sql`SELECT * FROM callback_records`).toEqual([
          { value: "saved" },
        ])
      }),
      true,
      makeAuthorizationLayer(),
    )
  },
)
