import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Effect, Layer, ManagedRuntime } from "effect"
import { ActivePolicyRevision, PolicyRevisionPublisher } from "@pf/auth-policy"
import {
  LocalPolicyRevisionLive,
  LocalPolicyRevisionPublisherLive,
} from "./policy-revision"
import { expect, test } from "bun:test"

test("revision publication isolates PF_ORG fallback databases and honors explicit database precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "policy-revision-isolation-"))
  const configured = (org: string, database?: string) =>
    ManagedRuntime.make(
      Layer.merge(
        LocalPolicyRevisionLive,
        LocalPolicyRevisionPublisherLive,
      ).pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              PF_RUNTIME_ROOT: root,
              PF_ENV: "dev",
              PF_ORG: join(root, org),
              ...(database ? { SQLITE_DATABASE_PATH: database } : {}),
            }),
          ),
        ),
      ),
    )
  const a = configured("a")
  const b = configured("b")
  const explicitA = configured("b", join(root, "a/db/pf.db"))
  const current = Effect.flatMap(
    ActivePolicyRevision,
    (revision) => revision.current,
  )
  const publish = (revision: string) =>
    Effect.flatMap(PolicyRevisionPublisher, (publisher) =>
      publisher.publish(revision),
    )
  try {
    await a.runPromise(publish("a".repeat(64)))
    expect(await b.runPromise(current.pipe(Effect.isFailure))).toBe(true)
    await b.runPromise(publish("b".repeat(64)))
    expect(await a.runPromise(current)).toBe("a".repeat(64))
    expect(await b.runPromise(current)).toBe("b".repeat(64))
    expect(await explicitA.runPromise(current)).toBe("a".repeat(64))
    await explicitA.runPromise(publish("c".repeat(64)))
    expect(await a.runPromise(current)).toBe("c".repeat(64))
    expect(await b.runPromise(current)).toBe("b".repeat(64))
  } finally {
    await Promise.all([a.dispose(), b.dispose(), explicitA.dispose()])
    await rm(root, { recursive: true, force: true })
  }
})
