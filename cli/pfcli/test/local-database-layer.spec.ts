import { existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqlError } from "@effect/sql/SqlError"
import { ConfigProvider, Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "bun:test"

const dbPaths: string[] = []

afterEach(() => {
  for (const dbPath of dbPaths) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${dbPath}${suffix}`
      if (existsSync(file)) unlinkSync(file)
    }
  }
  dbPaths.length = 0
})

describe("makePfcliSqlClientLayer", () => {
  it("loads the Turso Cloud layer for remote libsql paths", async () => {
    const { makePfcliSqlClientLayer } = await import(
      `../src/utils/local-database-layer.ts?scenario=${Date.now()}-${Math.random()}`
    )

    const ConfigLayer = Layer.setConfigProvider(
      ConfigProvider.fromMap(
        new Map([
          [
            "SQLITE_DATABASE_PATH",
            "libsql://example-db.process-focus.turso.io",
          ],
        ]),
      ),
    )

    await Effect.runPromise(
      Effect.scoped(
        Layer.build(
          makePfcliSqlClientLayer(
            "libsql://example-db.process-focus.turso.io",
          ).pipe(Layer.provide(ConfigLayer)),
        ),
      ),
    )
  })

  it("loads the local Turso layer for local file paths", async () => {
    const dbPath = join(
      tmpdir(),
      `pfcli-local-layer-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    )
    dbPaths.push(dbPath)

    const { makePfcliSqlClientLayer } = await import(
      `../src/utils/local-database-layer.ts?scenario=${Date.now()}-${Math.random()}`
    )
    const ConfigLayer = Layer.setConfigProvider(
      ConfigProvider.fromMap(new Map([["SQLITE_DATABASE_PATH", dbPath]])),
    )

    await Effect.runPromise(
      Effect.scoped(
        Layer.build(
          makePfcliSqlClientLayer(dbPath).pipe(Layer.provide(ConfigLayer)),
        ),
      ),
    )
  })

  it("surfaces Turso layer load failures as typed SQL errors", async () => {
    const { makePfcliSqlClientLayer } = await import(
      `../src/utils/local-database-layer.ts?scenario=${Date.now()}-${Math.random()}`
    )

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(
          Layer.build(
            makePfcliSqlClientLayer("./local.db", {
              local: async () => {
                throw new Error("native binding missing")
              },
              cloud: async () => Layer.empty,
            }),
          ),
        ),
      ),
    )

    if (!(error instanceof SqlError)) {
      throw new Error("Expected layer load failure to be a SqlError")
    }

    expect(error.message).toBe("Failed to load local Turso database layer")
  })
})
