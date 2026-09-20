// biome-ignore-all lint/style/noNonNullAssertion: test assertions
import { eq, not } from "drizzle-orm"
import { DateTime, Effect, FiberRef, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import { OrgQueries } from "@pf/graphql-db-operations"
import { storeOrganisation } from "@pf/org-to-db"
import { OrgUnit, Organisation, Process, Role } from "@pf/process"
import { RequestTime } from "@pf/request-time"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import { SqliteDbOperationsLive } from "../src/lib/org-to-db"
import { SqliteOrgQueriesLive } from "../src/lib/query-org"
import { describe, expect, it } from "bun:test"

describe("query-org", () => {
  const RequestTimeTest = Layer.succeed(
    RequestTime,
    FiberRef.unsafeMake(DateTime.unsafeMake(Date.now())),
  )

  const TestLayer = Layer.provideMerge(
    Layer.mergeAll(
      SqliteDbOperationsLive,
      SqliteOrgQueriesLive,
      RequestTimeTest,
    ),
    DatabaseTest,
  )

  type TestRequirements = Layer.Layer.Success<typeof TestLayer>

  const runTest = <A, E>(
    test: Effect.Effect<A, E, TestRequirements>,
  ): Promise<A> => {
    return Effect.runPromise(Effect.provide(test, TestLayer))
  }

  it("should query root organisation unit", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Acme Corp",
        })

        yield* storeOrganisation(organisation)

        const orgQueries = yield* OrgQueries
        const rootOrgUnit = yield* orgQueries.queryRoot

        expect(rootOrgUnit).not.toBeNull()
        expect(rootOrgUnit!.name).toBe("Acme Corp")
        expect(rootOrgUnit!.orgUnitLevel).toBe("organisation")
        expect(rootOrgUnit!.parentOrgUnitId).toBeNull()
      }),
    ))

  it("should return null when no root organisation exists", () =>
    runTest(
      Effect.gen(function* () {
        const orgQueries = yield* OrgQueries
        const rootOrgUnit = yield* orgQueries.queryRoot

        expect(rootOrgUnit).toBeNull()
      }),
    ))

  it("should query child organisation units", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Acme Corp",
        })

        new OrgUnit(organisation, "finance", {
          name: "Finance Department",
          type: "department",
        })

        new OrgUnit(organisation, "it", {
          name: "IT Department",
          type: "department",
        })

        yield* storeOrganisation(organisation)

        const orgQueries = yield* OrgQueries
        const rootOrgUnit = yield* orgQueries.queryRoot
        expect(rootOrgUnit).not.toBeNull()

        const childOrgUnits = yield* orgQueries.queryChildren(rootOrgUnit!.id)

        expect(childOrgUnits).toHaveLength(2)
        const names = childOrgUnits.map((u) => u.name).sort()
        expect(names).toEqual(["Finance Department", "IT Department"])
      }),
    ))

  it("should return empty array when org unit has no children", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Acme Corp",
        })

        new OrgUnit(organisation, "finance", {
          name: "Finance Department",
          type: "department",
        })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        const financeUnits = yield* db.query.orgUnit.findMany({
          where: { name: "Finance Department" },
        })

        expect(financeUnits).toHaveLength(1)
        const orgQueries = yield* OrgQueries
        const childOrgUnits = yield* orgQueries.queryChildren(
          financeUnits[0]!.id,
        )

        expect(childOrgUnits).toHaveLength(0)
      }),
    ))

  it("should query processes for an organisation unit", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Acme Corp",
        })

        const finance = new OrgUnit(organisation, "finance", {
          name: "Finance Department",
          type: "department",
        })

        new Process(finance, "expense-approval", {
          name: "Expense Approval",
          purpose: "Approve employee expenses",
        })

        new Process(finance, "budget-review", {
          name: "Budget Review",
          purpose: "Review annual budget",
        })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        const financeUnits = yield* db.query.orgUnit.findMany({
          where: { name: "Finance Department" },
        })

        expect(financeUnits).toHaveLength(1)
        const orgQueries = yield* OrgQueries
        const processes = yield* orgQueries.queryProcesses(financeUnits[0]!.id)

        expect(processes).toHaveLength(2)
        const processNames = processes.map((p) => p.name).sort()
        expect(processNames).toEqual(["Budget Review", "Expense Approval"])
      }),
    ))

  it("should return empty array when org unit has no processes", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Acme Corp",
        })

        new OrgUnit(organisation, "finance", {
          name: "Finance Department",
          type: "department",
        })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        const financeUnits = yield* db.query.orgUnit.findMany({
          where: { name: "Finance Department" },
        })

        expect(financeUnits).toHaveLength(1)
        const orgQueries = yield* OrgQueries
        const processes = yield* orgQueries.queryProcesses(financeUnits[0]!.id)

        expect(processes).toHaveLength(0)
      }),
    ))

  it("should query roles for an organisation unit", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Acme Corp",
        })

        const finance = new OrgUnit(organisation, "finance", {
          name: "Finance Department",
          type: "department",
        })

        new Role(finance, "accountant", {
          name: "Accountant",
        })

        new Role(finance, "cfo", {
          name: "CFO",
        })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        const financeUnits = yield* db.query.orgUnit.findMany({
          where: { name: "Finance Department" },
        })

        expect(financeUnits).toHaveLength(1)
        const orgQueries = yield* OrgQueries
        const roles = yield* orgQueries.queryRoles(financeUnits[0]!.id)

        expect(roles).toHaveLength(2)
        const roleNames = roles.map((r) => r.name).sort()
        expect(roleNames).toEqual(["Accountant", "CFO"])
      }),
    ))

  it("should return empty array when org unit has no roles", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Acme Corp",
        })

        new OrgUnit(organisation, "finance", {
          name: "Finance Department",
          type: "department",
        })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        const financeUnits = yield* db.query.orgUnit.findMany({
          where: { name: "Finance Department" },
        })

        expect(financeUnits).toHaveLength(1)
        const orgQueries = yield* OrgQueries
        const roles = yield* orgQueries.queryRoles(financeUnits[0]!.id)

        expect(roles).toHaveLength(0)
      }),
    ))

  it("should handle hierarchical org structure with multiple levels", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Acme Corp",
        })

        const finance = new OrgUnit(organisation, "finance", {
          name: "Finance Department",
          type: "department",
        })

        new OrgUnit(finance, "accounting", {
          name: "Accounting Team",
          type: "team",
        })

        yield* storeOrganisation(organisation)

        const orgQueries = yield* OrgQueries
        const rootOrgUnit = yield* orgQueries.queryRoot
        expect(rootOrgUnit).not.toBeNull()
        expect(rootOrgUnit!.name).toBe("Acme Corp")

        const level1Children = yield* orgQueries.queryChildren(rootOrgUnit!.id)
        expect(level1Children).toHaveLength(1)
        expect(level1Children[0]!.name).toBe("Finance Department")

        const level2Children = yield* orgQueries.queryChildren(
          level1Children[0]!.id,
        )
        expect(level2Children).toHaveLength(1)
        expect(level2Children[0]!.name).toBe("Accounting Team")
      }),
    ))

  it("should query org levels with max depth", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Acme Corp",
        })

        // Create a division with a team (depth 3)
        const sales = new OrgUnit(organisation, "sales", {
          name: "Sales Division",
          type: "division",
        })

        new OrgUnit(sales, "sales-team", {
          name: "Sales Team",
          type: "team",
        })

        // Create a department with a team (depth 3)
        const finance = new OrgUnit(organisation, "finance", {
          name: "Finance Department",
          type: "department",
        })

        new OrgUnit(finance, "accounting", {
          name: "Accounting Team",
          type: "team",
        })

        // Create another department with nested structure (team at depth 4)
        const it = new OrgUnit(organisation, "it", {
          name: "IT Department",
          type: "department",
        })

        const development = new OrgUnit(it, "development", {
          name: "Development Section",
          type: "unit",
        })

        new OrgUnit(development, "dev-team", {
          name: "Dev Team",
          type: "team",
        })

        yield* storeOrganisation(organisation)

        const orgQueries = yield* OrgQueries
        const orgLevels = yield* orgQueries.queryOrgLevels

        // We should have: organisation(1), division(2), department(2), unit(3), team(4)
        expect(orgLevels).toHaveLength(5)

        // Results should be sorted by maxDepth
        expect(orgLevels[0]!.level).toBe("organisation")
        expect(orgLevels[0]!.maxDepth).toBe(1)

        // Division and department both at depth 2, order may vary
        const depth2Levels = orgLevels.filter((l) => l.maxDepth === 2)
        expect(depth2Levels).toHaveLength(2)
        const depth2LevelNames = depth2Levels.map((l) => l.level).sort()
        expect(depth2LevelNames).toEqual(["department", "division"])

        // Unit at depth 3
        const unitLevel = orgLevels.find((l) => l.level === "unit")
        expect(unitLevel).not.toBeUndefined()
        expect(unitLevel!.maxDepth).toBe(3)

        // Team appears at both depth 3 and 4, should return maxDepth = 4
        const teamLevel = orgLevels.find((l) => l.level === "team")
        expect(teamLevel).not.toBeUndefined()
        expect(teamLevel!.maxDepth).toBe(4)

        // Last item should be team with maxDepth 4
        expect(orgLevels[orgLevels.length - 1]!.level).toBe("team")
        expect(orgLevels[orgLevels.length - 1]!.maxDepth).toBe(4)
      }),
    ))

  it("should exclude soft-deleted org units from org levels", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Acme Corp",
        })

        new OrgUnit(organisation, "finance", {
          name: "Finance Department",
          type: "department",
        })

        new OrgUnit(organisation, "it", {
          name: "IT Department",
          type: "department",
        })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        yield* db
          .update(schema.orgUnit)
          .set({ _deleted: true })
          .where(eq(schema.orgUnit.name, "Finance Department"))

        const orgQueries = yield* OrgQueries
        const orgLevels = yield* orgQueries.queryOrgLevels

        expect(orgLevels).toHaveLength(2)
        expect(orgLevels[0]!.level).toBe("organisation")
        expect(orgLevels[0]!.maxDepth).toBe(1)
        expect(orgLevels[1]!.level).toBe("department")
        expect(orgLevels[1]!.maxDepth).toBe(2)
      }),
    ))

  it("should drop a level when its only deeper path is soft-deleted", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Acme Corp",
        })

        const finance = new OrgUnit(organisation, "finance", {
          name: "Finance Department",
          type: "department",
        })

        new OrgUnit(finance, "accounting", {
          name: "Accounting Team",
          type: "team",
        })

        yield* storeOrganisation(organisation)

        const orgQueries = yield* OrgQueries
        const before = yield* orgQueries.queryOrgLevels
        expect(before.find((level) => level.level === "team")?.maxDepth).toBe(3)

        const db = yield* TypedSqliteDrizzle
        yield* db
          .update(schema.orgUnit)
          .set({ _deleted: true })
          .where(eq(schema.orgUnit.name, "Accounting Team"))

        const after = yield* orgQueries.queryOrgLevels
        expect(after.map((level) => level.level).sort()).toEqual([
          "department",
          "organisation",
        ])
        expect(after.find((level) => level.level === "team")).toBeUndefined()
        expect(
          after.find((level) => level.level === "department")?.maxDepth,
        ).toBe(2)
      }),
    ))

  it("should not count non-deleted descendants of a soft-deleted mid-tree unit", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Acme Corp",
        })

        const finance = new OrgUnit(organisation, "finance", {
          name: "Finance Department",
          type: "department",
        })

        new OrgUnit(finance, "accounting", {
          name: "Accounting Team",
          type: "team",
        })

        new OrgUnit(organisation, "it", {
          name: "IT Department",
          type: "department",
        })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        // Soft-delete the intermediate department; team row remains non-deleted
        // but is unreachable from any live root path.
        yield* db
          .update(schema.orgUnit)
          .set({ _deleted: true })
          .where(eq(schema.orgUnit.name, "Finance Department"))

        const orgQueries = yield* OrgQueries
        const orgLevels = yield* orgQueries.queryOrgLevels

        expect(orgLevels.map((level) => level.level).sort()).toEqual([
          "department",
          "organisation",
        ])
        expect(
          orgLevels.find((level) => level.level === "team"),
        ).toBeUndefined()
        expect(
          orgLevels.find((level) => level.level === "department")?.maxDepth,
        ).toBe(2)
      }),
    ))

  it("should terminate when org units form a parent cycle", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Acme Corp",
        })

        const finance = new OrgUnit(organisation, "finance", {
          name: "Finance Department",
          type: "department",
        })

        new OrgUnit(finance, "accounting", {
          name: "Accounting Team",
          type: "team",
        })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        const units = yield* db
          .select({
            id: schema.orgUnit.id,
            name: schema.orgUnit.name,
            parentOrgUnitId: schema.orgUnit.parentOrgUnitId,
          })
          .from(schema.orgUnit)
          .where(not(schema.orgUnit._deleted))

        const root = units.find((unit) => unit.parentOrgUnitId === null)
        const department = units.find(
          (unit) => unit.name === "Finance Department",
        )
        const team = units.find((unit) => unit.name === "Accounting Team")
        expect(root).toBeDefined()
        expect(department).toBeDefined()
        expect(team).toBeDefined()

        // Corrupt: department <-> team cycle (no null parent in the cycle).
        // Root stays parent-null and loses its live child; walk must finish.
        yield* db
          .update(schema.orgUnit)
          .set({ parentOrgUnitId: team!.id })
          .where(eq(schema.orgUnit.id, department!.id))
        yield* db
          .update(schema.orgUnit)
          .set({ parentOrgUnitId: department!.id })
          .where(eq(schema.orgUnit.id, team!.id))

        const orgQueries = yield* OrgQueries
        const orgLevels = yield* orgQueries.queryOrgLevels

        expect(orgLevels).toEqual([{ level: "organisation", maxDepth: 1 }])
      }),
    ))

  it("should return empty org levels when no org units exist", () =>
    runTest(
      Effect.gen(function* () {
        const orgQueries = yield* OrgQueries
        const orgLevels = yield* orgQueries.queryOrgLevels
        expect(orgLevels).toEqual([])
      }),
    ))
})
