import { Schema as ES, Effect } from "effect"
import { FileField, LookupField, TextField } from "@pf/form-schema"
import {
  DocumentStore,
  Form,
  OrgUnit,
  Organisation,
  Process,
  Role,
  buildOrganisationEmbedManifest,
  parseOrganisationEmbedManifest,
} from "../index"
import { describe, expect, it } from "bun:test"

const makeOrg = () => {
  const org = new Organisation({ name: "Test Org" })
  const unit = new OrgUnit(org, "school", {
    name: "School",
    type: "department",
  })
  const role = new Role(unit, "office", { name: "Office" })

  return { org, unit, role }
}

describe("buildOrganisationEmbedManifest", () => {
  it("builds an embed manifest entry for an embedded start form", async () => {
    const { org, unit, role } = makeOrg()
    const process = new Process(unit, "enrolment", {
      name: "Enrolment Enquiry",
      purpose: "Capture enquiries",
    })

    const start = new Form(process, "Submit enquiry", {
      role,
      browser: { entrypoint: "form.ts", exportName: "form" },
      embed: {
        externalParticipantEmailField: "email",
        sites: ["https://school.example.com/"],
        thankYou: "Thanks for your enquiry.",
      },
      form: () => ({
        email: ES.String,
        firstName: TextField({ label: "First name" }),
        childName: TextField({ label: "Child name" }),
      }),
    })

    process.start(start).end()

    const manifest = await Effect.runPromise(
      buildOrganisationEmbedManifest(org),
    )

    expect(manifest.entries[0]).toMatchObject({
      stepPath: "/school/enrolment/Submit enquiry",
      formPath: "/school/enrolment/Submit enquiry",
      mutationName: "startSchoolEnrolment",
      sites: ["https://school.example.com"],
      lookups: [],
    })
    expect(manifest.entries[0]).not.toHaveProperty("formDefinition")
    expect(manifest.entries[0]).not.toHaveProperty("jsonSchema")
    expect(
      parseOrganisationEmbedManifest(JSON.parse(JSON.stringify(manifest))),
    ).toEqual(manifest)
    expect(() =>
      parseOrganisationEmbedManifest({ ...manifest, version: 0 }),
    ).toThrow("version must be 3")
  })

  it("rejects embedded forms that are not process start steps", async () => {
    const { org, unit, role } = makeOrg()
    const process = new Process(unit, "enrolment", {
      name: "Enrolment Enquiry",
      purpose: "Capture enquiries",
    })

    const start = new Form(process, "Start", {
      role,
      form: () => ({
        firstName: ES.String,
      }),
    })

    const flow = process.start(start)
    const followUp = new Form(flow, "Follow up", {
      role,
      browser: { entrypoint: "form.ts", exportName: "form" },
      embed: {
        externalParticipantEmailField: "email",
        sites: ["https://school.example.com"],
        thankYou: "Thanks",
      },
      form: () => ({
        email: ES.String,
        notes: ES.String,
      }),
    })

    flow.end(followUp)

    await expect(
      Effect.runPromise(buildOrganisationEmbedManifest(org)),
    ).rejects.toThrow(
      "Embedded form /school/enrolment/Follow up is not a process start step.",
    )
  })

  it("allows embedded forms that use lookup fields", async () => {
    const { org, unit, role } = makeOrg()
    const process = new Process(unit, "enrolment", {
      name: "Enrolment Enquiry",
      purpose: "Capture enquiries",
    })

    const start = new Form(process, "Submit enquiry", {
      role,
      browser: { entrypoint: "form.ts", exportName: "form" },
      embed: {
        externalParticipantEmailField: "email",
        sites: ["https://school.example.com"],
        thankYou: "Thanks",
      },
      form: () => ({
        email: ES.String,
        campusId: LookupField({
          label: "Campus",
          query: () => Effect.succeed([]),
        }),
      }),
    })

    process.start(start).end()

    const manifest = await Effect.runPromise(
      buildOrganisationEmbedManifest(org),
    )

    expect(manifest.entries[0]?.lookups).toEqual([
      {
        type: "lookup",
        field: "campusId",
        normalizedField: "campusId",
        dependencies: [],
      },
    ])
  })

  it("rejects embedded forms with an external participant email field outside the submission schema", () => {
    const { unit, role } = makeOrg()
    const process = new Process(unit, "enrolment", {
      name: "Enrolment Enquiry",
      purpose: "Capture enquiries",
    })

    expect(
      () =>
        new Form(process, "Submit enquiry", {
          role,
          browser: { entrypoint: "form.ts", exportName: "form" },
          embed: {
            externalParticipantEmailField: "email",
            sites: ["https://school.example.com"],
            thankYou: "Thanks",
          },
          form: () => ({
            firstName: ES.String,
          }),
        }),
    ).toThrow(
      'Embedded form external participant email field "email" is not a submittable form field',
    )
  })

  it("includes dependent lookup metadata in embedded form manifests", async () => {
    const { org, unit, role } = makeOrg()
    const process = new Process(unit, "enrolment", {
      name: "Enrolment Enquiry",
      purpose: "Capture enquiries",
    })

    const start = new Form(process, "Submit enquiry", {
      role,
      browser: { entrypoint: "form.ts", exportName: "form" },
      embed: {
        externalParticipantEmailField: "email",
        sites: ["https://school.example.com"],
        thankYou: "Thanks",
      },
      form: () => ({
        email: ES.String,
        campusId: LookupField({ label: "Campus" }),
        classId: LookupField({ label: "Class" }),
      }),
    })

    start.lookups.campusId.setQuery(({ filter }, _limit) =>
      Effect.succeed([{ value: filter, label: filter }]),
    )
    start.lookups.classId
      .dependsOn([start.lookups.campusId])
      .setQuery(({ campusId, filter }, _limit) =>
        Effect.succeed([
          { value: `${campusId}:${filter}`, label: `${campusId}:${filter}` },
        ]),
      )

    process.start(start).end()

    const manifest = await Effect.runPromise(
      buildOrganisationEmbedManifest(org),
    )

    expect(manifest.entries[0]?.lookups).toEqual([
      {
        type: "lookup",
        field: "campusId",
        normalizedField: "campusId",
        dependencies: [],
      },
      {
        type: "lookup",
        field: "classId",
        normalizedField: "classId",
        dependencies: ["campusId"],
        queryName: "lookupSchoolEnrolmentSubmitEnquiryClassId",
      },
    ])
  })

  it.each([false, true])(
    "rejects embedded file fields, including list children (nested=%s)",
    async (nested) => {
      const { org, unit, role } = makeOrg()
      const process = new Process(unit, "enrolment", {
        name: "Enrolment Enquiry",
        purpose: "Capture enquiries",
      })
      const documents = new DocumentStore(org, "files")

      const start = new Form(process, "Submit enquiry", {
        role,
        browser: { entrypoint: "form.ts", exportName: "form" },
        embed: {
          externalParticipantEmailField: "email",
          sites: ["https://school.example.com"],
          thankYou: "Thanks",
        },
        form: () => ({
          email: ES.String,
          attachment: nested
            ? ES.Array(
                ES.Struct({
                  file: FileField({
                    label: "Attachment",
                    documentStore: documents,
                  }),
                }),
              )
            : FileField({ label: "Attachment", documentStore: documents }),
        }),
      })

      process.start(start).end()

      await expect(
        Effect.runPromise(buildOrganisationEmbedManifest(org)),
      ).rejects.toThrow(
        "Embedded file uploads require an anonymous upload authorization model.",
      )
    },
  )

  it("rejects embedded processes with multiple start steps", async () => {
    const { org, unit, role } = makeOrg()
    const process = new Process(unit, "enrolment", {
      name: "Enrolment Enquiry",
      purpose: "Capture enquiries",
    })

    const primary = new Form(process, "Primary", {
      role,
      browser: { entrypoint: "form.ts", exportName: "form" },
      embed: {
        externalParticipantEmailField: "email",
        sites: ["https://school.example.com"],
        thankYou: "Thanks",
      },
      form: () => ({ email: ES.String, firstName: ES.String }),
    })
    const secondary = new Form(process, "Secondary", {
      role,
      form: () => ({ lastName: ES.String }),
    })

    process.start(primary).end()
    process.start(secondary).end()

    await expect(
      Effect.runPromise(buildOrganisationEmbedManifest(org)),
    ).rejects.toThrow("Embedded process /school/enrolment has 2 start steps.")
  })
})
