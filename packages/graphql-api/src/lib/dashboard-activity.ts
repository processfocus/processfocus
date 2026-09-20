import { createHmac } from "node:crypto"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs"
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect"
import { ProviderUserSessionSchema } from "@pf/auth-session"
import type { BusinessMetricDimensionsValue } from "./business-metrics"
import type { JWTPayload } from "./types"

/** Only the verified GraphQL boundary calls this service; identity never leaves as a label. */
export class DashboardActivity extends Context.Tag(
  "@pf/graphql-api/DashboardActivity",
)<
  DashboardActivity,
  { readonly record: (email: string) => Effect.Effect<void> }
>() {}

export const recordDashboardActivity = (
  request: unknown,
  jwt: JWTPayload | undefined,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (
      !(request instanceof Request) ||
      request.method !== "POST" ||
      request.headers.get("x-pf-dashboard-activity") !== "1" ||
      jwt?.type !== "providerUser"
    )
      return
    // JWT signature/issuer/audience/expiry have already been verified by Yoga.
    // Parse the signed properties too; subject type alone includes M2M impersonation.
    const parsed = Schema.decodeUnknownOption(ProviderUserSessionSchema)(
      jwt.properties,
    )
    if (Option.isNone(parsed)) return
    const session = parsed.value
    if (
      session.delegation ||
      !(
        session.humanSession === true ||
        (session.humanAuthentication?.method === "passkey" &&
          session.humanAuthentication.providerUserId === session.userId)
      )
    )
      return
    const service = yield* Effect.serviceOption(DashboardActivity)
    if (Option.isSome(service)) yield* service.value.record(session.email)
  })

export const makeDashboardActivityLayer = (config: {
  readonly dimensions: BusinessMetricDimensionsValue
  readonly key: Redacted.Redacted<string>
  readonly logsUrl: string
  readonly headers: Readonly<Record<string, string>>
}): Layer.Layer<DashboardActivity> =>
  Layer.scoped(
    DashboardActivity,
    Effect.gen(function* () {
      const d = config.dimensions
      if (
        d.accountScope !== "customer" ||
        Redacted.value(config.key).length < 32
      ) {
        return { record: () => Effect.void }
      }
      const provider = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new LoggerProvider({
              resource: resourceFromAttributes({
                "service.name": "pf-dashboard-activity",
                pf_account_id: d.accountId,
                pf_account_name: d.accountName,
                pf_account_scope: d.accountScope,
                pf_project: d.project,
                pf_environment: d.environment,
              }),
              processors: [
                new BatchLogRecordProcessor({
                  exporter: new OTLPLogExporter({
                    url: config.logsUrl,
                    headers: config.headers,
                    timeoutMillis: 2000,
                  }),
                  exportTimeoutMillis: 2500,
                }),
              ],
            }),
        ),
        (provider) =>
          Effect.promise(() => provider.shutdown()).pipe(
            Effect.catchAllCause(() => Effect.void),
          ),
      )
      const logger = provider.getLogger("pf.dashboard.activity", "1")
      return {
        record: (email: string) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now
            const identity = createHmac("sha256", Redacted.value(config.key))
              .update(email.trim().toLowerCase())
              .digest("hex")
            logger.emit({
              timestamp: DateTime.toEpochMillis(now),
              body: JSON.stringify({
                identity,
                day: DateTime.formatIsoDate(now),
              }),
            })
            yield* Effect.tryPromise(() => provider.forceFlush()).pipe(
              Effect.catchAll(() =>
                Effect.logWarning("Dashboard activity export failed"),
              ),
            )
          }),
      }
    }),
  )
