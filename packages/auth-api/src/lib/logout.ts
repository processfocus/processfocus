import { Clock, Effect, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse, UrlParams } from "effect/http"
import { Audit, captureAudit } from "@pf/audit"
import { ProviderUserSessionSchema } from "@pf/auth-session"
import { type Issuer, Storage, StorageService } from "@pf/openauth"

const HumanRefresh = Schema.Struct({
  type: Schema.Literal("providerUser"),
  properties: ProviderUserSessionSchema,
  expiresAt: Schema.optional(Schema.Number),
})

/** Explicit intent, separate from RFC 7009 revocation and automatic cleanup. */
export const makeLogoutHandler = Effect.gen(function* () {
  const audit = yield* Audit
  const storage = yield* StorageService
  const handler: Issuer = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const json = (body: unknown, status = 200) =>
      HttpServerResponse.jsonUnsafe(body, {
        status,
        headers: { "cache-control": "no-store" },
      })
    if (request.method !== "POST")
      return json({ error: "method_not_allowed" }, 405)

    const form = yield* request.urlParamsBody
    const token = Option.getOrUndefined(UrlParams.getFirst(form, "token"))
    const parts = token?.split(":") ?? []
    const secret = parts.pop()
    const subject = parts.join(":")
    if (!subject || !secret) return json({ success: true })
    const key = ["oauth:refresh", subject, secret]

    // The bearer must resolve to server-held, unexpired identity evidence.
    // Never infer identity from its subject prefix or any submitted user ID.
    const actor = yield* Storage.get<unknown>(key).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(HumanRefresh)),
      Effect.option,
    )
    const now = yield* Clock.currentTimeMillis
    if (Option.isSome(actor)) {
      const { properties, expiresAt } = actor.value
      if (
        properties.humanSession === true &&
        !properties.delegation &&
        !properties.workload &&
        (expiresAt === undefined ||
          (Number.isFinite(expiresAt) && expiresAt > now))
      ) {
        const event = yield* captureAudit({
          type: "logout",
          details: { actorUserId: properties.userId },
        })
        yield* audit.deliver(event)
      }
    }

    // Audit precedes this attempt: the event is intent, not proof of revocation.
    yield* Storage.remove(key).pipe(
      Effect.catchCause(() =>
        Effect.logWarning("Explicit logout token revocation failed"),
      ),
    )
    return json({ success: true })
  }).pipe(Effect.provideService(StorageService, storage))
  return handler
})
