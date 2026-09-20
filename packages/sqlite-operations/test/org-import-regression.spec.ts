import { DateTime, Effect, FiberRef, Layer, type Schema } from "effect"
import { Monday, Tuesday, fixedHoliday } from "@pf/business-calendar"
import * as schema from "@pf/drizzle-sqlite"
import { FileField } from "@pf/form-schema"
import { storeOrganisation } from "@pf/org-to-db"
import {
  DocumentStore,
  Form,
  OrgUnit,
  Organisation,
  Process,
  Role,
} from "@pf/process"
import { RequestTime } from "@pf/request-time"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import { SqliteDbOperationsLive } from "../src/lib/org-to-db"
import { expect, it } from "bun:test"

const TestLayer = Layer.mergeAll(
  SqliteDbOperationsLive,
  Layer.succeed(
    RequestTime,
    FiberRef.unsafeMake(DateTime.unsafeMake(Date.now())),
  ),
  DatabaseTest,
)

const makeOrganisation = (includeOrphans: boolean) => {
  const organisation = new Organisation({
    name: "Delimiter Organisation",
    businessCalendar: {
      weeklySchedule: [
        {
          day: Monday,
          ranges: [
            {
              open: { hour: 9, minute: 0 },
              close: { hour: 17, minute: 0 },
            },
          ],
        },
        ...(includeOrphans
          ? [
              {
                day: Tuesday,
                ranges: [
                  {
                    open: { hour: 9, minute: 0 },
                    close: { hour: 17, minute: 0 },
                  },
                ],
              },
            ]
          : []),
      ],
      holidays: [
        fixedHoliday("Founders: Day", 1, 2),
        ...(includeOrphans ? [fixedHoliday("Old: Holiday", 3, 4)] : []),
      ],
      exceptions: [],
      nonWorkingDays: [],
      periods: [],
    },
  })
  const unit = new OrgUnit(organisation, "records->unit", {
    name: "Records",
    type: "department",
  })
  const retainedRole = new Role(unit, "owner->primary", {
    name: "Primary owner",
  })
  const supportingRole = new Role(unit, "support->review", {
    name: "Review support",
  })
  const orphanRole = includeOrphans
    ? new Role(unit, "old-owner", { name: "Old owner" })
    : undefined
  const retainedStore = new DocumentStore(unit, "files->archive")
  const orphanStore = includeOrphans
    ? new DocumentStore(unit, "old-files")
    : undefined
  const process = new Process(unit, "review->legacy", {
    name: "Review",
    purpose: "Review records",
    responsibilities: [
      { role: retainedRole, responsibility: "Own review" },
      ...(orphanRole
        ? [{ role: orphanRole, responsibility: "Old review" }]
        : []),
    ],
  })
  // Each imported organisation has a fixed schema, selected before construction.
  const uploadFields: Schema.Struct.Fields = {
    retained: FileField({
      label: "Retained file",
      documentStore: retainedStore,
    }),
    ...(orphanStore
      ? {
          orphan: FileField({
            label: "Orphan file",
            documentStore: orphanStore,
          }),
        }
      : {}),
  }
  new Form(process, "upload->proof", {
    role: retainedRole,
    supportingRoles: [supportingRole],
    form: () => uploadFields,
  })
  return organisation
}

it("preserves delimiter-bearing relationships and removes genuine orphans", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* storeOrganisation(makeOrganisation(true))
      yield* storeOrganisation(makeOrganisation(false))

      const db = yield* TypedSqliteDrizzle
      const orgUnits = yield* db.select().from(schema.orgUnit)
      const nestedUnit = orgUnits.find((unit) => unit.path === "/records->unit")
      const stores = yield* db.select().from(schema.documentStore)
      const retainedStore = stores.find(
        (store) => store.path === "/records->unit/files->archive",
      )

      expect(retainedStore?._deleted).toBe(false)
      expect(retainedStore?.orgUnitId).toBe(nestedUnit?.id)
      expect(
        stores.find((store) => store.path === "/records->unit/old-files")
          ?._deleted,
      ).toBe(true)

      const responsibilities = yield* db
        .select()
        .from(schema.roleResponsibility)
      expect(responsibilities.filter((row) => !row._deleted)).toHaveLength(1)
      expect(responsibilities.filter((row) => row._deleted)).toHaveLength(1)

      const schedules = yield* db.select().from(schema.weeklySchedule)
      expect(schedules.filter((row) => !row._deleted)).toHaveLength(1)
      expect(schedules.filter((row) => row._deleted)).toHaveLength(1)

      const holidays = yield* db.select().from(schema.holidayInstance)
      expect(
        holidays.find((row) => row.holidayTitle === "Founders: Day")?._deleted,
      ).toBe(false)
      expect(
        holidays.find((row) => row.holidayTitle === "Old: Holiday")?._deleted,
      ).toBe(true)

      const links = yield* db.select().from(schema.stepDocumentStore)
      expect(links.filter((row) => !row._deleted)).toHaveLength(1)
      expect(links.filter((row) => row._deleted)).toHaveLength(1)

      const supportingRoles = yield* db.select().from(schema.stepSupportingRole)
      expect(supportingRoles.filter((row) => !row._deleted)).toHaveLength(1)
    }).pipe(Effect.provide(TestLayer)),
  ))
