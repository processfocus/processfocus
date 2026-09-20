import { DateTime, Schema as ES, Effect } from "effect"
import { FormFileInput } from "@pf/form-schema"
import {
  DocumentStore,
  Form,
  NodeStep,
  OrgUnit,
  Organisation,
  Process,
  Role,
  Sla,
} from "@pf/process"
import { walkDocumentStores, walkOrganisation } from "./walker"
import { describe, expect, it } from "bun:test"

function createTestFixtures() {
  const organisation = new Organisation({ name: "Test Organisation" })
  const orgUnit = new OrgUnit(organisation, "test-unit", {
    name: "Test Unit",
    type: "department",
  })
  const role = new Role(orgUnit, "test-role", { name: "Test Role" })
  return { organisation, orgUnit, role }
}

describe("walkOrganisation - schedule text extraction", () => {
  it("should extract schedule text from flow edge", async () => {
    const { organisation, orgUnit, role } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test Process",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role,
      form: () => ({ start_date: ES.DateTimeUtc }),
    })
    const step2 = new Form(process, "step2", { role, form: () => ({}) })

    process.start(step1).end(step2, {
      schedule: {
        fn: (state) => state.start_date,
        text: "On the employee start date",
      },
    })

    const result = await Effect.runPromise(walkOrganisation(organisation))

    // Process is under the child orgUnit
    const childOrgUnit = result.rootOrgUnit.children[0]
    const flows = childOrgUnit?.processes[0]?.flows ?? []
    expect(flows).toHaveLength(1)
    expect(flows[0]?.schedule).toBe("On the employee start date")
  })

  it("should default to 'scheduled' when schedule function exists but no text", async () => {
    const { organisation, orgUnit, role } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test Process",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role,
      form: () => ({ start_date: ES.DateTimeUtc }),
    })
    const step2 = new Form(process, "step2", { role, form: () => ({}) })

    process.start(step1).end(step2, {
      schedule: {
        fn: (state) => state.start_date,
        // No text provided
      },
    })

    const result = await Effect.runPromise(walkOrganisation(organisation))

    const childOrgUnit = result.rootOrgUnit.children[0]
    const flows = childOrgUnit?.processes[0]?.flows ?? []
    expect(flows).toHaveLength(1)
    expect(flows[0]?.schedule).toBe("scheduled")
  })

  it("should not set schedule when no schedule option provided", async () => {
    const { organisation, orgUnit, role } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test Process",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", { role, form: () => ({}) })
    const step2 = new Form(process, "step2", { role, form: () => ({}) })

    process.start(step1).end(step2)

    const result = await Effect.runPromise(walkOrganisation(organisation))

    const childOrgUnit = result.rootOrgUnit.children[0]
    const flows = childOrgUnit?.processes[0]?.flows ?? []
    expect(flows).toHaveLength(1)
    expect(flows[0]?.schedule).toBeUndefined()
  })

  it("should extract multiple schedule texts from different flows", async () => {
    const { organisation, orgUnit, role } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test Process",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role,
      form: () => ({ start_date: ES.DateTimeUtc }),
    })
    const step2 = new Form(process, "step2", { role, form: () => ({}) })
    const step3 = new Form(process, "step3", { role, form: () => ({}) })

    const flow = process.start(step1)
    flow.end(step2, {
      schedule: {
        fn: (state) => state.start_date,
        text: "On employee start date",
      },
    })
    flow.end(step3, {
      schedule: {
        fn: (state) => DateTime.subtract(state.start_date, { days: 7 }),
        text: "One week before start",
      },
    })

    const result = await Effect.runPromise(walkOrganisation(organisation))

    const childOrgUnit = result.rootOrgUnit.children[0]
    const flows = childOrgUnit?.processes[0]?.flows ?? []
    expect(flows).toHaveLength(2)

    const scheduleTexts = flows.map((f) => f.schedule).sort()
    expect(scheduleTexts).toContain("On employee start date")
    expect(scheduleTexts).toContain("One week before start")
  })
})

describe("walkOrganisation - else label extraction", () => {
  it("should extract a label from a terminal else edge", async () => {
    const { organisation, orgUnit, role } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test Process",
      purpose: "Test",
    })

    const decision = new Form(process, "decision", {
      role,
      form: () => ({ approved: ES.Boolean }),
    })
    const approved = new Form(process, "approved", {
      role,
      form: () => ({}),
    })
    const declined = new Form(process, "declined", {
      role,
      form: () => ({}),
    })

    const flow = process.start(decision)
    flow
      .next(approved, {
        condition: { fn: (state) => state.approved, text: "Approved" },
      })
      .end()
    flow.elseEnd(declined, { text: "Declined" })

    const result = await Effect.runPromise(walkOrganisation(organisation))
    const flows = result.rootOrgUnit.children[0]?.processes[0]?.flows ?? []
    const elseFlow = flows.find((candidate) => candidate.isElse)

    expect(elseFlow?.condition).toBe("Declined")
  })
})

describe("walkOrganisation - SLA extraction", () => {
  it("should extract SLA from step", async () => {
    const { organisation, orgUnit, role } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test Process",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", { role, form: () => ({}) })
    const step2 = new Form(process, "step2", {
      role,
      form: () => ({}),
      sla: Sla.minutes(5),
    })

    process.start(step1).end(step2)

    const result = await Effect.runPromise(walkOrganisation(organisation))

    const childOrgUnit = result.rootOrgUnit.children[0]
    const steps = childOrgUnit?.processes[0]?.steps ?? []
    expect(steps).toHaveLength(2)

    const step2Data = steps.find((s) => s.name === "step2")
    expect(step2Data?.sla).toEqual({
      value: 5,
      unit: "minutes",
      warningAt: 80,
    })
  })

  it("should extract SLA with custom warning threshold", async () => {
    const { organisation, orgUnit, role } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test Process",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", {
      role,
      form: () => ({}),
      sla: Sla.businessHours(4, { warningAt: 0.5 }),
    })

    process.start(step1)

    const result = await Effect.runPromise(walkOrganisation(organisation))

    const childOrgUnit = result.rootOrgUnit.children[0]
    const steps = childOrgUnit?.processes[0]?.steps ?? []
    const step1Data = steps.find((s) => s.name === "step1")
    expect(step1Data?.sla).toEqual({
      value: 4,
      unit: "businessHours",
      warningAt: 50,
    })
  })

  it("should not set SLA when not provided", async () => {
    const { organisation, orgUnit, role } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test Process",
      purpose: "Test",
    })

    const step1 = new Form(process, "step1", { role, form: () => ({}) })

    process.start(step1)

    const result = await Effect.runPromise(walkOrganisation(organisation))

    const childOrgUnit = result.rootOrgUnit.children[0]
    const steps = childOrgUnit?.processes[0]?.steps ?? []
    const step1Data = steps.find((s) => s.name === "step1")
    expect(step1Data?.sla).toBeUndefined()
  })
})

describe("walkOrganisation - onError flow extraction", () => {
  it("should extract error edge metadata and tagged errors", async () => {
    const { organisation, orgUnit, role } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test Process",
      purpose: "Test",
    })

    const step1 = new NodeStep(process, "step1", {
      input: () => Effect.succeed({}),
      output: {},
      execute: () => Effect.succeed({}),
    })
    const step2 = new Form(process, "step2", { role, form: () => ({}) })

    process.start(step1)
    step1.onError(step2, { taggedErrors: ["Timeout"] }).end()

    const result = await Effect.runPromise(walkOrganisation(organisation))

    const childOrgUnit = result.rootOrgUnit.children[0]
    const flows = childOrgUnit?.processes[0]?.flows ?? []
    expect(flows).toHaveLength(1)
    expect(flows[0]).toMatchObject({
      isElse: false,
      isOnError: true,
      taggedErrors: ["Timeout"],
    })
  })
})

describe("walkOrganisation - document store references", () => {
  it("extracts a document store annotation from a refinement wrapper", async () => {
    const organisation = new Organisation({ name: "Test Organisation" })
    const role = new Role(organisation, "award-leader", {
      name: "Award Leader",
    })
    const process = new Process(organisation, "request-eotc-permission", {
      name: "Request EOTC permission",
      purpose: "Request permission",
    })
    const selectStudents = new Form(process, "Select students", {
      role,
      form: () => ({
        document: ES.String.pipe(ES.filter(() => true)).annotations({
          [FormFileInput]: { documentStore: "/google-generate-pdfs" },
        }),
      }),
    })
    process.start(selectStudents)

    const result = await Effect.runPromise(walkOrganisation(organisation))
    const step = result.rootOrgUnit.processes[0]?.steps[0]

    expect(step?.path).toBe("/request-eotc-permission/Select students")
    expect(step?.documentStoreReferences).toEqual(["/google-generate-pdfs"])
  })

  it("retains plain and transformed document store annotations", async () => {
    const { organisation, orgUnit, role } = createTestFixtures()
    const process = new Process(orgUnit, "process", {
      name: "Test Process",
      purpose: "Test",
    })
    const step = new Form(process, "step", {
      role,
      form: () => ({
        plain: ES.String.annotations({
          [FormFileInput]: { documentStore: "/plain-files" },
        }),
        transformed: ES.parseJson(ES.String).annotations({
          [FormFileInput]: { documentStore: "/transformed-files" },
        }),
      }),
    })
    process.start(step)

    const result = await Effect.runPromise(walkOrganisation(organisation))
    const extractedStep = result.rootOrgUnit.children[0]?.processes[0]?.steps[0]

    expect(extractedStep?.documentStoreReferences).toEqual([
      "/plain-files",
      "/transformed-files",
    ])
  })

  it("hydrates document references through optional property transformations and signature annotations", async () => {
    const { organisation, orgUnit, role } = createTestFixtures()
    const process = new Process(orgUnit, "optional-files", {
      name: "Optional files",
      purpose: "Test",
    })
    const step = new Form(process, "files", {
      role,
      form: () => ({
        optional: ES.optional(
          ES.String.annotations({
            [FormFileInput]: { documentStore: "/optional-files" },
          }),
        ),
        intrinsic: ES.optionalWith(
          ES.String.annotations({
            [FormFileInput]: { documentStore: "/intrinsic-files" },
          }),
          { default: () => "" },
        ),
        renamed: ES.optionalWith(ES.String, { default: () => "" })
          .pipe(ES.fromKey("encodedFile"))
          .annotations({
            [FormFileInput]: { documentStore: "/signature-files" },
          }),
      }),
    })
    process.start(step)
    const result = await Effect.runPromise(walkOrganisation(organisation))
    expect(
      result.rootOrgUnit.children[0]?.processes[0]?.steps[0]
        ?.documentStoreReferences,
    ).toEqual(["/optional-files", "/intrinsic-files", "/signature-files"])
  })
})

describe("walkDocumentStores", () => {
  it("retains the owning org unit for nested document stores", () => {
    const organisation = new Organisation({ name: "Test Organisation" })
    const unit = new OrgUnit(organisation, "records", {
      name: "Records",
      type: "department",
    })
    new DocumentStore(organisation, "root-files")
    new DocumentStore(unit, "unit-files")

    const stores = walkDocumentStores(organisation)
    expect(stores).toHaveLength(2)
    expect(stores).toContainEqual({
      orgUnitPath: "/",
      name: "root-files",
      path: "/root-files",
    })
    expect(stores).toContainEqual({
      orgUnitPath: "/records",
      name: "unit-files",
      path: "/records/unit-files",
    })
  })
})
