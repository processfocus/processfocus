import { Clock, DateTime, Effect, Option } from "effect"
import {
  AuthenticationDatabase,
  captureRoleAuthority,
  checkProviderUserAuthority,
  checkWorkloadDeploymentAuthority,
} from "@pf/auth-api"
import { AuthorizationService } from "@pf/auth-policy"
import { subjects } from "@pf/auth-session"
import { DelegationSessionService } from "@pf/delegation/authorization"
import { NotAuthorized } from "@pf/graphql-schema"
import { RequestTime } from "@pf/request-time"
import { hasDelegation, isProviderUserSession } from "./session-guards"
import type { JWTPayload } from "./types"

const acceptProviderUserJwt = (
  jwt: JWTPayload,
): Effect.Effect<JWTPayload, NotAuthorized> =>
  Effect.gen(function* () {
    if (jwt.type !== "providerUser") return jwt
    const unavailable = () =>
      new NotAuthorized({
        action: "login",
        resource: "GraphQL",
        message: "Session authority revoked",
      })
    const parsed = yield* Effect.promise(async () =>
      subjects.providerUser["~standard"].validate(jwt.properties),
    )
    const db = yield* Effect.serviceOption(AuthenticationDatabase)
    const auth = yield* Effect.serviceOption(AuthorizationService)
    if (
      parsed.issues ||
      Option.isNone(db) ||
      Option.isNone(auth) ||
      !Number.isFinite(jwt.exp) ||
      (yield* Clock.currentTimeMillis) >= jwt.exp * 1000 ||
      (parsed.value.sso && jwt.exp * 1000 > parsed.value.sso.expiresAt)
    )
      return yield* unavailable()
    const valid = yield* checkProviderUserAuthority(parsed.value).pipe(
      Effect.provide(
        yield* captureRoleAuthority.pipe(
          Effect.provideService(AuthenticationDatabase, db.value),
        ),
      ),
      Effect.provideService(AuthorizationService, auth.value),
      Effect.provideService(RequestTime, yield* DateTime.now),
      Effect.mapError(unavailable),
    )
    if (!valid) return yield* unavailable()
    return { ...jwt, properties: parsed.value }
  })

/** Called after JWT signature, issuer, audience and expiry verification. */
export const acceptVerifiedGraphqlJwt = (
  jwt: JWTPayload | undefined,
): Effect.Effect<JWTPayload | undefined, NotAuthorized> =>
  Effect.gen(function* () {
    if (jwt && "awsRole" in jwt.properties)
      return yield* new NotAuthorized({
        action: "login",
        resource: "GraphQL",
        message: "AWS identity requires a fresh request proof",
      })
    if (jwt && "workload" in jwt.properties) {
      const parsed = yield* Effect.promise(async () =>
        subjects[jwt.type]["~standard"].validate(jwt.properties),
      )
      if (
        parsed.issues ||
        !parsed.value.workload ||
        jwt.exp * 1000 > parsed.value.workload.expiresAt ||
        (yield* Clock.currentTimeMillis) >=
          Math.min(jwt.exp * 1000, parsed.value.workload.expiresAt) ||
        ("email" in parsed.value &&
          (parsed.value.humanSession ||
            parsed.value.humanAuthentication ||
            parsed.value.delegation))
      )
        return yield* new NotAuthorized({
          action: "login",
          resource: "GraphQL",
          message: "Invalid workload session",
        })
      if (
        !("email" in parsed.value) &&
        (parsed.value.roles?.includes("/Workload deploy") ||
          parsed.value.workload.deploymentAuthorityVersion !== undefined)
      ) {
        const db = yield* Effect.serviceOption(AuthenticationDatabase)
        const valid =
          Option.isSome(db) &&
          (yield* checkWorkloadDeploymentAuthority(parsed.value).pipe(
            Effect.provideService(AuthenticationDatabase, db.value),
            Effect.catch(() => Effect.succeed(false)),
          ))
        if (!valid)
          return yield* new NotAuthorized({
            action: "login",
            resource: "GraphQL",
            message: "Deployment authority revoked",
          })
      }
      return yield* acceptProviderUserJwt({ ...jwt, properties: parsed.value })
    }
    if (!hasDelegation(jwt?.properties))
      return jwt ? yield* acceptProviderUserJwt(jwt) : jwt
    const unavailable = () =>
      new NotAuthorized({
        action: "login",
        resource: "GraphQL",
        message: "Delegated access is unavailable or invalid",
      })
    if (
      jwt?.type !== "providerUser" ||
      !isProviderUserSession(jwt.properties)
    ) {
      return yield* unavailable()
    }
    const parsed = yield* Effect.promise(() =>
      Promise.resolve(
        subjects.providerUser["~standard"].validate(jwt.properties),
      ),
    )
    if (parsed.issues) return yield* unavailable()
    // No fallback layer: public activation awaits owner lifecycle and realtime.
    const service = yield* Effect.serviceOption(DelegationSessionService)
    if (Option.isNone(service)) return yield* unavailable()
    const properties = yield* service.value
      .check(parsed.value)
      .pipe(Effect.mapError(unavailable))
    if (jwt.exp * 1000 > properties.delegation.expiresAt)
      return yield* unavailable()
    return { ...jwt, properties }
  })
