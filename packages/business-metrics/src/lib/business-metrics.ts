import { Context, Effect, Layer, Metric, Option } from "effect"

export type ReportingScope = "customer" | "internal" | "unclassified"
export type ProcessStartTrigger = "automated" | "human"

export interface BusinessMetricDimensionsValue {
  readonly accountId: string
  readonly accountName: string
  readonly accountScope: ReportingScope
  readonly project: string
  readonly environment: string
}

export interface BusinessMetricDimensionInput {
  readonly accountId: string | undefined
  readonly account?: {
    readonly name: string
    readonly scope: "customer" | "internal"
  }
  readonly project: string | undefined
  readonly environment: string | undefined
}

/**
 * Runtime adapters own account classification. Missing classification stays
 * unclassified, so generic/local runtimes do not emit customer metrics by default.
 */
export const resolveBusinessMetricDimensions = (
  input: BusinessMetricDimensionInput,
): BusinessMetricDimensionsValue => {
  const accountId = input.accountId ?? "unknown"
  const account = input.account

  return {
    accountId,
    accountName: account?.name ?? "Unclassified",
    accountScope: account?.scope ?? "unclassified",
    project: input.project ?? "unknown",
    environment: input.environment ?? "unknown",
  }
}

/** Runtime-provided dimensions for low-cardinality internal business metrics. */
export class BusinessMetricDimensions extends Context.Tag(
  "@pf/business-metrics/BusinessMetricDimensions",
)<BusinessMetricDimensions, BusinessMetricDimensionsValue>() {}

export const makeBusinessMetricDimensionsLayer = (
  input: BusinessMetricDimensionInput,
): Layer.Layer<BusinessMetricDimensions> =>
  Layer.succeed(
    BusinessMetricDimensions,
    resolveBusinessMetricDimensions(input),
  )

const processStarts = Metric.counter("pf.business.process.starts", {
  description: "Successfully persisted Process Execution starts",
  incremental: true,
})

const stepCompletions = Metric.counter("pf.business.step.completions", {
  description: "Successfully persisted step completions",
  incremental: true,
})

const externalActions = Metric.counter("pf.business.external.actions", {
  description:
    "Successfully persisted external submissions and public Todo completions; not distinct people",
  incremental: true,
})

const tagCounter =
  (key: string, value: string) =>
  (counter: typeof processStarts): typeof processStarts =>
    Metric.tagged(counter, key, value)

/**
 * Record after the business-outcome transaction commits. Customer-account classification
 * excludes internal and unknown workloads before a metric point is created.
 */
const recordSuccessfulOutcome = (
  counter: typeof processStarts,
  outcomeLabel:
    | readonly ["pf_trigger", ProcessStartTrigger]
    | readonly ["pf_action", "submission" | "todo_completion"],
): Effect.Effect<void> =>
  Effect.serviceOption(BusinessMetricDimensions).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (dimensions) => {
          if (dimensions.accountScope !== "customer") return Effect.void

          return Metric.increment(
            counter.pipe(
              tagCounter("pf_account_id", dimensions.accountId),
              tagCounter("pf_account_name", dimensions.accountName),
              tagCounter("pf_account_scope", dimensions.accountScope),
              tagCounter("pf_project", dimensions.project),
              tagCounter("pf_environment", dimensions.environment),
              tagCounter(outcomeLabel[0], outcomeLabel[1]),
            ),
          )
        },
      }),
    ),
  )

export const recordSuccessfulProcessStart = (
  trigger: ProcessStartTrigger,
): Effect.Effect<void> =>
  recordSuccessfulOutcome(processStarts, ["pf_trigger", trigger])

/** Emit only after the completion transaction commits, before queue dispatch. */
export const recordSuccessfulStepCompletion = (
  trigger: ProcessStartTrigger,
): Effect.Effect<void> =>
  recordSuccessfulOutcome(stepCompletions, ["pf_trigger", trigger])

/** Terminal outcome of one deployment pipeline, including post-activation cleanup. */
export const recordDeploymentOutcome = ({
  target,
  outcome,
}: {
  readonly target: BusinessMetricDimensionsValue
  readonly outcome: "success" | "failure"
}): Effect.Effect<void> => {
  const dimensions = target
  if (dimensions.accountScope !== "customer") return Effect.void

  return Metric.increment(
    Metric.counter("pf.business.deployment.attempts", {
      description: "Terminal deployment pipeline attempts including cleanup",
      incremental: true,
    }).pipe(
      tagCounter("pf_account_id", dimensions.accountId),
      tagCounter("pf_account_name", dimensions.accountName),
      tagCounter("pf_account_scope", dimensions.accountScope),
      tagCounter("pf_project", dimensions.project),
      tagCounter("pf_environment", dimensions.environment),
      tagCounter("pf_outcome", outcome),
    ),
  )
}

/** Count actions after commit, without participant identity or human-session provenance. */
export const recordSuccessfulExternalAction = (
  action: "submission" | "todo_completion",
): Effect.Effect<void> =>
  recordSuccessfulOutcome(externalActions, ["pf_action", action])
