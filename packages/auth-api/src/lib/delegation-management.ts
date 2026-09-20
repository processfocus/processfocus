import { createHash, randomBytes, randomUUID } from "node:crypto"
import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Data, DateTime, Effect, FiberRef, Option, Schema } from "effect"
import { jwtVerify } from "jose"
import {
  AuthorizationService,
  DelegationPrincipal,
  ProviderUserPrincipal,
} from "@pf/auth-policy"
import { subjects } from "@pf/auth-session"
import {
  ClientRegistryService,
  type Issuer,
  KeyManagementService,
  getIssuerUrl,
} from "@pf/openauth"
import { RequestTime } from "@pf/request-time"
import { AuthenticationDatabase } from "./authentication-database.js"
import {
  DelegationDatabase,
  type DelegationRecord,
} from "./delegation-database.js"
import { makeDelegationSessionChecker } from "./delegation-session.js"

class DelegationRequestError extends Data.TaggedError(
  "DelegationRequestError",
)<{
  readonly status: number
  readonly error: string
}> {}

const CreateDelegation = Schema.Struct({
  requestId: Schema.optional(Schema.UUID),
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  lifetimeDays: Schema.Literal(1, 7, 14),
})

const staleGuard = {
  id: Schema.String.pipe(Schema.minLength(1)),
  generationId: Schema.String.pipe(Schema.minLength(1)),
  expectedName: CreateDelegation.fields.name,
}
const ChangeDelegation = Schema.Union(
  Schema.Struct({
    operation: Schema.Literal("rename"),
    ...staleGuard,
    name: CreateDelegation.fields.name,
  }),
  Schema.Struct({
    operation: Schema.Literal("replace"),
    ...staleGuard,
    name: CreateDelegation.fields.name,
    lifetimeDays: CreateDelegation.fields.lifetimeDays,
  }),
  Schema.Struct({ operation: Schema.Literal("revoke"), ...staleGuard }),
)

const metadata = (record: DelegationRecord, now: DateTime.Utc) => ({
  id: record.id,
  name: record.name,
  generationId: record.generationId,
  createdAt: DateTime.formatIso(record.createdAt),
  expiresAt: DateTime.formatIso(record.expiresAt),
  revokedAt:
    record.revokedAt === null ? null : DateTime.formatIso(record.revokedAt),
  status:
    record.revokedAt !== null
      ? "revoked"
      : DateTime.lessThanOrEqualTo(record.expiresAt, now)
        ? "expired"
        : "active",
  lastUsedAt:
    record.lastUsedAt === null ? null : DateTime.formatIso(record.lastUsedAt),
})

const json = (body: unknown, status = 200) =>
  HttpServerResponse.unsafeJson(body, {
    status,
    headers: {
      "cache-control": "no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
    },
  })

/** Captures runtime services, not credentials. Every request verifies its bearer anew. */
export const makeDelegationManagementHandler: Effect.Effect<
  Issuer,
  never,
  | AuthenticationDatabase
  | SqlClient.SqlClient
  | KeyManagementService
  | ClientRegistryService
> = Effect.gen(function* () {
  const storage = yield* Effect.serviceOption(DelegationDatabase)
  const authorization = yield* Effect.serviceOption(AuthorizationService)
  const authDb = yield* AuthenticationDatabase
  const checkSession =
    Option.isSome(storage) && Option.isSome(authorization)
      ? makeDelegationSessionChecker({
          db: storage.value,
          authDb,
          auth: authorization.value,
        })
      : undefined
  const sql = yield* SqlClient.SqlClient
  const keys = yield* KeyManagementService
  const clients = yield* ClientRegistryService

  const handler: Issuer = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (
      request.method !== "GET" &&
      request.method !== "POST" &&
      request.method !== "PATCH"
    ) {
      return json({ error: "method_not_allowed" }, 405)
    }
    const token =
      request.headers["authorization"]?.match(/^Bearer ([^ ]+)$/)?.[1]
    if (!token) return json({ error: "invalid_token" }, 401)
    const signingKeys = yield* keys.allSigningKeys
    const issuer = yield* getIssuerUrl(request.headers).pipe(
      Effect.mapError(
        () =>
          new DelegationRequestError({ status: 401, error: "invalid_token" }),
      ),
    )
    const now = yield* DateTime.now
    const verified = yield* Effect.tryPromise({
      try: () =>
        jwtVerify(
          token,
          async (header) => {
            const key = signingKeys.find(
              (key) => key.id === header.kid && key.alg === header.alg,
            )
            if (!key) throw new Error("Unknown signing key")
            return key.public
          },
          {
            issuer,
            audience: [...clients.staticClients.values()].map(
              (client) => client.audience,
            ),
            requiredClaims: ["exp", "sub"],
            currentDate: DateTime.toDateUtc(now),
          },
        ),
      catch: () =>
        new DelegationRequestError({ status: 401, error: "invalid_token" }),
    })
    const expiresAt = verified.payload.exp
    if (
      typeof expiresAt !== "number" ||
      verified.payload["mode"] !== "access" ||
      verified.payload["type"] !== "providerUser"
    ) {
      return json({ error: "invalid_token" }, 401)
    }
    const validated = yield* Effect.promise(async () =>
      subjects.providerUser["~standard"].validate(
        verified.payload["properties"],
      ),
    )
    if (validated.issues) return json({ error: "invalid_token" }, 401)
    const session = validated.value
    if (session.delegation !== undefined && checkSession === undefined)
      return json({ error: "invalid_token" }, 401)
    if (Option.isNone(storage))
      return json({ error: "delegation_unavailable" }, 403)
    const db = storage.value
    const patchInput =
      request.method === "PATCH"
        ? yield* request.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknown(ChangeDelegation, {
                onExcessProperty: "error",
              }),
            ),
            Effect.mapError(
              () =>
                new DelegationRequestError({
                  status: 400,
                  error: "invalid_request",
                }),
            ),
          )
        : undefined
    const targets = new URL(
      request.url,
      "https://auth.invalid",
    ).searchParams.getAll("ownerUserId")
    if (targets.length > 1 || targets[0] === "")
      return json({ error: "invalid_request" }, 400)
    const ownerUserId = targets[0] ?? session.userId
    const verifiedSession = session
    const loadFacts = Effect.gen(function* () {
      // A verified bearer can expire while waiting for the transaction's write lock.
      if (DateTime.toEpochMillis(yield* DateTime.now) >= expiresAt * 1000)
        return yield* new DelegationRequestError({
          status: 401,
          error: "invalid_token",
        })
      const session =
        verifiedSession.delegation !== undefined && checkSession !== undefined
          ? yield* checkSession(verifiedSession).pipe(
              Effect.mapError(
                () =>
                  new DelegationRequestError({
                    status: 401,
                    error: "invalid_token",
                  }),
              ),
            )
          : verifiedSession
      const ancestorIds = new Set<string>()
      const ancestorGenerations = new Set<string>()
      let ancestorGenerationId = session.delegation?.generationId ?? null
      while (ancestorGenerationId !== null) {
        if (ancestorGenerations.has(ancestorGenerationId))
          return yield* new DelegationRequestError({
            status: 401,
            error: "invalid_token",
          })
        ancestorGenerations.add(ancestorGenerationId)
        const ancestor = yield* db.findGeneration({
          generationId: ancestorGenerationId,
        })
        if (Option.isNone(ancestor))
          return yield* new DelegationRequestError({
            status: 401,
            error: "invalid_token",
          })
        ancestorIds.add(ancestor.value.id)
        ancestorGenerationId = ancestor.value.parentGenerationId
      }
      const issuanceExpiry = (
        issuedAt: DateTime.Utc,
        lifetimeDays: 1 | 7 | 14,
      ) =>
        DateTime.unsafeMake(
          Math.min(
            DateTime.toEpochMillis(
              DateTime.add(issuedAt, { days: lifetimeDays }),
            ),
            session.delegation?.expiresAt ?? Number.POSITIVE_INFINITY,
          ),
        )
      const actorId = yield* db.findOwnerId(session.userId)
      const actor = yield* authDb.findProviderUserByUserId(session.userId)
      if (Option.isNone(actorId) || Option.isNone(actor))
        return yield* new DelegationRequestError({
          status: 401,
          error: "invalid_token",
        })
      const ownerId = yield* db.findOwnerId(ownerUserId)
      const owner = yield* authDb.findProviderUserByUserId(ownerUserId)
      if (Option.isNone(ownerId) || Option.isNone(owner))
        return yield* new DelegationRequestError({
          status: 403,
          error:
            request.method === "PATCH" ? "operation_denied" : "issuance_denied",
        })
      if (Option.isNone(authorization))
        return yield* new DelegationRequestError({
          status: 403,
          error:
            request.method === "PATCH" ? "operation_denied" : "issuance_denied",
        })
      const auth = authorization.value
      const actorRoles =
        session.delegation === undefined
          ? yield* authDb.findProviderUserRoles(session.userId)
          : session.roles
      const principal =
        session.delegation === undefined
          ? new ProviderUserPrincipal(actor.value.email, {
              roles: actorRoles,
              orgUnitId: actor.value.orgUnitPath,
            })
          : new DelegationPrincipal(session.delegation.id, {
              owner: actor.value.email,
              name: session.delegation.name,
              roles: actorRoles,
              orgUnitId: actor.value.orgUnitPath,
            })
      const roles = yield* authDb.findProviderUserRoles(ownerUserId)
      const ownerPrincipal = new ProviderUserPrincipal(owner.value.email, {
        roles,
        orgUnitId: owner.value.orgUnitPath,
      })
      const resource = (record: DelegationRecord) =>
        new DelegationPrincipal(record.id, {
          owner: owner.value.email,
          name: record.name,
          roles,
          orgUnitId: owner.value.orgUnitPath,
        })
      // A hypothetical fresh ceremony is only a UI/challenge classification.
      // It must never authorize a write; mutations require the actual evidence.
      const issuanceDecision = (time: DateTime.Utc) =>
        Effect.gen(function* () {
          const check = (
            humanAuthentication: typeof session.humanAuthentication,
          ) =>
            auth
              .canIssueDelegationSecret(principal, ownerPrincipal, {
                ownerProviderUserId: ownerUserId,
                humanSession:
                  session.delegation === undefined &&
                  session.humanSession === true,
                humanAuthentication,
              })
              .pipe(
                Effect.provideService(RequestTime, FiberRef.unsafeMake(time)),
              )
          if (yield* check(session.humanAuthentication))
            return "allowed" as const
          if (
            session.delegation !== undefined ||
            session.userId !== ownerUserId
          )
            return "issuance_denied" as const
          if (
            !(yield* check({
              providerUserId: session.userId,
              authenticatedAt: DateTime.toEpochMillis(time),
              method: "passkey",
            }))
          )
            return "issuance_denied" as const
          const passkey = yield* authDb.findOAuthProviderByName("passkey")
          return actor.value.provider === "passkey" && Option.isSome(passkey)
            ? ("verification_required" as const)
            : ("unsupported_authentication" as const)
        })
      const withActions = (record: DelegationRecord, time: DateTime.Utc) =>
        Effect.gen(function* () {
          const allowedActions = yield* Effect.all({
            rename: auth.canManageDelegation(
              principal,
              resource(record),
              "rename",
            ),
            replace: auth.canManageDelegation(
              principal,
              resource(record),
              "replace",
            ),
            revoke: auth.canManageDelegation(
              principal,
              resource(record),
              "revoke",
            ),
          }).pipe(Effect.provideService(RequestTime, FiberRef.unsafeMake(time)))
          return {
            ...metadata(record, time),
            allowedActions: {
              rename: record.revokedAt === null && allowedActions.rename,
              replace:
                !ancestorIds.has(record.id) &&
                record.revokedAt === null &&
                allowedActions.replace &&
                (yield* issuanceDecision(time)) !== "issuance_denied",
              revoke: record.revokedAt === null && allowedActions.revoke,
            },
          }
        })

      return {
        session,
        ancestorIds,
        issuanceExpiry,
        actorId: actorId.value,
        ownerId: ownerId.value,
        owner: owner.value,
        principal,
        ownerPrincipal,
        resource,
        withActions,
        issuanceDecision,
        auth,
      }
    })

    if (request.method === "GET") {
      const {
        session,
        ownerId,
        owner,
        principal,
        ownerPrincipal,
        withActions,
        issuanceDecision,
        auth,
      } = yield* loadFacts
      const requestTime = FiberRef.unsafeMake(now)
      const allowed = yield* auth
        .canListDelegationTokens(principal, ownerPrincipal)
        .pipe(Effect.provideService(RequestTime, requestTime))
      if (!allowed) return json({ error: "issuance_denied" }, 403)
      const records = yield* db.list(ownerId)
      return json({
        owner: { userId: ownerUserId, email: owner.email },
        issuanceDeadline:
          session.delegation === undefined
            ? null
            : DateTime.formatIso(
                DateTime.unsafeMake(session.delegation.expiresAt),
              ),
        canIssue: (yield* issuanceDecision(now)) !== "issuance_denied",
        delegations: yield* Effect.forEach(records, (record) =>
          withActions(record, now),
        ),
      })
    }

    // This pre-lock lookup is only a lock key, never an authorization fact.
    const lockOwnerId = yield* db.findOwnerId(ownerUserId)
    if (Option.isNone(lockOwnerId)) {
      if (ownerUserId === session.userId)
        return json({ error: "invalid_token" }, 401)
      return json(
        {
          error:
            request.method === "PATCH" ? "operation_denied" : "issuance_denied",
        },
        403,
      )
    }

    if (patchInput !== undefined) {
      const input = patchInput
      const name =
        input.operation === "revoke" ? input.expectedName : input.name.trim()
      if (!name) return json({ error: "invalid_request" }, 400)
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          // Take the write lock before reading guards, policy resources or name claims.
          yield* db.releaseExpiredNames(lockOwnerId.value, now)
          const {
            session,
            ancestorIds,
            issuanceExpiry,
            actorId,
            ownerId,
            principal,
            ownerPrincipal,
            resource,
            withActions,
            issuanceDecision,
            auth,
          } = yield* loadFacts
          const time = yield* DateTime.now
          yield* db.releaseExpiredNames(ownerId, time)
          const records = yield* db.list(ownerId)
          const record = records.find((record) => record.id === input.id)
          if (!record)
            return yield* new DelegationRequestError({
              status: 403,
              error: "operation_denied",
            })
          const allowed = yield* auth
            .canManageDelegation(principal, resource(record), input.operation)
            .pipe(Effect.provideService(RequestTime, FiberRef.unsafeMake(time)))
          if (!allowed || record.revokedAt !== null)
            return yield* new DelegationRequestError({
              status: 403,
              error: "operation_denied",
            })
          // Named identity matters too: rotating an ancestor must never form a cycle.
          if (input.operation === "replace" && ancestorIds.has(record.id))
            return yield* new DelegationRequestError({
              status: 403,
              error: "operation_denied",
            })
          if (
            input.operation === "replace" &&
            ownerUserId !== session.userId &&
            !(yield* auth
              .canIssueDelegationSecret(principal, ownerPrincipal, {
                ownerProviderUserId: ownerUserId,
                humanSession:
                  session.delegation === undefined &&
                  session.humanSession === true,
                humanAuthentication: session.humanAuthentication,
              })
              .pipe(
                Effect.provideService(RequestTime, FiberRef.unsafeMake(time)),
              ))
          )
            return yield* new DelegationRequestError({
              status: 403,
              error: "operation_denied",
            })
          if (
            record.generationId !== input.generationId ||
            record.name !== input.expectedName
          )
            return yield* new DelegationRequestError({
              status: 409,
              error: "stale_delegation",
            })
          if (
            input.operation === "replace" &&
            name !== record.name &&
            !(yield* auth
              .canManageDelegation(principal, resource(record), "rename")
              .pipe(
                Effect.provideService(RequestTime, FiberRef.unsafeMake(time)),
              ))
          )
            return yield* new DelegationRequestError({
              status: 403,
              error: "operation_denied",
            })
          if (input.operation === "replace") {
            const decision = yield* issuanceDecision(time)
            if (decision !== "allowed")
              return yield* new DelegationRequestError({
                status: 403,
                error: decision,
              })
          }
          const active =
            input.operation === "replace" ||
            DateTime.greaterThan(record.expiresAt, time)
          if (
            input.operation !== "revoke" &&
            active &&
            records.some(
              (other) =>
                other.id !== record.id &&
                other.name === name &&
                other.revokedAt === null &&
                DateTime.greaterThan(other.expiresAt, time),
            )
          )
            return yield* new DelegationRequestError({
              status: 409,
              error: "name_conflict",
            })
          if (input.operation === "revoke") {
            const revokedAt = DateTime.unsafeMake(
              Math.floor(DateTime.toEpochMillis(time) / 1000) * 1000,
            )
            yield* db.revoke({ id: record.id, revokedAt })
            yield* db.revokeGeneration({
              generationId: record.generationId,
              revokedAt,
            })
            yield* db.recordChange({
              delegationId: record.id,
              generationId: record.generationId,
              actorId,
              actorDelegation: session.delegation,
              event: "revoked",
              occurredAt: time,
            })
            return yield* withActions({ ...record, revokedAt }, time)
          }
          yield* db.updateName({
            id: record.id,
            name,
            activeName: active ? name : null,
          })
          if (name !== record.name)
            yield* db.recordChange({
              delegationId: record.id,
              generationId: record.generationId,
              actorId,
              actorDelegation: session.delegation,
              event: "renamed",
              oldName: record.name,
              newName: name,
              occurredAt: time,
            })
          if (input.operation === "rename")
            return yield* withActions({ ...record, name }, time)
          const generationId = `dsg-${randomUUID()}`
          const secret = `pfds_${randomBytes(32).toString("base64url")}`
          const issuedAt = DateTime.unsafeMake(
            Math.floor(DateTime.toEpochMillis(time) / 1000) * 1000,
          )
          const expiresAt = issuanceExpiry(issuedAt, input.lifetimeDays)
          yield* db.revokeGeneration({
            generationId: record.generationId,
            revokedAt: time,
          })
          yield* db.recordChange({
            delegationId: record.id,
            generationId: record.generationId,
            actorId,
            actorDelegation: session.delegation,
            event: "replaced",
            occurredAt: time,
          })
          yield* db.insertGeneration({
            id: generationId,
            parentGenerationId: session.delegation?.generationId ?? null,
            delegationId: record.id,
            verifier: createHash("sha256").update(secret).digest("base64url"),
            issuedAt,
            expiresAt,
          })
          yield* db.recordIssuance({
            delegationId: record.id,
            generationId,
            actorId,
            actorDelegation: session.delegation,
            issuedAt,
          })
          return {
            ...(yield* withActions(
              {
                ...record,
                name,
                generationId,
                createdAt: issuedAt,
                expiresAt,
                lastUsedAt: null,
              },
              time,
            )),
            secret,
          }
        }),
      )
      return json(result)
    }

    const input = yield* request.json.pipe(
      Effect.flatMap(
        Schema.decodeUnknown(CreateDelegation, { onExcessProperty: "error" }),
      ),
      Effect.mapError(
        () =>
          new DelegationRequestError({ status: 400, error: "invalid_request" }),
      ),
    )
    const name = input.name.trim()
    if (name.length === 0) return json({ error: "invalid_request" }, 400)
    const id = `dlg-${randomUUID()}`
    const generationId = `dsg-${input.requestId ?? randomUUID()}`
    const secret = `pfds_${randomBytes(32).toString("base64url")}`
    const verifier = createHash("sha256").update(secret).digest("base64url")
    // The first write takes the SQLite transaction lock before checking policy
    // and claiming the unique name, so concurrent issuance cannot both succeed.
    const result = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* db.releaseExpiredNames(lockOwnerId.value, now)
        const {
          session,
          issuanceExpiry,
          actorId,
          ownerId,
          withActions,
          issuanceDecision,
        } = yield* loadFacts
        const time = yield* DateTime.now
        const decision = yield* issuanceDecision(time)
        if (decision !== "allowed")
          return yield* new DelegationRequestError({
            status: 403,
            error: decision,
          })
        if (yield* db.hasGeneration(generationId))
          return yield* new DelegationRequestError({
            status: 409,
            error: "submission_replayed",
          })
        // Store whole-second precision, restored by the SQLite storage read boundary.
        const issuedAt = DateTime.unsafeMake(
          Math.floor(DateTime.toEpochMillis(time) / 1000) * 1000,
        )
        const expiresAt = issuanceExpiry(issuedAt, input.lifetimeDays)
        yield* db.releaseExpiredNames(ownerId, time)
        if (!(yield* db.claimName({ id, ownerId, name })))
          return yield* new DelegationRequestError({
            status: 409,
            error: "name_conflict",
          })
        yield* db.insertGeneration({
          id: generationId,
          parentGenerationId: session.delegation?.generationId ?? null,
          delegationId: id,
          verifier,
          issuedAt,
          expiresAt,
        })
        yield* db.recordIssuance({
          delegationId: id,
          generationId,
          actorId,
          actorDelegation: session.delegation,
          issuedAt,
        })
        return {
          ...(yield* withActions(
            {
              id,
              name,
              generationId,
              createdAt: issuedAt,
              expiresAt,
              revokedAt: null,
              lastUsedAt: null,
            },
            time,
          )),
          secret,
        }
      }),
    )
    return json(result, 201)
  }).pipe(
    Effect.catchTag("DelegationRequestError", ({ status, error }) =>
      Effect.succeed(json({ error }, status)),
    ),
    // SQL errors can contain query parameters. Never log their cause on this boundary.
    Effect.catchAll(() =>
      Effect.logError("Unexpected delegation management failure").pipe(
        Effect.as(json({ error: "internal_error" }, 500)),
      ),
    ),
  )
  return handler
})
