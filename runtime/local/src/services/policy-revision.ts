import { createHash, randomUUID } from "node:crypto"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { Config, Effect, Layer } from "effect"
import { policyRevisionFromFile } from "@pf/auth-api/issuer"
import {
  PolicyRevisionPublisher,
  PolicyRevisionUnavailable,
} from "@pf/auth-policy"
import { DatabasePathConfig } from "@pf/db-info"

// One local runtime/environment/database namespace; never a machine-global value.
const revisionPath = Effect.gen(function* () {
  const root = resolve(
    yield* Config.String("PF_RUNTIME_ROOT").pipe(
      Config.withDefault(process.cwd()),
    ),
  )
  const environment = yield* Config.String("PF_ENV").pipe(
    Config.withDefault(""),
  )
  const database = yield* DatabasePathConfig
  const scope = createHash("sha256")
    .update(JSON.stringify([root, environment, database]))
    .digest("hex")
  return join(root, ".policy-revisions", scope)
})

export const LocalPolicyRevisionLive = Layer.unwrap(
  Effect.map(revisionPath, policyRevisionFromFile),
)
export const LocalPolicyRevisionPublisherLive = Layer.unwrap(
  Effect.map(revisionPath, (path) =>
    Layer.succeed(PolicyRevisionPublisher, {
      publish: (revision) =>
        Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(path), { recursive: true })
            const temporary = `${path}.${randomUUID()}`
            try {
              await writeFile(temporary, revision, { mode: 0o600 })
              await rename(temporary, path)
            } finally {
              await rm(temporary, { force: true })
            }
          },
          catch: () => new PolicyRevisionUnavailable(),
        }),
    }),
  ),
)
