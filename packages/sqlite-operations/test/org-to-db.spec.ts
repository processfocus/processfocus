// biome-ignore-all lint/style/noNonNullAssertion: test assertions

import { eq } from "drizzle-orm"
import { DateTime, Effect, FiberRef, Layer, Schema } from "effect"
import { AuthenticationConfig } from "@pf/auth-config"
import * as schema from "@pf/drizzle-sqlite"
import {
  DbOperations,
  type FlowCrossProcessError,
  storeOrganisation,
} from "@pf/org-to-db"
import { Form, OrgUnit, Organisation, Process, Role, Sla } from "@pf/process"
import { RequestTime } from "@pf/request-time"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import { SqliteDbOperationsLive } from "../src/lib/org-to-db"
import { describe, expect, it } from "bun:test"

describe("storeOrganisation", () => {
  const RequestTimeTest = Layer.succeed(
    RequestTime,
    FiberRef.unsafeMake(DateTime.unsafeMake(Date.now())),
  )

  const TestLayer = Layer.mergeAll(
    SqliteDbOperationsLive,
    RequestTimeTest,
    DatabaseTest,
  )

  type TestRequirements = Layer.Layer.Success<typeof TestLayer>

  const runTest = <A, E>(
    test: Effect.Effect<A, E, TestRequirements>,
  ): Promise<A> => {
    return Effect.runPromise(Effect.provide(test, TestLayer))
  }

  it("should store a simple organisation with one process and one step", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Test Organisation",
        })
        const role = new Role(organisation, "admin", { name: "Admin" })

        const process = new Process(organisation, "onboarding", {
          name: "Onboarding",
          purpose: "Onboard new employees",
        })

        new Form(process, "welcome", {
          role,
          name: "Send Welcome Email",
          form: () => ({}),
        })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle

        const orgUnits = yield* db.select().from(schema.orgUnit)
        const organisationUnit = orgUnits.find(
          (u) => u.orgUnitLevel === "organisation",
        )
        expect(organisationUnit).toBeDefined()
        expect(organisationUnit!.name).toBe("Test Organisation")

        const processes = yield* db.select().from(schema.process)
        expect(processes).toHaveLength(1)
        expect(processes[0]!.name).toBe("Onboarding")
        expect(processes[0]!.purpose).toBe("Onboard new employees")

        const roles = yield* db.select().from(schema.role)
        expect(roles).toHaveLength(1)
        expect(roles[0]!.name).toBe("Admin")

        const steps = yield* db.select().from(schema.step)
        expect(steps).toHaveLength(1)
        expect(steps[0]!.name).toBe("Send Welcome Email")
      }),
    ))

  it("should store a process with multiple steps and flows", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Test Organisation",
        })
        const role = new Role(organisation, "admin", { name: "Admin" })

        const process = new Process(organisation, "onboarding", {
          name: "Onboarding",
          purpose: "Onboard new employees",
        })

        const step1 = new Form(process, "step1", {
          role,
          name: "Step 1",
          form: () => ({
            name: Schema.String,
          }),
        })

        const step2 = new Form(process, "step2", {
          role,
          name: "Step 2",
          form: () => ({}),
        })

        process.start(step1).next(step2, {
          condition: {
            fn: (state) => state.name.length > 0,
            text: "Name is not empty",
          },
        })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        const steps = yield* db.select().from(schema.step)
        expect(steps).toHaveLength(2)

        const flows = yield* db.select().from(schema.flow)
        expect(flows).toHaveLength(1)
        expect(flows[0]!.condition).toBe("Name is not empty")
      }),
    ))

  it("should store step path correctly", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Test Organisation",
        })
        const role = new Role(organisation, "admin", { name: "Admin" })

        const process = new Process(organisation, "process", {
          name: "Test Process",
          purpose: "Test",
        })

        new Form(process, "step1", {
          role,
          name: "Data Entry",
          form: () => ({}),
        })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        const steps = yield* db.select().from(schema.step)
        expect(steps).toHaveLength(1)
        expect(steps[0]!.path).toBeDefined()
        expect(typeof steps[0]!.path).toBe("string")
        expect(steps[0]!.path.length).toBeGreaterThan(0)
      }),
    ))

  it("should handle multiple processes", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Test Organisation",
        })
        const role = new Role(organisation, "admin", { name: "Admin" })

        const process1 = new Process(organisation, "process1", {
          name: "Process 1",
          purpose: "First process",
        })

        const process2 = new Process(organisation, "process2", {
          name: "Process 2",
          purpose: "Second process",
        })

        new Form(process1, "step1", { role, name: "Step 1", form: () => ({}) })
        new Form(process2, "step2", { role, name: "Step 2", form: () => ({}) })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        const processes = yield* db.select().from(schema.process)
        expect(processes).toHaveLength(2)

        const steps = yield* db.select().from(schema.step)
        expect(steps).toHaveLength(2)
      }),
    ))

  it("should be idempotent (re-storing same org doesn't duplicate)", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Test Organisation",
        })
        const role = new Role(organisation, "admin", { name: "Admin" })

        const process = new Process(organisation, "process", {
          name: "Test",
          purpose: "Test",
        })

        new Form(process, "step1", { role, name: "Step 1", form: () => ({}) })

        yield* storeOrganisation(organisation)
        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        const orgUnits = yield* db.select().from(schema.orgUnit)
        const organisationUnits = orgUnits.filter(
          (u) => u.orgUnitLevel === "organisation",
        )
        expect(organisationUnits).toHaveLength(1)

        const processes = yield* db.select().from(schema.process)
        expect(processes).toHaveLength(1)

        const steps = yield* db.select().from(schema.step)
        expect(steps).toHaveLength(1)
      }),
    ))

  it("should delete orphaned records when organisation changes", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Test Organisation",
        })
        const role = new Role(organisation, "admin", { name: "Admin" })

        const process1 = new Process(organisation, "process1", {
          name: "Process 1",
          purpose: "First process",
        })

        const process2 = new Process(organisation, "process2", {
          name: "Process 2",
          purpose: "Second process",
        })

        new Form(process1, "step1", { role, name: "Step 1", form: () => ({}) })
        new Form(process2, "step2", { role, name: "Step 2", form: () => ({}) })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        let processes = yield* db.select().from(schema.process)
        expect(processes).toHaveLength(2)

        let steps = yield* db.select().from(schema.step)
        expect(steps).toHaveLength(2)

        const newOrg = new Organisation({
          name: "Test Organisation",
        })
        const newRole = new Role(newOrg, "admin", { name: "Admin" })

        const newProcess = new Process(newOrg, "process1", {
          name: "Process 1 Updated",
          purpose: "Updated process",
        })

        new Form(newProcess, "step1", {
          role: newRole,
          name: "Step 1 Updated",
          form: () => ({}),
        })

        yield* storeOrganisation(newOrg)

        // Processes use soft delete, so filter out deleted ones
        processes = yield* db
          .select()
          .from(schema.process)
          .where(eq(schema.process._deleted, false))
        expect(processes).toHaveLength(1)
        expect(processes[0]!.name).toBe("Process 1 Updated")

        // Steps use soft delete, so filter out deleted ones
        steps = yield* db
          .select()
          .from(schema.step)
          .where(eq(schema.step._deleted, false))
        expect(steps).toHaveLength(1)
        expect(steps[0]!.name).toBe("Step 1 Updated")
      }),
    ))

  it("should handle flows with end steps", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Test Organisation",
        })
        const role = new Role(organisation, "admin", { name: "Admin" })

        const process = new Process(organisation, "process", {
          name: "Test",
          purpose: "Test",
        })

        const step1 = new Form(process, "step1", {
          role,
          name: "Step 1",
          form: () => ({}),
        })
        const step2 = new Form(process, "step2", {
          role,
          name: "Final Step",
          form: () => ({}),
        })

        process.start(step1).end(step2)

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        const flows = yield* db.select().from(schema.flow)
        expect(flows).toHaveLength(1)
      }),
    ))

  it("should handle complex onboarding process", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Test Organisation",
        })
        const role = new Role(organisation, "admin", { name: "Admin" })

        const process = new Process(organisation, "onboarding", {
          name: "Onboarding",
          purpose: "Onboard new employees",
        })

        const send_welcome_pack = new Form(process, "send_welcome_pack", {
          role,
          form: () => ({
            start_date: Schema.Date,
          }),
        })

        const plan_review = new Form(process, "plan_review", {
          role,
          form: () => ({}),
        })

        const day_30_check_in = new Form(process, "day_30_check_in", {
          role,
          form: () => ({}),
        })

        const formal_performance_review = new Form(
          process,
          "formal_performance_review",
          {
            role,
            form: () => ({
              passed: Schema.Boolean,
            }),
          },
        )

        const permanent = new Form(process, "permanent", {
          role,
          form: () => ({}),
        })

        process
          .start(send_welcome_pack)
          .next(plan_review, {
            condition: {
              fn: (state) => {
                return new Date() >= state.start_date
              },
            },
          })
          .next(day_30_check_in, {
            condition: {
              fn: (state) => {
                const thirtyDaysAfterStart = new Date(
                  state.start_date.getTime() + 30 * 24 * 60 * 60 * 1000,
                )
                return new Date() >= thirtyDaysAfterStart
              },
            },
          })
          .next(formal_performance_review, {
            condition: {
              fn: (state) => {
                return state.start_date.getTime() > 0
              },
            },
          })
          .end(permanent, {
            condition: {
              fn: (state) => {
                return state.passed
              },
            },
          })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        const steps = yield* db.select().from(schema.step)
        expect(steps).toHaveLength(5)

        const flows = yield* db.select().from(schema.flow)
        expect(flows).toHaveLength(4)

        const stepNames = steps.map((s) => s.name).sort()
        expect(stepNames).toContain("send_welcome_pack")
        expect(stepNames).toContain("plan_review")
        expect(stepNames).toContain("day_30_check_in")
        expect(stepNames).toContain("formal_performance_review")
        expect(stepNames).toContain("permanent")
      }),
    ))

  it("should handle steps with purpose field", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Test Organisation",
        })
        const role = new Role(organisation, "admin", { name: "Admin" })

        const process = new Process(organisation, "process", {
          name: "Test",
          purpose: "Test",
        })

        new Form(process, "step1", {
          role,
          name: "Step 1",
          purpose: "This is the first step",
          form: () => ({}),
        })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        const steps = yield* db.select().from(schema.step)
        expect(steps).toHaveLength(1)
        expect(steps[0]!.purpose).toBe("This is the first step")
      }),
    ))

  it("should handle steps without name (use path as name)", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Test Organisation",
        })
        const role = new Role(organisation, "admin", { name: "Admin" })

        const process = new Process(organisation, "process", {
          name: "Test",
          purpose: "Test",
        })

        new Form(process, "step1", {
          role,
          form: () => ({}),
        })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        const steps = yield* db.select().from(schema.step)
        expect(steps).toHaveLength(1)
        expect(steps[0]!.name).toBeTruthy()
      }),
    ))

  it("should update existing records when org changes", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Test Organisation",
        })
        const role = new Role(organisation, "admin", { name: "Admin" })

        const process = new Process(organisation, "process1", {
          name: "Original Name",
          purpose: "Original Purpose",
        })

        new Form(process, "step1", {
          role,
          name: "Original Step",
          form: () => ({}),
        })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        let processes = yield* db.select().from(schema.process)
        expect(processes[0]!.name).toBe("Original Name")

        let steps = yield* db.select().from(schema.step)
        expect(steps[0]!.name).toBe("Original Step")

        const newOrg = new Organisation({
          name: "Test Organisation",
        })
        const newRole = new Role(newOrg, "admin", { name: "Admin" })

        const newProcess = new Process(newOrg, "process1", {
          name: "Updated Name",
          purpose: "Updated Purpose",
        })

        new Form(newProcess, "step1", {
          role: newRole,
          name: "Updated Step",
          form: () => ({}),
        })

        yield* storeOrganisation(newOrg)

        processes = yield* db.select().from(schema.process)
        expect(processes).toHaveLength(1)
        expect(processes[0]!.name).toBe("Updated Name")
        expect(processes[0]!.purpose).toBe("Updated Purpose")

        steps = yield* db.select().from(schema.step)
        expect(steps).toHaveLength(1)
        expect(steps[0]!.name).toBe("Updated Step")
      }),
    ))

  it("should delete orphaned flows when process structure changes", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Test Organisation",
        })
        const role = new Role(organisation, "admin", { name: "Admin" })

        const process = new Process(organisation, "process", {
          name: "Test",
          purpose: "Test",
        })

        const step1 = new Form(process, "step1", {
          role,
          name: "Step 1",
          form: () => ({}),
        })
        const step2 = new Form(process, "step2", {
          role,
          name: "Step 2",
          form: () => ({}),
        })
        const step3 = new Form(process, "step3", {
          role,
          name: "Step 3",
          form: () => ({}),
        })

        process.start(step1).next(step2).next(step3)

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        let flows = yield* db
          .select()
          .from(schema.flow)
          .where(eq(schema.flow._deleted, false))
        expect(flows).toHaveLength(2)

        const newOrg = new Organisation({
          name: "Test Organisation",
        })
        const newRole = new Role(newOrg, "admin", { name: "Admin" })

        const newProcess = new Process(newOrg, "process", {
          name: "Test",
          purpose: "Test",
        })

        const newStep1 = new Form(newProcess, "step1", {
          role: newRole,
          name: "Step 1",
          form: () => ({}),
        })
        const newStep2 = new Form(newProcess, "step2", {
          role: newRole,
          name: "Step 2",
          form: () => ({}),
        })

        newProcess.start(newStep1).end(newStep2)

        yield* storeOrganisation(newOrg)

        // Flows use soft delete, so filter out deleted ones
        flows = yield* db
          .select()
          .from(schema.flow)
          .where(eq(schema.flow._deleted, false))
        expect(flows).toHaveLength(1)

        // Steps use soft delete, so filter out deleted ones
        const steps = yield* db
          .select()
          .from(schema.step)
          .where(eq(schema.step._deleted, false))
        expect(steps).toHaveLength(2)
      }),
    ))

  it("should store hierarchical organisation with departments", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Acme Corp",
        })

        const finance = new OrgUnit(organisation, "finance", {
          name: "Finance Department",
          type: "department",
        })

        new OrgUnit(organisation, "it", {
          name: "IT Department",
          type: "department",
        })

        const financeRole = new Role(finance, "accountant", {
          name: "Accountant",
        })

        const process = new Process(finance, "expense-approval", {
          name: "Expense Approval",
          purpose: "Approve employee expenses",
        })

        new Form(process, "submit", {
          role: financeRole,
          name: "Submit Expense",
          form: () => ({}),
        })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle

        const orgUnits = yield* db.select().from(schema.orgUnit)
        expect(orgUnits).toHaveLength(3)

        const organisationUnit = orgUnits.find(
          (u) => u.orgUnitLevel === "organisation",
        )
        expect(organisationUnit).toBeDefined()
        expect(organisationUnit!.name).toBe("Acme Corp")
        expect(organisationUnit!.parentOrgUnitId).toBeNull()

        const financeUnit = orgUnits.find(
          (u) => u.name === "Finance Department",
        )
        expect(financeUnit).toBeDefined()
        expect(financeUnit!.orgUnitLevel).toBe("department")
        expect(financeUnit!.parentOrgUnitId).toBe(organisationUnit!.id)

        const itDeptUnit = orgUnits.find((u) => u.name === "IT Department")
        expect(itDeptUnit).toBeDefined()
        expect(itDeptUnit!.orgUnitLevel).toBe("department")
        expect(itDeptUnit!.parentOrgUnitId).toBe(organisationUnit!.id)

        const processes = yield* db.select().from(schema.process)
        expect(processes).toHaveLength(1)
        expect(processes[0]!.orgUnitId).toBe(financeUnit!.id)

        const roles = yield* db.select().from(schema.role)
        expect(roles).toHaveLength(1)
        expect(roles[0]!.orgUnitId).toBe(financeUnit!.id)
      }),
    ))

  it("should handle role defined at organisation level used by step in child org unit", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Test Corp",
        })

        // Org-level role (like "Employee" in the demo)
        const employee = new Role(organisation, "Employee", {
          name: "Employee",
        })

        // Child org unit (like "Engineering" in the demo)
        const engineering = new OrgUnit(organisation, "engineering", {
          name: "Engineering",
          type: "department",
        })

        // Process in the child org unit
        const process = new Process(engineering, "bug-fix", {
          name: "Bug Fix Process",
          purpose: "Fix bugs",
        })

        // Step that uses the org-level role
        new Form(process, "report-bug", {
          role: employee,
          name: "Report Bug",
          form: () => ({}),
        })

        // With two-pass approach org-level roles are available to child org units
        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        const roles = yield* db
          .select()
          .from(schema.role)
          .where(eq(schema.role._deleted, false))
        expect(roles).toHaveLength(1)
      }),
    ))

  it("should allow same path for deleted and non-deleted org units", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle

        // Insert first org unit
        const result1 = yield* db
          .insert(schema.orgUnit)
          .values({
            name: "Original Organisation",
            orgUnitLevel: "organisation",
            path: "org",
          })
          .returning({ id: schema.orgUnit.id })

        // Soft-delete it
        yield* db
          .update(schema.orgUnit)
          .set({ _deleted: true })
          .where(eq(schema.orgUnit.id, result1[0]!.id))

        // Insert new org unit with same path (should succeed due to partial index)
        const result2 = yield* db
          .insert(schema.orgUnit)
          .values({
            name: "New Organisation",
            orgUnitLevel: "organisation",
            path: "org",
          })
          .returning({ id: schema.orgUnit.id })

        // Both should exist
        const allOrgUnits = yield* db.select().from(schema.orgUnit)
        expect(allOrgUnits).toHaveLength(2)
        expect(result1[0]!.id).not.toBe(result2[0]!.id)

        // Only non-deleted one should be queryable normally
        const activeOrgUnits = yield* db
          .select()
          .from(schema.orgUnit)
          .where(eq(schema.orgUnit._deleted, false))
        expect(activeOrgUnits).toHaveLength(1)
        expect(activeOrgUnits[0]!.name).toBe("New Organisation")
      }),
    ))

  it("should allow same path for deleted and non-deleted processes", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle

        // Create org unit first
        const orgResult = yield* db
          .insert(schema.orgUnit)
          .values({
            name: "Test Org",
            orgUnitLevel: "organisation",
            path: "org",
          })
          .returning({ id: schema.orgUnit.id })

        // Insert first process
        const result1 = yield* db
          .insert(schema.process)
          .values({
            orgUnitId: orgResult[0]!.id,
            name: "Original Process",
            path: "org/process1",
            purpose: "Original purpose",
          })
          .returning({ id: schema.process.id })

        // Soft-delete it
        yield* db
          .update(schema.process)
          .set({ _deleted: true })
          .where(eq(schema.process.id, result1[0]!.id))

        // Insert new process with same path
        const result2 = yield* db
          .insert(schema.process)
          .values({
            orgUnitId: orgResult[0]!.id,
            name: "New Process",
            path: "org/process1",
            purpose: "New purpose",
          })
          .returning({ id: schema.process.id })

        // Both should exist
        const allProcesses = yield* db.select().from(schema.process)
        expect(allProcesses).toHaveLength(2)
        expect(result1[0]!.id).not.toBe(result2[0]!.id)

        // Only non-deleted one should be active
        const activeProcesses = yield* db
          .select()
          .from(schema.process)
          .where(eq(schema.process._deleted, false))
        expect(activeProcesses).toHaveLength(1)
        expect(activeProcesses[0]!.name).toBe("New Process")
      }),
    ))

  it("should allow same path for deleted and non-deleted roles", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle

        // Create org unit first
        const orgResult = yield* db
          .insert(schema.orgUnit)
          .values({
            name: "Test Org",
            orgUnitLevel: "organisation",
            path: "org",
          })
          .returning({ id: schema.orgUnit.id })

        // Insert first role
        const result1 = yield* db
          .insert(schema.role)
          .values({
            orgUnitId: orgResult[0]!.id,
            name: "Original Admin",
            path: "org/admin",
          })
          .returning({ id: schema.role.id })

        // Soft-delete it
        yield* db
          .update(schema.role)
          .set({ _deleted: true })
          .where(eq(schema.role.id, result1[0]!.id))

        // Insert new role with same path
        const result2 = yield* db
          .insert(schema.role)
          .values({
            orgUnitId: orgResult[0]!.id,
            name: "New Admin",
            path: "org/admin",
          })
          .returning({ id: schema.role.id })

        // Both should exist
        const allRoles = yield* db.select().from(schema.role)
        expect(allRoles).toHaveLength(2)
        expect(result1[0]!.id).not.toBe(result2[0]!.id)

        // Only non-deleted one should be active
        const activeRoles = yield* db
          .select()
          .from(schema.role)
          .where(eq(schema.role._deleted, false))
        expect(activeRoles).toHaveLength(1)
        expect(activeRoles[0]!.name).toBe("New Admin")
      }),
    ))

  it("should allow same path for deleted and non-deleted steps", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle

        // Create org unit, process, and role
        const orgResult = yield* db
          .insert(schema.orgUnit)
          .values({
            name: "Test Org",
            orgUnitLevel: "organisation",
            path: "org",
          })
          .returning({ id: schema.orgUnit.id })

        const processResult = yield* db
          .insert(schema.process)
          .values({
            orgUnitId: orgResult[0]!.id,
            name: "Test Process",
            path: "org/process",
            purpose: "Test",
          })
          .returning({ id: schema.process.id })

        const roleResult = yield* db
          .insert(schema.role)
          .values({
            orgUnitId: orgResult[0]!.id,
            name: "Admin",
            path: "org/admin",
          })
          .returning({ id: schema.role.id })

        // Insert first step
        const result1 = yield* db
          .insert(schema.step)
          .values({
            name: "Original Step",
            purpose: "Original purpose",
            processId: processResult[0]!.id,
            roleId: roleResult[0]!.id,
            path: "org/process/step1",
          })
          .returning({ id: schema.step.id })

        // Soft-delete it
        yield* db
          .update(schema.step)
          .set({ _deleted: true })
          .where(eq(schema.step.id, result1[0]!.id))

        // Insert new step with same path
        const result2 = yield* db
          .insert(schema.step)
          .values({
            name: "New Step",
            purpose: "New purpose",
            processId: processResult[0]!.id,
            roleId: roleResult[0]!.id,
            path: "org/process/step1",
          })
          .returning({ id: schema.step.id })

        // Both should exist
        const allSteps = yield* db.select().from(schema.step)
        expect(allSteps).toHaveLength(2)
        expect(result1[0]!.id).not.toBe(result2[0]!.id)

        // Only non-deleted one should be active
        const activeSteps = yield* db
          .select()
          .from(schema.step)
          .where(eq(schema.step._deleted, false))
        expect(activeSteps).toHaveLength(1)
        expect(activeSteps[0]!.name).toBe("New Step")
      }),
    ))

  it("should allow same source/target for deleted and non-deleted flows", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle

        // Create org unit, process, role, and steps
        const orgResult = yield* db
          .insert(schema.orgUnit)
          .values({
            name: "Test Org",
            orgUnitLevel: "organisation",
            path: "org",
          })
          .returning({ id: schema.orgUnit.id })

        const processResult = yield* db
          .insert(schema.process)
          .values({
            orgUnitId: orgResult[0]!.id,
            name: "Test Process",
            path: "org/process",
            purpose: "Test",
          })
          .returning({ id: schema.process.id })

        const roleResult = yield* db
          .insert(schema.role)
          .values({
            orgUnitId: orgResult[0]!.id,
            name: "Admin",
            path: "org/admin",
          })
          .returning({ id: schema.role.id })

        const step1Result = yield* db
          .insert(schema.step)
          .values({
            name: "Step 1",
            purpose: "First step",
            processId: processResult[0]!.id,
            roleId: roleResult[0]!.id,
            path: "org/process/step1",
          })
          .returning({ id: schema.step.id })

        const step2Result = yield* db
          .insert(schema.step)
          .values({
            name: "Step 2",
            purpose: "Second step",
            processId: processResult[0]!.id,
            roleId: roleResult[0]!.id,
            path: "org/process/step2",
          })
          .returning({ id: schema.step.id })

        // Insert first flow
        const result1 = yield* db
          .insert(schema.flow)
          .values({
            flowKey: "flow-key-1",
            sourceStepId: step1Result[0]!.id,
            targetStepId: step2Result[0]!.id,
          })
          .returning({ id: schema.flow.id })

        // Soft-delete it
        yield* db
          .update(schema.flow)
          .set({ _deleted: true })
          .where(eq(schema.flow.id, result1[0]!.id))

        // Insert new flow with same source/target
        const result2 = yield* db
          .insert(schema.flow)
          .values({
            flowKey: "flow-key-1",
            sourceStepId: step1Result[0]!.id,
            targetStepId: step2Result[0]!.id,
          })
          .returning({ id: schema.flow.id })

        // Both should exist
        const allFlows = yield* db.select().from(schema.flow)
        expect(allFlows).toHaveLength(2)
        expect(result1[0]!.id).not.toBe(result2[0]!.id)

        // Only non-deleted one should be active
        const activeFlows = yield* db
          .select()
          .from(schema.flow)
          .where(eq(schema.flow._deleted, false))
        expect(activeFlows).toHaveLength(1)
        expect(activeFlows[0]!.id).toBe(result2[0]!.id)
      }),
    ))

  it("should prevent duplicate role names within same org unit", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle

        const orgResult = yield* db
          .insert(schema.orgUnit)
          .values({
            name: "Test Organisation",
            orgUnitLevel: "organisation",
            path: "org",
          })
          .returning({ id: schema.orgUnit.id })

        // Insert first role
        yield* db.insert(schema.role).values({
          orgUnitId: orgResult[0]!.id,
          name: "Admin",
          path: "org/admin",
        })

        // Try to insert duplicate role name in same org unit (should fail)
        const result = yield* Effect.flip(
          db.insert(schema.role).values({
            orgUnitId: orgResult[0]!.id,
            name: "Admin",
            path: "org/admin2",
          }),
        )

        // Should get a unique constraint violation
        expect(result).toBeDefined()
        // Check error message contains reference to unique constraint
        const errorStr = globalThis.JSON.stringify(result)
        expect(errorStr.toLowerCase()).toMatch(
          /unique|constraint|role_orgunitunameidx/,
        )

        const roles = yield* db
          .select()
          .from(schema.role)
          .where(eq(schema.role._deleted, false))
        expect(roles).toHaveLength(1)
      }),
    ))

  it("should allow same role name in different org units", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Test Organisation",
        })

        const finance = new OrgUnit(organisation, "finance", {
          name: "Finance Department",
          type: "department",
        })

        const engineering = new OrgUnit(organisation, "engineering", {
          name: "Engineering Department",
          type: "department",
        })

        // Same role name in different org units should be allowed
        new Role(finance, "manager", { name: "Manager" })
        new Role(engineering, "manager", { name: "Manager" })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle
        const roles = yield* db
          .select()
          .from(schema.role)
          .where(eq(schema.role._deleted, false))
        expect(roles).toHaveLength(2)
        expect(roles.every((r) => r.name === "Manager")).toBe(true)
        expect(roles[0]!.orgUnitId).not.toBe(roles[1]!.orgUnitId)
      }),
    ))

  it("should allow duplicate role name after soft-deleting original", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle

        const orgResult = yield* db
          .insert(schema.orgUnit)
          .values({
            name: "Test Organisation",
            orgUnitLevel: "organisation",
            path: "org-softdelete",
          })
          .returning({ id: schema.orgUnit.id })

        // Insert first role
        const firstRole = yield* db
          .insert(schema.role)
          .values({
            orgUnitId: orgResult[0]!.id,
            name: "Admin",
            path: "org-softdelete/admin1",
          })
          .returning({ id: schema.role.id })

        // Soft-delete the first role
        yield* db
          .update(schema.role)
          .set({ _deleted: true })
          .where(eq(schema.role.id, firstRole[0]!.id))

        // Should be able to insert another role with same name after soft-delete
        yield* db.insert(schema.role).values({
          orgUnitId: orgResult[0]!.id,
          name: "Admin",
          path: "org-softdelete/admin2",
        })

        // Both roles exist but only one is active
        const allRoles = yield* db
          .select()
          .from(schema.role)
          .where(eq(schema.role.orgUnitId, orgResult[0]!.id))
        expect(allRoles).toHaveLength(2)

        const activeRoles = yield* db
          .select()
          .from(schema.role)
          .where(eq(schema.role._deleted, false))
        expect(activeRoles).toHaveLength(1)
        expect(activeRoles[0]!.name).toBe("Admin")
      }),
    ))

  it("should treat role names as case-insensitive", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle

        const orgResult = yield* db
          .insert(schema.orgUnit)
          .values({
            name: "Test Organisation",
            orgUnitLevel: "organisation",
            path: "org-case-test",
          })
          .returning({ id: schema.orgUnit.id })

        // Insert role with lowercase name
        yield* db.insert(schema.role).values({
          orgUnitId: orgResult[0]!.id,
          name: "admin",
          path: "org-case-test/admin-lower",
        })

        // Try to insert role with different case - should fail due to case-insensitive unique constraint
        const error = yield* db
          .insert(schema.role)
          .values({
            orgUnitId: orgResult[0]!.id,
            name: "Admin",
            path: "org-case-test/admin-upper",
          })
          .pipe(Effect.flip)

        expect(error).toBeDefined()

        const roles = yield* db
          .select()
          .from(schema.role)
          .where(eq(schema.role._deleted, false))
        expect(roles).toHaveLength(1) // Case-insensitive: "admin" and "Admin" are duplicates
      }),
    ))

  it("should soft-delete orphaned org units when organisation structure changes", () =>
    runTest(
      Effect.gen(function* () {
        // Create initial organisation with child org units
        const organisation = new Organisation({
          name: "Test Organisation",
        })

        const finance = new OrgUnit(organisation, "finance", {
          name: "Finance Department",
          type: "department",
        })

        new OrgUnit(organisation, "hr", {
          name: "HR Department",
          type: "department",
        })

        const role = new Role(finance, "accountant", { name: "Accountant" })

        const process = new Process(finance, "expense", {
          name: "Expense Process",
          purpose: "Handle expenses",
        })

        new Form(process, "submit", {
          role,
          name: "Submit Expense",
          form: () => ({}),
        })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle

        // Verify initial state - 3 org units (org + 2 departments)
        let orgUnits = yield* db
          .select()
          .from(schema.orgUnit)
          .where(eq(schema.orgUnit._deleted, false))
        expect(orgUnits).toHaveLength(3)

        // Create new organisation without HR department
        const newOrg = new Organisation({
          name: "Test Organisation",
        })

        const newFinance = new OrgUnit(newOrg, "finance", {
          name: "Finance Department",
          type: "department",
        })

        const newRole = new Role(newFinance, "accountant", {
          name: "Accountant",
        })

        const newProcess = new Process(newFinance, "expense", {
          name: "Expense Process",
          purpose: "Handle expenses",
        })

        new Form(newProcess, "submit", {
          role: newRole,
          name: "Submit Expense",
          form: () => ({}),
        })

        yield* storeOrganisation(newOrg)

        // HR department should be soft-deleted
        orgUnits = yield* db
          .select()
          .from(schema.orgUnit)
          .where(eq(schema.orgUnit._deleted, false))
        expect(orgUnits).toHaveLength(2)

        // But should still exist in the database (soft-deleted)
        const allOrgUnits = yield* db.select().from(schema.orgUnit)
        expect(allOrgUnits).toHaveLength(3)

        const deletedOrgUnit = allOrgUnits.find((u) => u._deleted)
        expect(deletedOrgUnit).toBeDefined()
        expect(deletedOrgUnit!.name).toBe("HR Department")
      }),
    ))

  it("should soft-delete org units preserving FK references from runtime data", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle

        // Create org unit
        const orgResult = yield* db
          .insert(schema.orgUnit)
          .values({
            name: "Original Org",
            orgUnitLevel: "organisation",
            path: "original-org",
          })
          .returning({ id: schema.orgUnit.id })

        // Create a user that references this org unit (simulating runtime data)
        const userResult = yield* db
          .insert(schema.user)
          .values({
            sub: "test-user-sub",
            provider: "google",
            lastLoggedIn: DateTime.unsafeNow(),
          })
          .returning({ id: schema.user.id })

        // Create a provider user that references the org unit
        yield* db.insert(schema.providerUser).values({
          userId: userResult[0]!.id,
          orgUnitId: orgResult[0]!.id,
          email: "test@example.com",
          name: "Test User",
          firstName: "Test",
          lastName: "User",
          picture: "",
          locale: "en",
        })

        // Create a new organisation with different path (simulating path change)
        const newOrg = new Organisation({
          name: "New Org",
          acronym: "NEW",
        })

        // This should soft-delete the old org unit instead of hard-delete
        // which would fail due to FK constraint from employee
        yield* storeOrganisation(newOrg)

        // Old org unit should be soft-deleted (not hard-deleted)
        const allOrgUnits = yield* db.select().from(schema.orgUnit)
        expect(allOrgUnits.length).toBeGreaterThanOrEqual(2)

        const oldOrgUnit = allOrgUnits.find((u) => u.path === "original-org")
        expect(oldOrgUnit).toBeDefined()
        expect(oldOrgUnit!._deleted).toBe(true)

        // Provider user FK reference should still be valid
        const employees = yield* db.select().from(schema.providerUser)
        expect(employees).toHaveLength(1)
        expect(employees[0]!.orgUnitId).toBe(orgResult[0]!.id)
      }),
    ))

  it("should soft-delete orphaned OAuth providers", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle

        // Insert OAuth providers directly
        yield* db.insert(schema.oauthProvider).values({
          providerName: "google",
          providerConfig: { clientId: "google-client" },
        })

        yield* db.insert(schema.oauthProvider).values({
          providerName: "github",
          providerConfig: { clientId: "github-client" },
        })

        // Verify initial state
        let providers = yield* db
          .select()
          .from(schema.oauthProvider)
          .where(eq(schema.oauthProvider._deleted, false))
        expect(providers).toHaveLength(2)

        // Create organisation without OAuth config (will trigger delete of all providers)
        const org = new Organisation({ name: "Test Org" })
        const role = new Role(org, "admin", { name: "Admin" })
        const process = new Process(org, "test", {
          name: "Test",
          purpose: "Test",
        })
        new Form(process, "step1", { role, name: "Step 1", form: () => ({}) })

        yield* storeOrganisation(org)

        // Providers should be soft-deleted
        providers = yield* db
          .select()
          .from(schema.oauthProvider)
          .where(eq(schema.oauthProvider._deleted, false))
        expect(providers).toHaveLength(0)

        // But still exist in DB
        const allProviders = yield* db.select().from(schema.oauthProvider)
        expect(allProviders).toHaveLength(2)
        expect(allProviders.every((p) => p._deleted)).toBe(true)
      }),
    ))

  it("should persist inviteOnly into stored auth provider configs", () =>
    runTest(
      Effect.gen(function* () {
        const org = new Organisation({ name: "Test Org" })
        const role = new Role(org, "admin", { name: "Admin" })
        const process = new Process(org, "test", {
          name: "Test",
          purpose: "Test",
        })
        new Form(process, "step1", { role, name: "Step 1", form: () => ({}) })

        new AuthenticationConfig(org, "auth", {
          inviteOnly: false,
          identityProviders: {
            google: {
              clientID: "test-google-client-id",
              clientSecret: "test-google-client-secret",
              scopes: ["openid", "email", "profile"],
            },
          },
          passkey: {
            rpName: "Test Org",
            rpID: "localhost",
            origin: "http://localhost:3000",
          },
        })

        yield* storeOrganisation(org)

        const db = yield* TypedSqliteDrizzle
        const providers = yield* db
          .select()
          .from(schema.oauthProvider)
          .where(eq(schema.oauthProvider._deleted, false))

        expect(providers).toHaveLength(2)
        expect(
          providers.every(
            (provider) =>
              !Array.isArray(provider.providerConfig) &&
              provider.providerConfig["delegatedAccess"] === false,
          ),
        ).toBe(true)
        expect(
          providers.every(
            (provider) =>
              (provider.providerConfig as Record<string, unknown>)[
                "inviteOnly"
              ] === false,
          ),
        ).toBe(true)
      }),
    ))

  it("hydrates delegated access enablement and disabling without changing human providers", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        for (const delegatedAccess of [true, false]) {
          const org = new Organisation({ name: "Delegated Access Org" })
          new AuthenticationConfig(org, "auth", {
            delegatedAccess,
            identityProviders: {
              google: {
                clientID: "google",
                clientSecret: "test-only",
                scopes: ["openid", "email"],
              },
            },
            passkey: {
              rpName: "Test",
              rpID: "localhost",
              origin: "http://localhost",
            },
          })
          yield* storeOrganisation(org)
          const providers = yield* db
            .select()
            .from(schema.oauthProvider)
            .where(eq(schema.oauthProvider._deleted, false))
          expect(
            providers.map((provider) => provider.providerName).sort(),
          ).toEqual(["google", "passkey"])
          expect(
            providers.every(
              (provider) =>
                !Array.isArray(provider.providerConfig) &&
                provider.providerConfig["delegatedAccess"] === delegatedAccess,
            ),
          ).toBe(true)
          expect(
            providers.every(
              (provider) =>
                !Array.isArray(provider.providerConfig) &&
                provider.providerConfig["inviteOnly"] === true,
            ),
          ).toBe(true)
        }
      }),
    ))

  it("should store paths with leading slash", () =>
    runTest(
      Effect.gen(function* () {
        const org = new Organisation({
          name: "Demo Org",
        })

        new OrgUnit(org, "engineering", {
          name: "Engineering",
          type: "department",
        })

        const role = new Role(org, "admin", { name: "Admin" })
        const process = new Process(org, "test", {
          name: "Test",
          purpose: "Test",
        })
        new Form(process, "step1", {
          role: role,
          name: "Step 1",
          form: () => ({}),
        })

        yield* storeOrganisation(org)

        const db = yield* TypedSqliteDrizzle

        // Verify all paths start with /
        const orgUnits = yield* db.select().from(schema.orgUnit)
        expect(orgUnits.every((u) => u.path.startsWith("/"))).toBe(true)

        const processes = yield* db.select().from(schema.process)
        expect(processes.every((p) => p.path.startsWith("/"))).toBe(true)

        const roles = yield* db.select().from(schema.role)
        expect(roles.every((r) => r.path.startsWith("/"))).toBe(true)

        const steps = yield* db.select().from(schema.step)
        expect(steps.every((s) => s.path.startsWith("/"))).toBe(true)
      }),
    ))

  it("should store SLA configuration for process and steps", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Test Organisation",
        })
        const role = new Role(organisation, "employee", { name: "Employee" })

        const process = new Process(organisation, "request", {
          name: "Test Request",
          purpose: "Test SLA storage",
          sla: Sla.businessWeeks(1),
        })

        new Form(process, "submit", {
          role,
          name: "Submit Request",
          sla: Sla.businessHours(4),
          form: () => ({}),
        })

        new Form(process, "approve", {
          role,
          name: "Approve Request",
          sla: Sla.businessDays(2, { warningAt: 0.5 }),
          form: () => ({}),
        })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle

        // Verify process SLA
        const processes = yield* db.select().from(schema.process)
        expect(processes).toHaveLength(1)
        expect(processes[0]!.slaValue).toBe(1)
        expect(processes[0]!.slaUnit).toBe("businessWeeks")
        expect(processes[0]!.slaWarning).toBe(80) // Default warning at 80%

        // Verify step SLAs
        const steps = yield* db.select().from(schema.step)
        expect(steps).toHaveLength(2)

        const submitStep = steps.find((s) => s.name === "Submit Request")
        expect(submitStep!.slaValue).toBe(4)
        expect(submitStep!.slaUnit).toBe("businessHours")
        expect(submitStep!.slaWarning).toBe(80)

        const approveStep = steps.find((s) => s.name === "Approve Request")
        expect(approveStep!.slaValue).toBe(2)
        expect(approveStep!.slaUnit).toBe("businessDays")
        expect(approveStep!.slaWarning).toBe(50) // Custom warning at 50%
      }),
    ))

  it("should store SLA with minutes unit", () =>
    runTest(
      Effect.gen(function* () {
        const organisation = new Organisation({
          name: "Test Organisation",
        })
        const role = new Role(organisation, "employee", { name: "Employee" })

        const process = new Process(organisation, "urgent-request", {
          name: "Urgent Request",
          purpose: "Test minutes SLA storage",
        })

        new Form(process, "respond", {
          role,
          name: "Respond Quickly",
          sla: Sla.minutes(5),
          form: () => ({}),
        })

        new Form(process, "escalate", {
          role,
          name: "Escalate if Needed",
          sla: Sla.minutes(1, { warningAt: 0.5 }),
          form: () => ({}),
        })

        yield* storeOrganisation(organisation)

        const db = yield* TypedSqliteDrizzle

        const steps = yield* db.select().from(schema.step)
        expect(steps).toHaveLength(2)

        const respondStep = steps.find((s) => s.name === "Respond Quickly")
        expect(respondStep!.slaValue).toBe(5)
        expect(respondStep!.slaUnit).toBe("minutes")
        expect(respondStep!.slaWarning).toBe(80) // Default warning

        const escalateStep = steps.find((s) => s.name === "Escalate if Needed")
        expect(escalateStep!.slaValue).toBe(1)
        expect(escalateStep!.slaUnit).toBe("minutes")
        expect(escalateStep!.slaWarning).toBe(50) // Custom warning at 50%
      }),
    ))

  it("should reject flow connecting steps from different processes", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle

        // Create org unit
        const orgResult = yield* db
          .insert(schema.orgUnit)
          .values({
            name: "Test Org",
            orgUnitLevel: "organisation",
            path: "/org-cross-process",
          })
          .returning({ id: schema.orgUnit.id })

        // Create two processes
        const process1Result = yield* db
          .insert(schema.process)
          .values({
            orgUnitId: orgResult[0]!.id,
            name: "Process 1",
            path: "/org-cross-process/process1",
            purpose: "First process",
          })
          .returning({ id: schema.process.id })

        const process2Result = yield* db
          .insert(schema.process)
          .values({
            orgUnitId: orgResult[0]!.id,
            name: "Process 2",
            path: "/org-cross-process/process2",
            purpose: "Second process",
          })
          .returning({ id: schema.process.id })

        // Create role
        const roleResult = yield* db
          .insert(schema.role)
          .values({
            orgUnitId: orgResult[0]!.id,
            name: "Admin",
            path: "/org-cross-process/admin",
          })
          .returning({ id: schema.role.id })

        // Create step in process 1
        const step1Result = yield* db
          .insert(schema.step)
          .values({
            name: "Step in Process 1",
            purpose: "First step",
            processId: process1Result[0]!.id,
            roleId: roleResult[0]!.id,
            path: "/org-cross-process/process1/step1",
          })
          .returning({ id: schema.step.id })

        // Create step in process 2
        const step2Result = yield* db
          .insert(schema.step)
          .values({
            name: "Step in Process 2",
            purpose: "Second step",
            processId: process2Result[0]!.id,
            roleId: roleResult[0]!.id,
            path: "/org-cross-process/process2/step2",
          })
          .returning({ id: schema.step.id })

        // Try to create a flow between steps from different processes
        const dbOps = yield* DbOperations

        const error = yield* dbOps
          .upsertFlow(
            "flow-key-test",
            {
              sourceStepPath: "/org-cross-process/process1/step1",
              targetStepPath: "/org-cross-process/process2/step2",
              isElse: false,
              isOnError: false,
              taggedErrors: null,
            },
            step1Result[0]!.id,
            step2Result[0]!.id,
          )
          .pipe(Effect.flip)

        // Should fail with FlowCrossProcessError
        expect(error._tag).toBe("FlowCrossProcessError")
        expect((error as FlowCrossProcessError).sourceStepId).toBe(
          step1Result[0]!.id,
        )
        expect((error as FlowCrossProcessError).targetStepId).toBe(
          step2Result[0]!.id,
        )
        expect((error as FlowCrossProcessError).sourceProcessId).toBe(
          process1Result[0]!.id,
        )
        expect((error as FlowCrossProcessError).targetProcessId).toBe(
          process2Result[0]!.id,
        )

        // Verify no flow was created
        const flows = yield* db.select().from(schema.flow)
        expect(flows).toHaveLength(0)
      }),
    ))
})
