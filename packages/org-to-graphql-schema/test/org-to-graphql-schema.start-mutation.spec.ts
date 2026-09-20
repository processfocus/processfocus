import { Schema as ES, Effect } from "effect"
import { parse } from "graphql"
import { LookupField } from "@pf/form-schema"
import {
  Form,
  NodeStep,
  OrgUnit,
  Organisation,
  OrganisationProviderTest,
  Process,
  Role,
} from "@pf/process"
import { buildDynamicSchema } from "../src/lib/org-to-graphql-schema"
import { describe, expect, it } from "bun:test"

describe("org-to-graphql-schema - start mutation generation", () => {
  /**
   * Helper to run buildDynamicSchema with a test organization
   */
  const runSchemaBuilder = (org: Organisation): Promise<string> => {
    const testLayer = OrganisationProviderTest(org)
    return Effect.runPromise(
      buildDynamicSchema().pipe(Effect.provide(testLayer)),
    )
  }

  /**
   * Helper to validate that generated SDL is valid GraphQL
   */
  const validateGraphQL = (sdl: string): void => {
    expect(() => parse(sdl)).not.toThrow()
  }

  it("should generate start mutation for process with input", async () => {
    const org = new Organisation({ name: "test-org" })
    const dept = new OrgUnit(org, "engineering", {
      name: "Engineering",
      type: "department",
    })
    const employeeRole = new Role(dept, "employee")

    const process = new Process(dept, "bug-report", {
      name: "Bug Report",
      purpose: "Report bugs",
    })

    const form = new Form(process, "submit", {
      name: "Submit Bug",
      form: () => ({
        description: ES.String,
      }),
      role: employeeRole,
    })

    process.start(form)

    const sdl = await runSchemaBuilder(org)

    // Should contain StartProcessPayload type with non-nullable success fields
    // Validation errors are returned via GraphQL errors with structured extensions
    expect(sdl).toContain("type StartProcessPayload")
    expect(sdl).toContain("deduplicated: Boolean!")
    expect(sdl).toContain("executionId: ID!")
    expect(sdl).toContain("processId: ID!")
    expect(sdl).toContain("processPath: String!")
    expect(sdl).toContain("timestamp: DateTimeISO!")

    // Should NOT contain StartDraftProcessPayload type
    expect(sdl).not.toContain("type StartDraftProcessPayload")
    expect(sdl).not.toContain("processStateId: ID!")

    // Should contain type Mutation block
    expect(sdl).toContain("type Mutation {")

    // Should contain start mutation with correct return type
    expect(sdl).toContain(
      "startEngineeringBugReport(input: EngineeringBugReportSubmit!, executionId: ID, withoutWaiting: Boolean = false): StartProcessPayload!",
    )

    // Should NOT contain startDraft mutation
    expect(sdl).not.toContain("startDraftEngineeringBugReport")

    // Should be valid GraphQL
    validateGraphQL(sdl)
  })

  it("should only generate start mutation (no draft) when start node has no input", async () => {
    const org = new Organisation({ name: "test-org" })
    const dept = new OrgUnit(org, "engineering", {
      name: "Engineering",
      type: "department",
    })
    const employeeRole = new Role(dept, "employee")

    const process = new Process(dept, "simple-process", {
      name: "Simple Process",
      purpose: "Test",
    })

    const form = new Form(process, "review", {
      name: "Review",
      form: () => ({}),
      role: employeeRole,
    })

    process.start(form)

    const sdl = await runSchemaBuilder(org)

    // Should contain start mutation without input parameter
    expect(sdl).toContain(
      "startEngineeringSimpleProcess(executionId: ID, withoutWaiting: Boolean = false): StartProcessPayload!",
    )

    // Should NOT contain startDraft mutation
    expect(sdl).not.toContain("startDraftEngineeringSimpleProcess")

    // Should be valid GraphQL
    validateGraphQL(sdl)
  })

  it("generates a no-input start mutation for a system-start process", async () => {
    const org = new Organisation({ name: "test-org" })
    const dept = new OrgUnit(org, "engineering", {
      name: "Engineering",
      type: "department",
    })

    const process = new Process(dept, "system-start", {
      name: "System Start",
      purpose: "Test",
    })

    const hello = new NodeStep(process, "hello", {
      name: "Hello",
      input: () => Effect.succeed({}),
      output: { greeting: ES.String },
      execute: () => Effect.succeed({ greeting: "hello" }),
    })

    process.start(hello).end()

    const sdl = await runSchemaBuilder(org)

    expect(sdl).toContain(
      "startEngineeringSystemStart(executionId: ID, withoutWaiting: Boolean = false): StartProcessPayload!",
    )
    expect(sdl).not.toContain("startEngineeringSystemStart(input:")
    validateGraphQL(sdl)
  })

  it("tags cron-enabled system-start mutations for scheduler access", async () => {
    const org = new Organisation({ name: "test-org" })
    const dept = new OrgUnit(org, "engineering", {
      name: "Engineering",
      type: "department",
    })

    const process = new Process(dept, "nightly-sync", {
      name: "Nightly Sync",
      purpose: "Run every night",
      cron: {
        type: "daily",
        at: { hour: 2, minute: 15 },
      },
    })

    const syncStep = new NodeStep(process, "sync", {
      name: "Sync",
      input: () => Effect.succeed({}),
      output: {},
      execute: () => Effect.succeed({}),
    })

    process.start(syncStep).end()

    const sdl = await runSchemaBuilder(org)

    expect(sdl).toContain(
      'startEngineeringNightlySync(executionId: ID, withoutWaiting: Boolean = false): StartProcessPayload! @auth(tag: "cron")',
    )
    validateGraphQL(sdl)
  })

  it("tags embedded start mutations for frontend embed access", async () => {
    const org = new Organisation({ name: "test-org" })
    const dept = new OrgUnit(org, "engineering", {
      name: "Engineering",
      type: "department",
    })
    const employeeRole = new Role(dept, "employee")

    const process = new Process(dept, "public-enquiry", {
      name: "Public Enquiry",
      purpose: "Test",
    })

    const form = new Form(process, "submit", {
      name: "Submit enquiry",
      role: employeeRole,
      embed: {
        externalParticipantEmailField: "email",
        sites: ["https://school.example.com"],
        thankYou: "Thanks",
      },
      form: () => ({ email: ES.String, field: ES.String }),
    })

    process.start(form).end()

    const sdl = await runSchemaBuilder(org)

    expect(sdl).toContain(
      'startEngineeringPublicEnquiry(input: EngineeringPublicEnquirySubmit!, executionId: ID, withoutWaiting: Boolean = false): StartProcessPayload! @auth(tag: "embed")',
    )
    validateGraphQL(sdl)
  })

  it("tags dependent lookup queries only for embedded forms", async () => {
    const org = new Organisation({ name: "test-org" })
    const dept = new OrgUnit(org, "engineering", {
      name: "Engineering",
      type: "department",
    })
    const employeeRole = new Role(dept, "employee")

    const embeddedProcess = new Process(dept, "public-enquiry", {
      name: "Public Enquiry",
      purpose: "Test",
    })

    const embeddedForm = new Form(embeddedProcess, "submit", {
      name: "Submit enquiry",
      role: employeeRole,
      embed: {
        externalParticipantEmailField: "email",
        sites: ["https://school.example.com"],
        thankYou: "Thanks",
      },
      form: () => ({
        email: ES.String,
        projectId: LookupField({ label: "Project" }),
        stageId: LookupField({ label: "Stage" }),
      }),
    })

    embeddedForm.lookups.projectId.setQuery(({ filter }, _limit) =>
      Effect.succeed([{ value: filter, label: filter }]),
    )
    embeddedForm.lookups.stageId
      .dependsOn([embeddedForm.lookups.projectId])
      .setQuery(({ projectId, filter }, _limit) =>
        Effect.succeed([
          { value: `${projectId}:${filter}`, label: `${projectId}:${filter}` },
        ]),
      )

    embeddedProcess.start(embeddedForm).end()

    const internalProcess = new Process(dept, "internal-enquiry", {
      name: "Internal Enquiry",
      purpose: "Test",
    })

    const internalForm = new Form(internalProcess, "submit", {
      name: "Submit enquiry",
      role: employeeRole,
      form: () => ({
        projectId: LookupField({ label: "Project" }),
        stageId: LookupField({ label: "Stage" }),
      }),
    })

    internalForm.lookups.projectId.setQuery(({ filter }, _limit) =>
      Effect.succeed([{ value: filter, label: filter }]),
    )
    internalForm.lookups.stageId
      .dependsOn([internalForm.lookups.projectId])
      .setQuery(({ projectId, filter }, _limit) =>
        Effect.succeed([
          { value: `${projectId}:${filter}`, label: `${projectId}:${filter}` },
        ]),
      )

    internalProcess.start(internalForm).end()

    const sdl = await runSchemaBuilder(org)

    expect(sdl).toContain(
      'lookupEngineeringPublicEnquirySubmitStageId(input: LookupEngineeringPublicEnquirySubmitStageIdInput!, limit: Int): [LookupItem!]! @auth(tag: "embed")',
    )
    expect(sdl).toContain(
      "lookupEngineeringInternalEnquirySubmitStageId(input: LookupEngineeringInternalEnquirySubmitStageIdInput!, limit: Int): [LookupItem!]!",
    )
    expect(sdl).not.toContain(
      'lookupEngineeringInternalEnquirySubmitStageId(input: LookupEngineeringInternalEnquirySubmitStageIdInput!, limit: Int): [LookupItem!]! @auth(tag: "embed")',
    )
    validateGraphQL(sdl)
  })

  it("should allow process with multiple start nodes", async () => {
    const org = new Organisation({ name: "test-org" })
    const dept = new OrgUnit(org, "engineering", {
      name: "Engineering",
      type: "department",
    })
    const employeeRole = new Role(dept, "employee")

    const process = new Process(dept, "multi-start", {
      name: "Multi Start",
      purpose: "Test",
    })

    // Create two forms as start nodes - both are valid start points
    const form1 = new Form(process, "form1", {
      name: "Form 1",
      form: () => ({ field1: ES.String }),
      role: employeeRole,
    })

    const form2 = new Form(process, "form2", {
      name: "Form 2",
      form: () => ({ field2: ES.String }),
      role: employeeRole,
    })

    // Both forms need to be connected via start() and terminated with end()
    process.start(form1).end()
    process.start(form2).end()

    const testLayer = OrganisationProviderTest(org)

    // Multiple start nodes are now allowed
    const sdl = await Effect.runPromise(
      buildDynamicSchema().pipe(Effect.provide(testLayer)),
    )

    // Should generate a mutation using the first start node's input
    expect(sdl).toContain("startEngineeringMultiStart")
    validateGraphQL(sdl)
  })

  it("should fail when process has no start nodes", async () => {
    const org = new Organisation({ name: "test-org" })
    const dept = new OrgUnit(org, "engineering", {
      name: "Engineering",
      type: "department",
    })
    const employeeRole = new Role(dept, "employee")

    const process = new Process(dept, "no-start", {
      name: "No Start",
      purpose: "Test",
    })

    // Create two forms and connect them in a cycle
    const form1 = new Form(process, "form1", {
      name: "Form 1",
      form: () => ({ field1: ES.String }),
      role: employeeRole,
    })

    const form2 = new Form(process, "form2", {
      name: "Form 2",
      form: () => ({ field2: ES.String }),
      role: employeeRole,
    })

    // Create a cycle - both nodes have in-degree > 0, so no start nodes
    form1.next(form2)
    form2.next(form1)

    const testLayer = OrganisationProviderTest(org)

    await expect(
      Effect.runPromise(buildDynamicSchema().pipe(Effect.provide(testLayer))),
    ).rejects.toThrow("has no start nodes")
  })
})
