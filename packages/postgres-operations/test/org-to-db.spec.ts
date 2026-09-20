// biome-ignore-all lint/style/noNonNullAssertion: test assertions
import { expect, it } from "@effect/vitest"
import { and, eq } from "drizzle-orm"
import { DateTime, Effect, FiberRef, Layer, Schema } from "effect"
import * as schema from "@pf/drizzle-postgres"
import { storeOrganisation } from "@pf/org-to-db"
import { Form, OrgUnit, Organisation, Process, Role } from "@pf/process"
import { RequestTime } from "@pf/request-time"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"
import { PostgresDbOperationsLive } from "../src/lib/org-to-db"
import { PostgresTest } from "./postgres-test"

const RequestTimeTest = Layer.succeed(
  RequestTime,
  FiberRef.unsafeMake(DateTime.unsafeMake(Date.now())),
)

const TestLayer = Layer.mergeAll(
  PostgresTest,
  PostgresDbOperationsLive,
  RequestTimeTest,
)

it.layer(TestLayer, { timeout: "60 seconds" })("PgClient", (it) => {
  // Tests are sequential and share this file's cloned database.

  it.effect(
    "should store a simple organisation with one process and one step",
    () =>
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

        const db = yield* TypedPostgresDrizzle

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
  )

  it("should store a process with multiple steps and flows", () =>
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

      const db = yield* TypedPostgresDrizzle
      const steps = yield* db.select().from(schema.step)
      expect(steps).toHaveLength(2)

      const flows = yield* db.select().from(schema.flow)
      expect(flows).toHaveLength(1)
      expect(flows[0]!.condition).toBe("Name is not empty")
    }))

  it("should store step path correctly", () =>
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

      const db = yield* TypedPostgresDrizzle
      const steps = yield* db.select().from(schema.step)
      expect(steps).toHaveLength(1)
      expect(steps[0]!.path).toBeDefined()
      expect(typeof steps[0]!.path).toBe("string")
      expect(steps[0]!.path.length).toBeGreaterThan(0)
    }))

  it("should handle multiple processes", () =>
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

      const db = yield* TypedPostgresDrizzle
      const processes = yield* db.select().from(schema.process)
      expect(processes).toHaveLength(2)

      const steps = yield* db.select().from(schema.step)
      expect(steps).toHaveLength(2)
    }))

  it("should be idempotent (re-storing same org doesn't duplicate)", () =>
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

      const db = yield* TypedPostgresDrizzle
      const orgUnits = yield* db.select().from(schema.orgUnit)
      const organisationUnits = orgUnits.filter(
        (u) => u.orgUnitLevel === "organisation",
      )
      expect(organisationUnits).toHaveLength(1)

      const processes = yield* db.select().from(schema.process)
      expect(processes).toHaveLength(1)

      const steps = yield* db.select().from(schema.step)
      expect(steps).toHaveLength(1)
    }))

  it("should delete orphaned records when organisation changes", () =>
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

      const db = yield* TypedPostgresDrizzle
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
    }))

  it("should handle flows with end steps", () =>
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

      const db = yield* TypedPostgresDrizzle
      const flows = yield* db.select().from(schema.flow)
      expect(flows).toHaveLength(1)
    }))

  it("should handle complex onboarding process", () =>
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

      const db = yield* TypedPostgresDrizzle
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
    }))

  it("should handle steps with purpose field", () =>
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

      const db = yield* TypedPostgresDrizzle
      const steps = yield* db.select().from(schema.step)
      expect(steps).toHaveLength(1)
      expect(steps[0]!.purpose).toBe("This is the first step")
    }))

  it("should handle steps without name (use path as name)", () =>
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

      const db = yield* TypedPostgresDrizzle
      const steps = yield* db.select().from(schema.step)
      expect(steps).toHaveLength(1)
      expect(steps[0]!.name).toBeTruthy()
    }))

  it("should update existing records when org changes", () =>
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

      const db = yield* TypedPostgresDrizzle
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
    }))

  it("should delete orphaned flows when process structure changes", () =>
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

      const db = yield* TypedPostgresDrizzle
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
    }))

  it("should store hierarchical organisation with departments", () =>
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

      const db = yield* TypedPostgresDrizzle

      const orgUnits = yield* db.select().from(schema.orgUnit)
      expect(orgUnits).toHaveLength(3)

      const organisationUnit = orgUnits.find(
        (u) => u.orgUnitLevel === "organisation",
      )
      expect(organisationUnit).toBeDefined()
      expect(organisationUnit!.name).toBe("Acme Corp")
      expect(organisationUnit!.parentOrgUnitId).toBeNull()

      const financeUnit = orgUnits.find((u) => u.name === "Finance Department")
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
    }))

  it.effect(
    "should handle role defined at organisation level used by step in child org unit",
    () =>
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

        // With two-pass approach, this now succeeds - org-level roles are available to child org units
        yield* storeOrganisation(organisation)

        const db = yield* TypedPostgresDrizzle
        const roles = yield* db
          .select()
          .from(schema.role)
          .where(eq(schema.role._deleted, false))
        expect(roles).toHaveLength(1)
      }),
  )

  it.effect(
    "should allow same path for deleted and non-deleted org units",
    () =>
      Effect.gen(function* () {
        const db = yield* TypedPostgresDrizzle
        const testPath = `org-soft-delete-${Date.now()}`

        // Insert first org unit
        const result1 = yield* db
          .insert(schema.orgUnit)
          .values({
            name: "Original Organisation",
            orgUnitLevel: "organisation",
            path: testPath,
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
            path: testPath,
          })
          .returning({ id: schema.orgUnit.id })

        // Both should exist (filter by our test path)
        const allOrgUnits = yield* db
          .select()
          .from(schema.orgUnit)
          .where(eq(schema.orgUnit.path, testPath))
        expect(allOrgUnits).toHaveLength(2)
        expect(result1[0]!.id).not.toBe(result2[0]!.id)

        // Only non-deleted one should be queryable normally
        const activeOrgUnits = yield* db
          .select()
          .from(schema.orgUnit)
          .where(
            and(
              eq(schema.orgUnit._deleted, false),
              eq(schema.orgUnit.path, testPath),
            ),
          )
        expect(activeOrgUnits).toHaveLength(1)
        expect(activeOrgUnits[0]!.name).toBe("New Organisation")
      }),
  )

  it.effect(
    "should allow same path for deleted and non-deleted processes",
    () =>
      Effect.gen(function* () {
        const db = yield* TypedPostgresDrizzle
        const timestamp = Date.now()
        const orgPath = `org-process-test-${timestamp}`
        const processPath = `${orgPath}/process1`

        // Create org unit first
        const orgResult = yield* db
          .insert(schema.orgUnit)
          .values({
            name: "Test Org",
            orgUnitLevel: "organisation",
            path: orgPath,
          })
          .returning({ id: schema.orgUnit.id })

        // Insert first process
        const result1 = yield* db
          .insert(schema.process)
          .values({
            orgUnitId: orgResult[0]!.id,
            name: "Original Process",
            path: processPath,
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
            path: processPath,
            purpose: "New purpose",
          })
          .returning({ id: schema.process.id })

        // Both should exist
        const allProcesses = yield* db
          .select()
          .from(schema.process)
          .where(eq(schema.process.path, processPath))
        expect(allProcesses).toHaveLength(2)
        expect(result1[0]!.id).not.toBe(result2[0]!.id)

        // Only non-deleted one should be active
        const activeProcesses = yield* db
          .select()
          .from(schema.process)
          .where(
            and(
              eq(schema.process._deleted, false),
              eq(schema.process.path, processPath),
            ),
          )
        expect(activeProcesses).toHaveLength(1)
        expect(activeProcesses[0]!.name).toBe("New Process")
      }),
  )

  it.effect("should allow same path for deleted and non-deleted roles", () =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const timestamp = Date.now()
      const orgPath = `org-role-test-${timestamp}`
      const rolePath = `${orgPath}/admin`

      // Create org unit first
      const orgResult = yield* db
        .insert(schema.orgUnit)
        .values({
          name: "Test Org",
          orgUnitLevel: "organisation",
          path: orgPath,
        })
        .returning({ id: schema.orgUnit.id })

      // Insert first role
      const result1 = yield* db
        .insert(schema.role)
        .values({
          orgUnitId: orgResult[0]!.id,
          name: "Original Admin",
          path: rolePath,
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
          path: rolePath,
        })
        .returning({ id: schema.role.id })

      // Both should exist (filter by our test path)
      const allRoles = yield* db
        .select()
        .from(schema.role)
        .where(eq(schema.role.path, rolePath))
      expect(allRoles).toHaveLength(2)
      expect(result1[0]!.id).not.toBe(result2[0]!.id)

      // Only non-deleted one should be active
      const activeRoles = yield* db
        .select()
        .from(schema.role)
        .where(
          and(eq(schema.role._deleted, false), eq(schema.role.path, rolePath)),
        )
      expect(activeRoles).toHaveLength(1)
      expect(activeRoles[0]!.name).toBe("New Admin")
    }),
  )

  it.effect("should allow same path for deleted and non-deleted steps", () =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const timestamp = Date.now()
      const orgPath = `org-step-test-${timestamp}`
      const processPath = `${orgPath}/process`
      const rolePath = `${orgPath}/admin`
      const stepPath = `${processPath}/step1`

      // Create org unit, process, and role
      const orgResult = yield* db
        .insert(schema.orgUnit)
        .values({
          name: "Test Org",
          orgUnitLevel: "organisation",
          path: orgPath,
        })
        .returning({ id: schema.orgUnit.id })

      const processResult = yield* db
        .insert(schema.process)
        .values({
          orgUnitId: orgResult[0]!.id,
          name: "Test Process",
          path: processPath,
          purpose: "Test",
        })
        .returning({ id: schema.process.id })

      const roleResult = yield* db
        .insert(schema.role)
        .values({
          orgUnitId: orgResult[0]!.id,
          name: "Admin",
          path: rolePath,
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
          path: stepPath,
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
          path: stepPath,
        })
        .returning({ id: schema.step.id })

      // Both should exist (filter by our test path)
      const allSteps = yield* db
        .select()
        .from(schema.step)
        .where(eq(schema.step.path, stepPath))
      expect(allSteps).toHaveLength(2)
      expect(result1[0]!.id).not.toBe(result2[0]!.id)

      // Only non-deleted one should be active
      const activeSteps = yield* db
        .select()
        .from(schema.step)
        .where(
          and(eq(schema.step._deleted, false), eq(schema.step.path, stepPath)),
        )
      expect(activeSteps).toHaveLength(1)
      expect(activeSteps[0]!.name).toBe("New Step")
    }),
  )

  it.effect(
    "should allow same source/target for deleted and non-deleted flows",
    () =>
      Effect.gen(function* () {
        const db = yield* TypedPostgresDrizzle
        const timestamp = Date.now()
        const orgPath = `org-flow-test-${timestamp}`
        const processPath = `${orgPath}/process`
        const rolePath = `${orgPath}/admin`
        const step1Path = `${processPath}/step1`
        const step2Path = `${processPath}/step2`

        // Create org unit, process, role, and steps
        const orgResult = yield* db
          .insert(schema.orgUnit)
          .values({
            name: "Test Org",
            orgUnitLevel: "organisation",
            path: orgPath,
          })
          .returning({ id: schema.orgUnit.id })

        const processResult = yield* db
          .insert(schema.process)
          .values({
            orgUnitId: orgResult[0]!.id,
            name: "Test Process",
            path: processPath,
            purpose: "Test",
          })
          .returning({ id: schema.process.id })

        const roleResult = yield* db
          .insert(schema.role)
          .values({
            orgUnitId: orgResult[0]!.id,
            name: "Admin",
            path: rolePath,
          })
          .returning({ id: schema.role.id })

        const step1Result = yield* db
          .insert(schema.step)
          .values({
            name: "Step 1",
            purpose: "First step",
            processId: processResult[0]!.id,
            roleId: roleResult[0]!.id,
            path: step1Path,
          })
          .returning({ id: schema.step.id })

        const step2Result = yield* db
          .insert(schema.step)
          .values({
            name: "Step 2",
            purpose: "Second step",
            processId: processResult[0]!.id,
            roleId: roleResult[0]!.id,
            path: step2Path,
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

        // Both should exist (filter by our test steps)
        const allFlows = yield* db
          .select()
          .from(schema.flow)
          .where(
            and(
              eq(schema.flow.sourceStepId, step1Result[0]!.id),
              eq(schema.flow.targetStepId, step2Result[0]!.id),
            ),
          )
        expect(allFlows).toHaveLength(2)
        expect(result1[0]!.id).not.toBe(result2[0]!.id)

        // Only non-deleted one should be active
        const activeFlows = yield* db
          .select()
          .from(schema.flow)
          .where(
            and(
              eq(schema.flow._deleted, false),
              eq(schema.flow.sourceStepId, step1Result[0]!.id),
              eq(schema.flow.targetStepId, step2Result[0]!.id),
            ),
          )
        expect(activeFlows).toHaveLength(1)
        expect(activeFlows[0]!.id).toBe(result2[0]!.id)
      }),
  )

  it.effect("should prevent duplicate role names within same org unit", () =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const timestamp = Date.now()

      const orgResult = yield* db
        .insert(schema.orgUnit)
        .values({
          name: "Test Organisation",
          orgUnitLevel: "organisation",
          path: `org-dup-role-${timestamp}`,
        })
        .returning({ id: schema.orgUnit.id })

      // Insert first role
      yield* db.insert(schema.role).values({
        orgUnitId: orgResult[0]!.id,
        name: "Admin",
        path: `org-dup-role-${timestamp}/admin`,
      })

      // Try to insert duplicate role name in same org unit (should fail)
      const result = yield* Effect.flip(
        db.insert(schema.role).values({
          orgUnitId: orgResult[0]!.id,
          name: "Admin",
          path: `org-dup-role-${timestamp}/admin2`,
        }),
      )

      // Should get a unique constraint violation
      expect(result).toBeDefined()
      // Check error message contains reference to unique constraint
      const errorStr = globalThis.JSON.stringify(result)
      expect(errorStr.toLowerCase()).toMatch(
        /unique|duplicate|role_orgunitunameidx/,
      )

      const roles = yield* db
        .select()
        .from(schema.role)
        .where(
          and(
            eq(schema.role._deleted, false),
            eq(schema.role.orgUnitId, orgResult[0]!.id),
          ),
        )
      expect(roles).toHaveLength(1)
    }),
  )

  it.effect("should allow same role name in different org units", () =>
    Effect.gen(function* () {
      const timestamp = Date.now()
      const db = yield* TypedPostgresDrizzle

      // NOTE: Using direct DB inserts instead of storeOrganisation() because:
      // - PostgreSQL tests share a single database instance across concurrent tests
      // - storeOrganisation() tries to delete org units not in the current tree
      // - This would conflict with org units from other running tests
      // For SQLite version using storeOrganisation(), see sqlite-operations/test/org-to-db.spec.ts

      const orgResult = yield* db
        .insert(schema.orgUnit)
        .values({
          name: `Test Org ${timestamp}`,
          orgUnitLevel: "organisation",
          path: `org-${timestamp}`,
        })
        .returning({ id: schema.orgUnit.id })

      const financeResult = yield* db
        .insert(schema.orgUnit)
        .values({
          name: "Finance Department",
          orgUnitLevel: "department",
          path: `org-${timestamp}/finance`,
          parentOrgUnitId: orgResult[0]!.id,
        })
        .returning({ id: schema.orgUnit.id })

      const engineeringResult = yield* db
        .insert(schema.orgUnit)
        .values({
          name: "Engineering Department",
          orgUnitLevel: "department",
          path: `org-${timestamp}/engineering`,
          parentOrgUnitId: orgResult[0]!.id,
        })
        .returning({ id: schema.orgUnit.id })

      // Insert roles with same name in different org units
      yield* db.insert(schema.role).values({
        orgUnitId: financeResult[0]!.id,
        name: "Manager",
        path: `org-${timestamp}/finance/manager`,
      })

      yield* db.insert(schema.role).values({
        orgUnitId: engineeringResult[0]!.id,
        name: "Manager",
        path: `org-${timestamp}/engineering/manager`,
      })

      // Verify both roles exist
      const allRoles = yield* db
        .select()
        .from(schema.role)
        .where(
          and(eq(schema.role._deleted, false), eq(schema.role.name, "Manager")),
        )

      const ourRoles = allRoles.filter((r: (typeof allRoles)[0]) =>
        r.path.includes(`${timestamp}`),
      )

      expect(ourRoles).toHaveLength(2)
      expect(
        ourRoles.every((r: (typeof allRoles)[0]) => r.name === "Manager"),
      ).toBe(true)
      expect(ourRoles[0]!.orgUnitId).not.toBe(ourRoles[1]!.orgUnitId)
    }),
  )

  it.effect(
    "should allow duplicate role name after soft-deleting original",
    () =>
      Effect.gen(function* () {
        const db = yield* TypedPostgresDrizzle
        const timestamp = Date.now()

        const orgResult = yield* db
          .insert(schema.orgUnit)
          .values({
            name: "Test Organisation",
            orgUnitLevel: "organisation",
            path: `org-softdelete-${timestamp}`,
          })
          .returning({ id: schema.orgUnit.id })

        // Insert first role
        const firstRole = yield* db
          .insert(schema.role)
          .values({
            orgUnitId: orgResult[0]!.id,
            name: "Admin",
            path: `org-softdelete-${timestamp}/admin1`,
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
          path: `org-softdelete-${timestamp}/admin2`,
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
          .where(
            and(
              eq(schema.role._deleted, false),
              eq(schema.role.orgUnitId, orgResult[0]!.id),
            ),
          )
        expect(activeRoles).toHaveLength(1)
        expect(activeRoles[0]!.name).toBe("Admin")
      }),
  )

  it.effect("should treat role names as case-insensitive", () =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const timestamp = Date.now()

      const orgResult = yield* db
        .insert(schema.orgUnit)
        .values({
          name: "Test Organisation",
          orgUnitLevel: "organisation",
          path: `org-case-test-${timestamp}`,
        })
        .returning({ id: schema.orgUnit.id })

      // Insert role with lowercase name
      yield* db.insert(schema.role).values({
        orgUnitId: orgResult[0]!.id,
        name: "admin",
        path: `org-case-test-${timestamp}/admin-lower`,
      })

      // Try to insert role with different case - should fail due to case-insensitive unique constraint
      const error = yield* db
        .insert(schema.role)
        .values({
          orgUnitId: orgResult[0]!.id,
          name: "Admin",
          path: `org-case-test-${timestamp}/admin-upper`,
        })
        .pipe(Effect.flip)

      expect(error).toBeDefined()

      const roles = yield* db
        .select()
        .from(schema.role)
        .where(
          and(
            eq(schema.role._deleted, false),
            eq(schema.role.orgUnitId, orgResult[0]!.id),
          ),
        )
      expect(roles).toHaveLength(1) // Case-insensitive: "admin" and "Admin" are duplicates
    }),
  )
})
