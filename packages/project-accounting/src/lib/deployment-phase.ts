import { Context, type Effect, Schema } from "effect"

export const DEPLOYMENT_PHASE_PREFIX = "deploy-phases/"
export const DEPLOYMENT_PHASE_QUEUE = "deployment-phase"

// The phase/message pair selects a fixed label. Never persist a producer's
// arbitrary message, terminal CLI output, or heartbeat.
const labels = {
  setup: ["Setting up deployment..."],
  runner: ["Starting deployment runner..."],
  dependencies: ["Installing deployment dependencies..."],
  "build-environments": ["Preparing build environments..."],
  prepare: ["Validating deployment artifact..."],
  store: ["Deploying database and document store"],
  backend: ["Deploying backend"],
  database: ["Running database migrations"],
  import: ["Importing organisation"],
  "frontend-build": ["Building frontend"],
  "frontend-deploy": ["Deploying frontend"],
  cdn: ["Deploying CDN", "Preparing canary"],
  smoke: [
    "Running smoke tests against canary.",
    "Running smoke tests against primary distribution.",
  ],
  promote: ["Activating new deployment", "Promoting new deployment"],
}

export const DeploymentPhaseObservation = Schema.Struct({
  label: Schema.Literals(Object.values(labels).flat()),
  occurredAt: Schema.Int,
  sequence: Schema.Int,
})
export type DeploymentPhaseObservation = typeof DeploymentPhaseObservation.Type

export const deploymentPhaseLabel = (phase: string, message: string) =>
  Object.entries(labels)
    .find(([key]) => key === phase)?.[1]
    .find((label) => label === message)

export const DeploymentPhaseDelivery = Schema.Struct({
  ...DeploymentPhaseObservation.fields,
  todoId: Schema.String,
  restartAttemptId: Schema.NullOr(Schema.String),
})
export type DeploymentPhaseDelivery = typeof DeploymentPhaseDelivery.Type

export const deploymentPhaseObjectKey = (input: {
  todoId: string
  attemptId: string
  restartAttemptId: string | null
}): string =>
  `${DEPLOYMENT_PHASE_PREFIX}${input.todoId}/${input.attemptId}/${input.restartAttemptId ?? "initial"}/phase.json`

export class DeploymentPhaseWriter extends Context.Service<
  DeploymentPhaseWriter,
  {
    readonly save: (
      delivery: DeploymentPhaseDelivery,
    ) => Effect.Effect<boolean, unknown>
  }
>()("@pf/project-accounting/DeploymentPhaseWriter") {}
