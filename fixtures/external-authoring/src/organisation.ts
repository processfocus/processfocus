import { AwsFunctionStep } from "@processfocus/plugin-aws-lambda"
import { PostHog } from "@processfocus/plugin-posthog"
import {
  RUNTIME_ARTIFACT_FORMAT,
  RUNTIME_ARTIFACT_VERSION,
  parseRuntimeArtifact,
} from "@processfocus/runtime"
import { Effect, Schema } from "effect"
import {
  AuthenticationConfig,
  Form,
  OrgUnit,
  Organisation,
  PoliciesConfig,
  Process,
  Role,
} from "processfocus"
import { Saturday, Sunday, createDefaultConfig } from "processfocus/calendar"
import { TextField } from "processfocus/forms"
import type { OrganisationFrontendPluginManifestJson } from "processfocus/plugin"
import { validateOrganisation } from "processfocus/testing"

export const org = new Organisation({
  name: "External Fixture",
  timeZone: "Pacific/Auckland",
})
const operations = new OrgUnit(org, "Operations", { name: "Operations" })
const author = new Role(operations, "Author", { name: "Author" })
const process = new Process(operations, "Representative", {
  name: "Representative",
  purpose: "Exercise the public authoring distribution",
})

new AuthenticationConfig(org, "Authentication", {})
new PoliciesConfig(org, "Policies", {
  policyFiles: ["cedar/example.cedar"],
})

const calendar = createDefaultConfig()
const pluginConfig: OrganisationFrontendPluginManifestJson = { enabled: true }
const field = TextField({ label: "Summary" })
let resolvedDefaults = 0
const submit = new Form(process, "Submit", {
  name: "Submit representative form",
  form: ({ value }) => ({
    summary: field,
    display: TextField({
      readOnly: true,
      default: value(() => {
        resolvedDefaults++
        return "Read-only fixture"
      }),
    }),
  }),
  role: author,
})
const flow = process.start(submit)

const enrich = new AwsFunctionStep(flow, "Enrich", {
  functionName: "external-fixture-enrich",
  input: () => Effect.succeed({ summary: "fixture" }),
  output: { enriched: Schema.Boolean },
})
flow.next(enrich).end()

new PostHog(org, "posthog", {
  apiKey: "phc_external_fixture",
  enabled: true,
  host: "https://us.i.posthog.com",
})

if (
  calendar.weeklySchedule.length === 0 ||
  !calendar.nonWorkingDays.includes(Saturday) ||
  !calendar.nonWorkingDays.includes(Sunday) ||
  !field ||
  !pluginConfig
) {
  throw new Error("Representative authoring surface failed")
}
const errors = validateOrganisation(org)
if (errors.length > 0) throw new Error(errors.join("\n"))
if (resolvedDefaults !== 0)
  throw new Error("Runtime defaults resolved during organisation construction")

Effect.runSync(
  parseRuntimeArtifact({
    format: RUNTIME_ARTIFACT_FORMAT,
    version: RUNTIME_ARTIFACT_VERSION,
    organisation: {},
    extensions: { "fixture/plugin": { enabled: true } },
  }),
)
