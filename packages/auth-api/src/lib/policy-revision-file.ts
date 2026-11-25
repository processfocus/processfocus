import { readFile } from "node:fs/promises"
import { Effect, Layer } from "effect"
import {
  ActivePolicyRevision,
  PolicyRevisionUnavailable,
} from "@pf/auth-policy"

/** Lazy read: ordinary assigned-role login does not depend on publication. */
export const policyRevisionFromFile = (path: string) =>
  Layer.succeed(ActivePolicyRevision, {
    current: Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: () => new PolicyRevisionUnavailable(),
    }).pipe(
      Effect.flatMap((revision) =>
        /^[a-f0-9]{64}$/.test(revision)
          ? Effect.succeed(revision)
          : Effect.fail(new PolicyRevisionUnavailable()),
      ),
    ),
  })
