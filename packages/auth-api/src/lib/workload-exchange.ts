import { Clock, DateTime, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { createLocalJWKSet, jwtVerify } from "jose"
import {
  ProjectWorkloadPermissionSchema,
  ProjectWorkloadSchema,
  WorkloadTrustConfigSchema,
} from "@pf/auth-config/runtime"
import { type ServiceAccountSession, subjects } from "@pf/auth-session"
import {
  ClientRegistryService,
  type IssuerCallbacks,
  KeyManagementService,
  OAuthEndpointError,
} from "@pf/openauth"
import { AuthenticationDatabase } from "./authentication-database.js"
import { handleM2MUserToken } from "./provider/confidential-client.js"
import { workloadDeploymentAuthorityVersion } from "./workload-deployment-authority.js"

const githubIssuer = "https://token.actions.githubusercontent.com"
const text = Schema.String.pipe(Schema.check(Schema.isMinLength(1)))
const Claims = Schema.Struct({
  sub: text,
  aud: text,
  repository_id: text,
  repository_owner_id: text,
  repository: Schema.optional(text),
  workflow_ref: text,
  job_workflow_ref: Schema.optional(text),
  ref: text,
  event_name: text,
  environment: Schema.optionalKey(text),
  sha: text,
  run_id: text,
  run_attempt: text,
})
const Keys = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      kty: Schema.String,
      kid: Schema.String,
      n: Schema.optionalKey(Schema.String),
      e: Schema.optionalKey(Schema.String),
      alg: Schema.optionalKey(Schema.String),
      use: Schema.optionalKey(Schema.String),
    }),
  ),
})
const rejected = () =>
  new OAuthEndpointError({
    error: "invalid_grant",
    description: "Token exchange rejected",
    statusCode: 400,
  })

/** Capture real operations and HTTP services at composition, never credentials in diagnostics. */
export const makeWorkloadExchange: Effect.Effect<
  NonNullable<IssuerCallbacks["Service"]["exchange"]>,
  never,
  | AuthenticationDatabase
  | HttpClient.HttpClient
  | ClientRegistryService
  | KeyManagementService
> = Effect.gen(function* () {
  const db = yield* AuthenticationDatabase
  const http = yield* HttpClient.HttpClient
  const registry = yield* ClientRegistryService
  const keysService = yield* KeyManagementService
  return (input: {
    readonly assertion: string
    readonly assertionType: string
    readonly scope: string | undefined
    readonly clientId: string | undefined
    readonly audience: string | undefined
    readonly issuer: string
  }) =>
    Effect.gen(function* () {
      if (
        input.assertionType === "urn:ietf:params:oauth:token-type:access_token"
      ) {
        const keys = yield* keysService.allSigningKeys
        const now = yield* DateTime.now
        const { payload } = yield* Effect.tryPromise({
          try: () =>
            jwtVerify(
              input.assertion,
              async (header) => {
                const key = keys.find(
                  (key) => key.id === header.kid && key.alg === header.alg,
                )
                if (!key) throw new Error("Unknown signing key")
                return key.public
              },
              {
                issuer: input.issuer,
                requiredClaims: ["exp", "sub", "aud"],
                currentDate: DateTime.toDateUtc(now),
              },
            ),
          catch: () => rejected(),
        })
        if (
          payload["mode"] !== "access" ||
          payload["type"] !== "user" ||
          typeof payload.aud !== "string" ||
          payload.exp === undefined ||
          (input.audience !== undefined && input.audience !== payload.aud)
        )
          return yield* rejected()
        const scope = input.scope?.split(/\s+/).filter(Boolean) ?? []
        const parsed = yield* Effect.promise(async () =>
          subjects.user["~standard"].validate(payload["properties"]),
        )
        const selectedScope = scope[0]
        if (
          parsed.issues ||
          scope.length !== 1 ||
          !selectedScope?.startsWith("role:") ||
          (input.clientId !== undefined &&
            input.clientId !== parsed.value.clientId)
        )
          return yield* rejected()
        const machine = parsed.value
        const workload = machine.workload
        if (!workload) return yield* rejected()
        const expiresAt = Math.min(payload.exp * 1000, workload.expiresAt)
        if (expiresAt <= DateTime.toEpochMillis(now)) return yield* rejected()
        const role = yield* Effect.try({
          try: () => decodeURIComponent(selectedScope.slice(5)),
          catch: () => rejected(),
        })
        const result = yield* handleM2MUserToken(machine.clientId, [role]).pipe(
          Effect.provideService(AuthenticationDatabase, db),
        )
        if (result instanceof Response || result.type !== "user")
          return yield* rejected()
        return {
          type: result.type,
          properties: {
            ...result.properties,
            workload: { ...workload, expiresAt },
          },
          subject: `user:${machine.userId}`,
          clientId: machine.clientId,
          audience: payload.aud,
          expiresAt,
        }
      }
      const purpose = input.scope
      if (
        purpose !== undefined &&
        !Schema.is(ProjectWorkloadPermissionSchema)(purpose)
      )
        return yield* rejected()
      // Fixed trusted URL, no discovery or redirects derived from assertion headers/claims.
      const response = yield* http.get(`${githubIssuer}/.well-known/jwks`)
      if (response.status !== 200) return yield* rejected()
      const keys = yield* HttpClientResponse.schemaBodyJson(Keys)(response)
      const now = yield* DateTime.now
      const { payload } = yield* Effect.tryPromise({
        try: () =>
          jwtVerify(
            input.assertion,
            createLocalJWKSet({ keys: [...keys.keys] }),
            {
              algorithms: ["RS256"],
              issuer: githubIssuer,
              requiredClaims: ["iss", "aud", "sub", "iat", "nbf", "exp"],
              maxTokenAge: "10m",
              clockTolerance: 30,
              currentDate: DateTime.toDateUtc(now),
            },
          ),
        catch: rejected,
      })
      const claims = yield* Schema.decodeUnknownEffect(Claims)(payload)
      const clients = yield* db.findAllOAuthClients()
      for (const client of clients) {
        const decoded = Schema.decodeUnknownOption(ProjectWorkloadSchema)(
          client.workloadTrust,
        )
        if (Option.isNone(decoded)) continue
        const registration = decoded.value
        const identity = registration.identity
        const audience =
          identity.kind === "pending"
            ? identity.enrollmentAudience
            : registration.assertionAudience
        if (claims.aud !== audience) continue
        if (
          !registration.enabled ||
          client.secretHash !== "" ||
          registry.staticClients.has(client.clientId) ||
          registration.targetIssuer !== input.issuer ||
          claims.repository !== registration.repository ||
          claims.workflow_ref !== registration.workflowRef ||
          claims.ref !== registration.ref ||
          claims.environment !== registration.environment ||
          // Direct jobs may include a self-reference; a different reusable
          // workflow still requires separate trust and must be rejected.
          (claims.job_workflow_ref !== undefined &&
            claims.job_workflow_ref !== registration.workflowRef) ||
          !registration.events.some((event) => event === claims.event_name) ||
          (input.clientId !== undefined &&
            input.clientId !== client.clientId) ||
          (input.audience !== undefined && input.audience !== client.audience)
        )
          return yield* rejected()
        if (identity.kind === "pending") {
          const persistedTrust = client.workloadTrust
          if (
            !Schema.is(Schema.Record(Schema.String, Schema.Unknown))(
              persistedTrust,
            )
          )
            return yield* rejected()
          if (
            !(yield* db.enrollProjectWorkload(client.clientId, persistedTrust, {
              ...persistedTrust,
              ...registration,
              identity: {
                kind: "enrolled",
                repositoryId: claims.repository_id,
                repositoryOwnerId: claims.repository_owner_id,
              },
            }))
          )
            return yield* rejected()
          // Enrollment returns only a short, roleless machine receipt. Deployment
          // uses a fresh assertion for the distinct, permanent assertion audience.
          const userId = yield* db.upsertM2MUser(client.clientId, now)
          return {
            type: "user",
            properties: { userId, clientId: client.clientId, roles: [] },
            subject: `user:${userId}`,
            clientId: client.clientId,
            audience: client.audience,
            expiresAt: DateTime.toEpochMillis(now) + 30_000,
          }
        }
        if (
          identity.repositoryId !== claims.repository_id ||
          identity.repositoryOwnerId !== claims.repository_owner_id
        )
          return yield* rejected()
        if (purpose !== undefined) {
          if (!registration.permissions.includes(purpose))
            return yield* rejected()
          const userId = yield* db.upsertM2MUser(client.clientId, now)
          const expiresAt = DateTime.toEpochMillis(now) + 15 * 60_000
          return {
            type: "user",
            properties: {
              userId,
              clientId: client.clientId,
              roles: ["/Project workload", `/Workload ${purpose}`],
              workload: {
                bindingId: client.clientId,
                deploymentAuthorityVersion: workloadDeploymentAuthorityVersion(
                  client.workloadTrust,
                ),
                repositoryId: claims.repository_id,
                repositoryOwnerId: claims.repository_owner_id,
                workflowRef: claims.workflow_ref,
                ref: claims.ref,
                event: claims.event_name,
                environment: claims.environment,
                sha: claims.sha,
                runId: claims.run_id,
                runAttempt: claims.run_attempt,
                expiresAt,
              },
            },
            subject: `user:${userId}`,
            clientId: client.clientId,
            audience: client.audience,
            expiresAt,
          }
        }
        // Enrolled project identities must select a granted machine purpose.
        return yield* rejected()
      }
      const matches = []
      for (const client of clients) {
        if (client.workloadTrust == null || client.secretHash !== "") continue
        if (
          Option.isSome(
            Schema.decodeUnknownOption(ProjectWorkloadSchema)(
              client.workloadTrust,
            ),
          )
        )
          continue
        const config = yield* Schema.decodeUnknownEffect(
          WorkloadTrustConfigSchema,
        )(client.workloadTrust)
        for (const binding of config.bindings) {
          if (
            binding.issuer === githubIssuer &&
            binding.targetIssuer === input.issuer &&
            binding.assertionAudience === claims.aud &&
            binding.repositoryId === claims.repository_id &&
            binding.repositoryOwnerId === claims.repository_owner_id &&
            binding.workflowRef === claims.workflow_ref &&
            binding.jobWorkflowRef === claims.job_workflow_ref &&
            binding.refs.includes(claims.ref) &&
            binding.events.includes(claims.event_name) &&
            binding.environment === claims.environment
          )
            matches.push({
              client,
              binding,
              deploymentProjects: config.deploymentProjects,
              databaseTransferProjects: config.databaseTransferProjects,
            })
        }
      }
      const match = matches[0]
      if (
        matches.length !== 1 ||
        !match ||
        // Static registrations take precedence during ordinary client authentication.
        // A workload identity must not also select that authentication method.
        registry.staticClients.has(match.client.clientId) ||
        (input.clientId !== undefined &&
          input.clientId !== match.client.clientId) ||
        (input.audience !== undefined &&
          input.audience !== match.client.audience)
      )
        return yield* rejected()
      const { client, binding, deploymentProjects } = match
      // Configured clients grant deployment through their explicit project list.
      if (
        purpose !== undefined &&
        !(purpose === "deploy"
          ? deploymentProjects?.length
          : (purpose === "database-download" ||
              purpose === "database-upload") &&
            match.databaseTransferProjects?.length)
      )
        return yield* rejected()
      const expiresAt =
        (yield* Clock.currentTimeMillis) + binding.lifetimeSeconds * 1000
      const userId = yield* db.upsertM2MUser(client.clientId, now)
      const properties: ServiceAccountSession = {
        userId,
        clientId: client.clientId,
        roles:
          purpose !== undefined
            ? ["/Project workload", `/Workload ${purpose}`]
            : [],
        workload: {
          bindingId: binding.id,
          ...(purpose !== undefined
            ? {
                deploymentAuthorityVersion: workloadDeploymentAuthorityVersion(
                  client.workloadTrust,
                ),
              }
            : {}),
          repositoryId: claims.repository_id,
          repositoryOwnerId: claims.repository_owner_id,
          workflowRef: claims.workflow_ref,
          ...(claims.job_workflow_ref
            ? { jobWorkflowRef: claims.job_workflow_ref }
            : {}),
          ref: claims.ref,
          event: claims.event_name,
          environment: binding.environment,
          sha: claims.sha,
          runId: claims.run_id,
          runAttempt: claims.run_attempt,
          expiresAt,
        },
      }
      return {
        type: "user",
        properties,
        subject: `user:${userId}`,
        clientId: client.clientId,
        audience: client.audience,
        expiresAt,
      }
    }).pipe(Effect.mapError(rejected))
})
