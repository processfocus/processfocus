import { Context, Data, Effect, Option, Schema } from "effect"
import type { UserContext } from "./types"

export const DeploymentProbeRequest = Schema.Struct({
  correlation: Schema.String.pipe(Schema.check(Schema.isUUID())),
  project: Schema.String,
  environment: Schema.String,
  color: Schema.Literals(["blue", "green"]),
})
export type DeploymentProbeRequest = typeof DeploymentProbeRequest.Type

export const DeploymentProbeIdentity = Schema.Struct({
  project: Schema.String,
  environment: Schema.String,
  color: Schema.Literals(["blue", "green"]),
  functionName: Schema.String,
})

export const DeploymentProbeReceipt = Schema.Struct({
  request: DeploymentProbeRequest,
  expiresAt: Schema.Number,
  ingress: DeploymentProbeIdentity,
  worker: Schema.optional(DeploymentProbeIdentity),
})
export type DeploymentProbeReceipt = typeof DeploymentProbeReceipt.Type

export class DeploymentProbeError extends Data.TaggedError(
  "DeploymentProbeError",
)<{
  readonly message: string
}> {}

export class DeploymentProbe extends Context.Service<
  DeploymentProbe,
  {
    readonly start: (
      request: DeploymentProbeRequest,
    ) => Effect.Effect<DeploymentProbeReceipt, DeploymentProbeError>
    readonly status: (
      request: DeploymentProbeRequest,
    ) => Effect.Effect<DeploymentProbeReceipt | null, DeploymentProbeError>
  }
>()("@pf/graphql-api/DeploymentProbe") {}

/** Cedar also gates the fields; no user/admin role substitutes for the frontend credential. */
export const resolveDeploymentProbe = (
  operation: "start" | "status",
  input: unknown,
  context: UserContext,
) =>
  Effect.gen(function* () {
    const principal = context.jwt?.properties
    if (
      !principal ||
      !("clientId" in principal) ||
      principal.clientId !== "frontend"
    ) {
      return yield* new DeploymentProbeError({
        message: "Frontend service credential required",
      })
    }
    const request = yield* Schema.decodeUnknownEffect(DeploymentProbeRequest)(
      input,
    ).pipe(
      Effect.mapError(
        () =>
          new DeploymentProbeError({
            message: "Invalid deployment probe request",
          }),
      ),
    )
    const service = yield* Effect.serviceOption(DeploymentProbe)
    if (Option.isNone(service))
      return yield* new DeploymentProbeError({
        message: "Deployment probe unavailable",
      })
    return yield* service.value[operation](request)
  })
