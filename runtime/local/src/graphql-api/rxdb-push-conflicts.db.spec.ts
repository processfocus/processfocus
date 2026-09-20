import { randomUUID } from "node:crypto"
import { Effect, Layer } from "effect"
import { buildSchema } from "graphql"
import {
  type DraftProcessChangeEvent,
  DraftProcessEvents,
  DraftProcessExecutionCollectionOps,
  DraftProcessExecutionCollectionOpsLive,
  makePushResolver,
} from "@pf/graphql-api"
import {
  Form,
  OrgUnit,
  Organisation,
  OrganisationProvider,
  Process,
  Role,
  normalizePath,
} from "@pf/process"
import {
  type GraphqlDbCase,
  postgresDbCase,
  sqliteDbCase,
} from "../test-support/graphql-db-matrix"
import { describe, expect, it } from "bun:test"

const runPostgresDbSpecs =
  process.env["PF_RUNTIME_LOCAL_POSTGRES_DB_SPECS"] === "1"

const makeOrganisation = (suffix: string) => {
  const org = new Organisation({ name: `RxDB conflict org ${suffix}` })
  const unit = new OrgUnit(org, `Operations ${suffix}`, {
    name: `Operations ${suffix}`,
    type: "department",
  })
  const role = new Role(unit, "employee", { name: "Employee" })
  const process = new Process(unit, `draft-${suffix}`, {
    name: `Draft ${suffix}`,
    purpose: "Test RxDB conflict handling",
  })
  const start = new Form(process, "Submit", {
    role,
    form: () => ({}),
  })
  process.start(start).end()

  return {
    org,
    orgUnitPath: normalizePath(unit.node.path),
    processPath: normalizePath(process.node.path),
    rolePath: normalizePath(role.node.path),
    startStepPath: normalizePath(start.node.path),
  }
}

const schema = buildSchema("type Query { ok: Boolean }")

const runSuite = <R>(db: GraphqlDbCase<R>) => {
  describe(`RxDB push conflicts (${db.name})`, () => {
    it("returns current masters and emits only successful writes", async () => {
      const suffix = randomUUID().slice(0, 8)
      const fixture = makeOrganisation(suffix)
      const events: DraftProcessChangeEvent[] = []
      const EventsTest = Layer.succeed(DraftProcessEvents, {
        emit: (event) =>
          Effect.sync(() => {
            events.push(event)
          }),
        subscribe: () => Effect.dieMessage("not used"),
      })
      const OrganisationTest = Layer.succeed(OrganisationProvider, {
        organisation: fixture.org,
        orgPath: "/tmp/org",
        schemaPath: "/tmp/org.graphql",
      })
      const CollectionOpsTest = Layer.provideMerge(
        DraftProcessExecutionCollectionOpsLive,
        db.layer,
      )
      const TestLayer = Layer.mergeAll(
        CollectionOpsTest,
        EventsTest,
        OrganisationTest,
      )

      await Effect.runPromise(
        Effect.gen(function* () {
          yield* db.storeOrganisation(fixture.org)
          yield* db.ensureProviderUser({
            email: "employee@example.com",
            orgUnitPath: fixture.orgUnitPath,
            rolePaths: [fixture.rolePath],
          })

          const push = makePushResolver(
            DraftProcessExecutionCollectionOps,
            DraftProcessEvents,
          )
          const id = `draft-${suffix}`
          const initial = {
            id,
            processId: yield* db.getProcessIdByPath(fixture.processPath),
            name: `Draft ${suffix}`,
            startStepPath: fixture.startStepPath,
            state: { value: "initial" },
            fieldsCompleted: 0,
            totalFields: 0,
            lastSaved: 0,
            updatedAt: 0,
            deleted: false,
          }

          const inserted = yield* push([{ newDocumentState: initial }], schema)
          expect(inserted.conflicts).toEqual([])
          expect(inserted.successful).toHaveLength(1)
          expect(events).toHaveLength(1)

          const original = inserted.successful[0]
          expect(original).toBeDefined()
          if (!original) return

          const updated = yield* push(
            [
              {
                assumedMasterState: original,
                newDocumentState: {
                  ...original,
                  state: { value: "current" },
                },
              },
            ],
            schema,
          )
          expect(updated.conflicts).toEqual([])
          expect(updated.successful).toHaveLength(1)
          expect(events).toHaveLength(2)

          const current = updated.successful[0]
          expect(current).toBeDefined()
          if (!current) return

          const staleUpdate = yield* push(
            [
              {
                assumedMasterState: original,
                newDocumentState: {
                  ...original,
                  state: { value: "stale" },
                },
              },
            ],
            schema,
          )
          expect(staleUpdate.successful).toEqual([])
          expect(staleUpdate.conflicts).toEqual([current])
          expect(events).toHaveLength(2)

          const staleDelete = yield* push(
            [
              {
                assumedMasterState: original,
                newDocumentState: { ...original, deleted: true },
              },
            ],
            schema,
          )
          expect(staleDelete.successful).toEqual([])
          expect(staleDelete.conflicts).toEqual([current])
          expect(events).toHaveLength(2)

          const insertConflict = yield* push(
            [{ newDocumentState: initial }],
            schema,
          )
          expect(insertConflict.successful).toEqual([])
          expect(insertConflict.conflicts).toEqual([current])
          expect(events).toHaveLength(2)

          const deleted = yield* push(
            [
              {
                assumedMasterState: current,
                newDocumentState: { ...current, deleted: true },
              },
            ],
            schema,
          )
          expect(deleted.conflicts).toEqual([])
          expect(deleted.successful[0]?.deleted).toBe(true)
          expect(events).toHaveLength(3)

          const alreadyDeleted = yield* push(
            [
              {
                assumedMasterState: current,
                newDocumentState: { ...current, deleted: true },
              },
            ],
            schema,
          )
          expect(alreadyDeleted.successful).toEqual([])
          expect(alreadyDeleted.conflicts[0]?.deleted).toBe(true)
          expect(events).toHaveLength(3)

          const missing = yield* push(
            [
              {
                assumedMasterState: { ...current, id: `missing-${suffix}` },
                newDocumentState: { ...current, id: `missing-${suffix}` },
              },
            ],
            schema,
          )
          expect(missing).toEqual({ conflicts: [], successful: [] })
          expect(events).toHaveLength(3)
        }).pipe(Effect.provide(TestLayer)) as Effect.Effect<
          void,
          unknown,
          never
        >,
      )
    })
  })
}

runSuite(sqliteDbCase)
if (runPostgresDbSpecs) {
  runSuite(postgresDbCase)
}
