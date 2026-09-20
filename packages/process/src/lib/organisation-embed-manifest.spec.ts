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

    expect(manifest.entries).toEqual([
      expect.objectContaining({
        stepPath: "/school/enrolment/Submit enquiry",
        processName: "Enrolment Enquiry",
        mutationName: "startSchoolEnrolment",
        sites: ["https://school.example.com"],
        thankYou: "Thanks for your enquiry.",
        formDefinition: expect.objectContaining({
          components: expect.objectContaining({
            firstName: expect.objectContaining({ _tag: "text" }),
          }),
          rules: [],
        }),
      }),
    ])
    expect(
      Object.values(
        manifest.entries[0]?.formDefinition?.components ?? {},
      ).every((component) => typeof component._tag === "string"),
    ).toBe(true)
    expect(parseOrganisationEmbedManifest(manifest)).toEqual(manifest)

    expect(() =>
      parseOrganisationEmbedManifest({
        ...manifest,
        entries: manifest.entries.map((entry) => ({
          ...entry,
          formDefinition: {
            components: entry.formDefinition?.components,
            rules: {},
          },
        })),
      }),
    ).toThrow("must be a valid client form definition")

    expect(() =>
      parseOrganisationEmbedManifest({
        ...manifest,
        entries: manifest.entries.map(
          ({ formDefinition: _, ...entry }) => entry,
        ),
      }),
    ).toThrow(
      "entries[0].formDefinition must be a valid client form definition",
    )

    expect(() =>
      parseOrganisationEmbedManifest({ ...manifest, version: 0 }),
    ).toThrow("organisation embed manifest version must be 2")
  })

  it("includes serialized rules in embedded form manifests", async () => {
    const { org, unit, role } = makeOrg()
    const process = new Process(unit, "enrolment", {
      name: "Enrolment Enquiry",
      purpose: "Capture enquiries",
    })

    const start = new Form(process, "Submit enquiry", {
      role,
      embed: {
        externalParticipantEmailField: "email",
        sites: ["https://school.example.com/"],
        thankYou: "Thanks for your enquiry.",
      },
      form: () => ({
        email: ES.String,
        firstName: TextField({ label: "First name" }),
        details: TextField({ label: "Details" }),
      }),
    }).rules((value, rule) => [
      rule.when(value.firstName.blank()).effects({
        details: { disabled: true },
      }),
    ])

    process.start(start).end()

    const manifest = await Effect.runPromise(
      buildOrganisationEmbedManifest(org),
    )

    expect(manifest.entries).toEqual([
      expect.objectContaining({
        formDefinition: {
          components: expect.objectContaining({
            firstName: expect.objectContaining({ _tag: "text" }),
            details: expect.objectContaining({ _tag: "text" }),
          }),
          rules: [
            {
              condition: {
                _tag: "blank",
                value: { _tag: "field", path: ["firstName"] },
              },
              effects: [{ target: ["details"], state: { disabled: true } }],
            },
          ],
        },
      }),
    ])
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

    expect(manifest.entries).toEqual([
      expect.objectContaining({
        stepPath: "/school/enrolment/Submit enquiry",
        formDefinition: expect.objectContaining({
          components: expect.objectContaining({
            campusId: expect.objectContaining({
              _tag: "lookup",
              field: "campusId",
              label: "Campus",
            }),
          }),
        }),
      }),
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

    expect(manifest.entries).toEqual([
      expect.objectContaining({
        formDefinition: expect.objectContaining({
          components: expect.objectContaining({
            campusId: expect.objectContaining({
              _tag: "lookup",
              field: "campusId",
            }),
            classId: expect.objectContaining({
              _tag: "lookup",
              field: "classId",
              dependencies: ["campusId"],
              queryName: "lookupSchoolEnrolmentSubmitEnquiryClassId",
            }),
          }),
        }),
      }),
    ])
  })

  it("rejects embedded forms that use file fields", async () => {
    const { org, unit, role } = makeOrg()
    const process = new Process(unit, "enrolment", {
      name: "Enrolment Enquiry",
      purpose: "Capture enquiries",
    })
    const documents = new DocumentStore(org, "files")

    const start = new Form(process, "Submit enquiry", {
      role,
      embed: {
        externalParticipantEmailField: "email",
        sites: ["https://school.example.com"],
        thankYou: "Thanks",
      },
      form: () => ({
        email: ES.String,
        attachment: FileField({
          label: "Attachment",
          documentStore: documents,
        }),
      }),
    })

    process.start(start).end()

    await expect(
      Effect.runPromise(buildOrganisationEmbedManifest(org)),
    ).rejects.toThrow(
      "Embedded form /school/enrolment/Submit enquiry uses unsupported field type file.",
    )
  })

  it("rejects embedded processes with multiple start steps", async () => {
    const { org, unit, role } = makeOrg()
    const process = new Process(unit, "enrolment", {
      name: "Enrolment Enquiry",
      purpose: "Capture enquiries",
    })

    const primary = new Form(process, "Primary", {
      role,
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
