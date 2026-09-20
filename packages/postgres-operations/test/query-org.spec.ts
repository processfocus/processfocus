// biome-ignore-all lint/style/noNonNullAssertion: test assertions
import { expect, it } from "@effect/vitest"
import { DateTime, Effect, FiberRef, Layer } from "effect"
import { OrgQueries } from "@pf/graphql-db-operations"
import { storeOrganisation } from "@pf/org-to-db"
import { OrgUnit, Organisation, Process, Role } from "@pf/process"
import { RequestTime } from "@pf/request-time"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"
import { PostgresDbOperationsLive } from "../src/lib/org-to-db"
import { PostgresOrgQueriesLive } from "../src/lib/query-org"
import { PostgresTest } from "./postgres-test"

const RequestTimeTest = Layer.succeed(
  RequestTime,
  FiberRef.unsafeMake(DateTime.unsafeMake(Date.now())),
)

const TestLayer = Layer.provideMerge(
  Layer.mergeAll(
    PostgresDbOperationsLive,
    PostgresOrgQueriesLive,
    RequestTimeTest,
  ),
  PostgresTest,
)

it.layer(TestLayer, { timeout: "60 seconds" })("query-org", (it) => {
  it.effect("should query root organisation unit", () =>
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
  )

  it.effect("should query child organisation units", () =>
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
  )

  it.effect("should return empty array when org unit has no children", () =>
    Effect.gen(function* () {
      const organisation = new Organisation({
        name: "Acme Corp",
      })

      const _finance = new OrgUnit(organisation, "finance", {
        name: "Finance Department",
        type: "department",
      })
      void _finance

      yield* storeOrganisation(organisation)

      const db = yield* TypedPostgresDrizzle
      const financeUnits = yield* db.query.orgUnit.findMany({
        where: { name: "Finance Department" },
      })

      expect(financeUnits).toHaveLength(1)
      const orgQueries = yield* OrgQueries
      const childOrgUnits = yield* orgQueries.queryChildren(financeUnits[0]!.id)

      expect(childOrgUnits).toHaveLength(0)
    }),
  )

  it.effect("should query processes for an organisation unit", () =>
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

      const db = yield* TypedPostgresDrizzle
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
  )

  it.effect("should return empty array when org unit has no processes", () =>
    Effect.gen(function* () {
      const organisation = new Organisation({
        name: "Acme Corp",
      })

      new OrgUnit(organisation, "finance", {
        name: "Finance Department",
        type: "department",
      })

      yield* storeOrganisation(organisation)

      const db = yield* TypedPostgresDrizzle
      const financeUnits = yield* db.query.orgUnit.findMany({
        where: { name: "Finance Department" },
      })

      expect(financeUnits).toHaveLength(1)
      const orgQueries = yield* OrgQueries
      const processes = yield* orgQueries.queryProcesses(financeUnits[0]!.id)

      expect(processes).toHaveLength(0)
    }),
  )

  it.effect("should query roles for an organisation unit", () =>
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

      const db = yield* TypedPostgresDrizzle
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
  )

  it.effect("should return empty array when org unit has no roles", () =>
    Effect.gen(function* () {
      const organisation = new Organisation({
        name: "Acme Corp",
      })

      new OrgUnit(organisation, "finance", {
        name: "Finance Department",
        type: "department",
      })

      yield* storeOrganisation(organisation)

      const db = yield* TypedPostgresDrizzle
      const financeUnits = yield* db.query.orgUnit.findMany({
        where: { name: "Finance Department" },
      })

      expect(financeUnits).toHaveLength(1)
      const orgQueries = yield* OrgQueries
      const roles = yield* orgQueries.queryRoles(financeUnits[0]!.id)

      expect(roles).toHaveLength(0)
    }),
  )

  it.effect(
    "should handle hierarchical org structure with multiple levels",
    () =>
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Acme Corp",
        })

        const finance = new OrgUnit(organisation, "finance", {
          name: "Finance Department",
          type: "department",
        })

        const _accounting = new OrgUnit(finance, "accounting", {
          name: "Accounting Team",
          type: "team",
        })
        void _accounting

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
  )

  it.effect("should query org levels with max depth", () =>
    Effect.gen(function* () {
      const organisation = new Organisation({
        name: "Acme Corp",
      })

      // Create a division with a team (depth 3)
      const sales = new OrgUnit(organisation, "sales", {
        name: "Sales Division",
        type: "division",
      })

      const _salesTeam = new OrgUnit(sales, "sales-team", {
        name: "Sales Team",
        type: "team",
      })
      void _salesTeam

      // Create a department with a team (depth 3)
      const finance = new OrgUnit(organisation, "finance", {
        name: "Finance Department",
        type: "department",
      })

      const _accounting = new OrgUnit(finance, "accounting", {
        name: "Accounting Team",
        type: "team",
      })
      void _accounting

      // Create another department with nested structure (team at depth 4)
      const it = new OrgUnit(organisation, "it", {
        name: "IT Department",
        type: "department",
      })

      const development = new OrgUnit(it, "development", {
        name: "Development Section",
        type: "unit",
      })

      const _devTeam = new OrgUnit(development, "dev-team", {
        name: "Dev Team",
        type: "team",
      })
      void _devTeam

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
      expect(unitLevel).toBeDefined()
      expect(unitLevel!.maxDepth).toBe(3)

      // Team appears at both depth 3 and 4, should return maxDepth = 4
      const teamLevel = orgLevels.find((l) => l.level === "team")
      expect(teamLevel).toBeDefined()
      expect(teamLevel!.maxDepth).toBe(4)

      // Last item should be team with maxDepth 4
      expect(orgLevels[orgLevels.length - 1]!.level).toBe("team")
      expect(orgLevels[orgLevels.length - 1]!.maxDepth).toBe(4)
    }),
  )
})
