import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, DateTime, Effect, Layer, Schema } from "effect"
import * as dbSchema from "@pf/drizzle-sqlite"
import {
  DraftProcessEvents,
  DraftProcessExecutionCollectionOps,
  DraftProcessExecutionCollectionOpsLive,
} from "@pf/graphql-api"
import {
  DraftProcessExecutionQueries,
  UserDetails,
} from "@pf/graphql-db-operations"
import { TursoLive } from "@pf/layer-turso-local"
import { storeOrganisation } from "@pf/org-to-db"
import {
  Form,
  Organisation,
  OrganisationProviderTest,
  Process,
  Role,
} from "@pf/process"
import { RequestTime } from "@pf/request-time"
import {
  TypedSqliteDrizzle,
  TypedSqliteDrizzleLayer,
} from "@pf/service-drizzle-sqlite"
import { DatabaseTestFile } from "@pf/service-drizzle-sqlite/test-file"
import {
  SqliteDbOperationsLive,
  SqliteGraphqlDbOperationsLive,
} from "@pf/sqlite-operations"
import { makePushResolver } from "../../../../packages/graphql-api/src/lib/rxdb/resolver-makers"
import { DraftProcessEventsLive } from "../services/draft-process-events"
import { expect, it } from "bun:test"

it("saves successive start-form revisions and discards them on local Turso", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pf-start-form-"))
  const databasePath = join(directory, "pf.db")
  const org = new Organisation({ name: "Start form" })
  const role = new Role(org, "Clerk", { name: "Clerk" })
  const process = new Process(org, "request", {
    name: "Request",
    purpose: "Enter a request",
  })
  const start = new Form(process, "Start", {
    name: "Start",
    role,
    form: () => ({ title: Schema.String }),
  })
  process.start(start).end()
  const owner = "usr-autosave"
  const time = DateTime.makeUnsafe("2026-11-01T00:00:00Z")
  const at = (millis: number) =>
    Effect.provideService(
      RequestTime,
      DateTime.mapEpochMillis(time, (base) => base + millis),
    )
  const database = TypedSqliteDrizzleLayer.pipe(
    Layer.provideMerge(TursoLive),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          SQLITE_DATABASE_PATH: databasePath,
        }),
      ),
    ),
  )
  const live = DraftProcessExecutionCollectionOpsLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(SqliteDbOperationsLive, SqliteGraphqlDbOperationsLive),
    ),
    Layer.provideMerge(database),
    Layer.provideMerge(OrganisationProviderTest(org)),
    Layer.merge(DraftProcessEventsLive),
  )
  const push = makePushResolver(
    DraftProcessExecutionCollectionOps,
    DraftProcessEvents,
  )
  try {
    await Effect.runPromise(
      Effect.void.pipe(Effect.provide(DatabaseTestFile(databasePath))),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        yield* db.insert(dbSchema.user).values({
          id: owner,
          provider: "test",
          sub: owner,
          createdAt: time,
        })
        yield* storeOrganisation(org)
        const [stored] = yield* db
          .select({ id: dbSchema.process.id })
          .from(dbSchema.process)
        if (!stored) throw new Error("Missing imported process")
        const created = {
          id: "pst-autosave",
          processId: stored.id,
          startStepPath: `/${start.node.path}`,
          name: "Request",
          state: { title: "First value" },
          fieldsCompleted: 0,
          totalFields: 1,
          deleted: false,
          lastSaved: DateTime.toEpochMillis(time),
          updatedAt: 1,
        }
        const changed = {
          ...created,
          state: { title: "Latest value" },
          updatedAt: 2,
        }
        const queries = yield* DraftProcessExecutionQueries
        expect(
          (yield* push([{ newDocumentState: created }]).pipe(at(10))).conflicts,
        ).toEqual([])
        // The client still has the optimistic copies; the server assigned its own checkpoints.
        expect(
          (yield* push([
            { assumedMasterState: created, newDocumentState: changed },
          ]).pipe(at(20))).conflicts,
        ).toEqual([])
        expect(
          (yield* queries.pullDraftProcessExecution(null, 10)).map(
            (row) => row.state,
          ),
        ).toEqual([changed.state])
        const outsider = Effect.provideService(UserDetails, {
          id: "usr-other",
          by: "usr-other",
        })
        // Only an owner-scoped lookup can supply a master document to the
        // push resolver. A guessed ID must not expose data or make a write.
        expect(
          yield* queries.getProcessStates([created.id]).pipe(outsider),
        ).toEqual([])
        for (const deleted of [false, true]) {
          const attemptedWrite = yield* push([
            {
              assumedMasterState: changed,
              newDocumentState: {
                ...changed,
                deleted,
                state: { title: "Other user's values" },
              },
            },
          ]).pipe(outsider, at(25))
          expect(attemptedWrite).toEqual({ successful: [], conflicts: [] })
        }
        expect(
          (yield* queries.getProcessStates([created.id])).map((row) => ({
            state: row.state,
            deleted: row.deleted,
          })),
        ).toEqual([{ state: changed.state, deleted: false }])
        expect(
          (yield* push([
            {
              assumedMasterState: changed,
              newDocumentState: { ...changed, deleted: true },
            },
          ]).pipe(at(30))).conflicts,
        ).toEqual([])
        expect(
          (yield* queries.pullDraftProcessExecution(null, 10)).map(
            (row) => row.deleted,
          ),
        ).toEqual([true])
      }).pipe(
        Effect.provideService(UserDetails, { id: owner, by: owner }),
        at(0),
        Effect.provide(live),
      ),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
