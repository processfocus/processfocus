import { DateTime, Effect, Schema } from "effect"
import { printSchema } from "graphql"
import {
  CalendarSlotField,
  EmailField,
  FormDefault,
  ListField,
  LookupField,
  TextBlock,
  TextField,
  Wrapper,
} from "@pf/form-schema"
import {
  Form,
  OrgUnit,
  Organisation,
  Process,
  Role,
  buildFlowContext,
  buildOrganisationDeployManifest,
  buildOrganisationEmbedManifest,
  parseOrganisationDeployManifest,
} from "@pf/process"
import { buildFormContractSchema } from "../testing"
import { expect, it } from "bun:test"

const fixture = (deferred: boolean) => {
  const org = new Organisation({ name: "Contract" })
  const unit = new OrgUnit(org, "unit", { name: "Unit", type: "department" })
  const role = new Role(unit, "member", { name: "Member" })
  const process = new Process(unit, "process", {
    name: "Process",
    purpose: "contract",
  })
  const fields = {
    email: EmailField(),
    group: Wrapper({
      amount: Schema.NumberFromString.annotations({ [FormDefault]: "12" }),
    }),
    nested: Schema.Struct({
      name: TextField(),
      display: TextField({ readOnly: true }),
    }),
    rows: ListField({
      name: TextField(),
      display: TextField({ readOnly: true }),
    }),
    display: TextField({ readOnly: true }),
    lookup: LookupField({}),
    calendar: CalendarSlotField({ timeZone: "UTC" }),
    content: TextBlock("fallback"),
  }
  let calls = 0
  const props = { role }
  const form = deferred
    ? new Form(process, "submit", {
        ...props,
        form: ({ value }) => ({
          ...fields,
          display: TextField({
            readOnly: true,
            default: value((_state, ctx) => {
              calls++
              if (ctx.process.executionId !== "actual")
                throw new Error("synthetic context")
              return "display"
            }),
          }),
        }),
      })
    : new Form(process, "submit", {
        ...props,
        form: () => ({
          ...fields,
          display: TextField({ readOnly: true, default: "display" }),
          group: Wrapper({
            amount: Schema.NumberFromString.annotations({
              [FormDefault]: "12",
            }),
          }),
        }),
      })
  process.start(form).end()
  return { org, form, calls: () => calls }
}

it("keeps static and deferred defaults equivalent across Effect, JSON, GraphQL and metadata", async () => {
  const old = fixture(false)
  const next = fixture(true)
  expect(printSchema(await buildFormContractSchema(next.org))).toBe(
    printSchema(await buildFormContractSchema(old.org)),
  )
  expect(next.form.submissionSchema()).toEqual(old.form.submissionSchema())
  expect(await Effect.runPromise(next.form.clientFormDefinition())).toEqual(
    await Effect.runPromise(old.form.clientFormDefinition()),
  )
  expect(next.calls()).toBe(0)
  const context = {
    ...buildFlowContext("actual", DateTime.unsafeNow(), []),
    step: {},
  }
  expect(
    await Effect.runPromise(next.form.resolveDefaults({}, context)),
  ).toEqual(await Effect.runPromise(old.form.resolveDefaults({}, context)))
  const input = {
    email: "test@example.com",
    amount: "12",
    nested: { name: "nested" },
    rows: [{ name: "row" }],
    lookup: "id",
    calendar: "slot",
  }
  const decode = (form: typeof next.form) =>
    Schema.decodeUnknownSync(
      form.submissionEffectSchema as Schema.Schema<unknown>,
    )(input)
  expect(decode(next.form)).toEqual(decode(old.form))
  expect(decode(next.form)).toMatchObject({ amount: 12 })
})

it("emits v3 for every organisation and rejects obsolete manifest versions", () => {
  const old = buildOrganisationDeployManifest({
    org: fixture(false).org,
    orgBundleSha256: "a".repeat(64),
  })
  const next = buildOrganisationDeployManifest({
    org: fixture(true).org,
    orgBundleSha256: "b".repeat(64),
  })
  expect(old.version).toBe(3)
  expect(next.version).toBe(3)
  expect(parseOrganisationDeployManifest(old).version).toBe(3)
  expect(parseOrganisationDeployManifest(next).version).toBe(3)
  expect(() =>
    parseOrganisationDeployManifest({ ...next, version: 2 }),
  ).toThrow()
  expect(() =>
    parseOrganisationDeployManifest({ ...next, version: 99 }),
  ).toThrow()
})

it("builds embedded manifests from static fallbacks without calling decoration", async () => {
  const { org, role, process } = (() => {
    const org = new Organisation({ name: "Embed" })
    const unit = new OrgUnit(org, "unit", { name: "Unit", type: "department" })
    return {
      org,
      role: new Role(unit, "member", { name: "Member" }),
      process: new Process(unit, "process", {
        name: "Process",
        purpose: "test",
      }),
    }
  })()
  const form = new Form(process, "submit", {
    role,
    embed: {
      externalParticipantEmailField: "email",
      sites: ["https://example.com"],
      thankYou: "Thanks",
    },
    form: ({ content }) => ({
      email: EmailField(),
      content: content(() => {
        throw new Error("must not execute during import")
      }, TextBlock("fallback")),
    }),
  })
  process.start(form).end()
  const manifest = await Effect.runPromise(buildOrganisationEmbedManifest(org))
  expect(JSON.stringify(manifest)).toContain("fallback")
})
