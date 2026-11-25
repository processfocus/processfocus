import { Effect } from "effect"
import { searchLookupItems } from "@pf/form-schema"
import {
  Form,
  FormSubmissionError,
  type OrgUnit,
  Process,
  type Role,
} from "@pf/process"
import { dependentLookupsForm } from "./dependent-lookups-form"

const regions = [
  { value: "north", label: "North" },
  { value: "south", label: "South" },
]

/** Small authored datasets demonstrate the same contract in both modes. */
const choices = (region: string | undefined, kind: "Depot" | "Recipient") =>
  regions.some((item) => item.value === region)
    ? Array.from({ length: 30 }, (_, index) => ({
        value: `${region}-${kind.toLowerCase()}-${index}`,
        label: `${region} ${kind} café ${index}`,
        searchText: index === 29 ? "dispatch" : "",
      }))
    : []

export class DependentLookups extends Process {
  constructor(scope: OrgUnit, id: string, role: Role) {
    super(scope, id, {
      name: "Dependent lookups",
      purpose: "Choose a regional depot and recipient",
    })
    const form = new Form(this, "Submit", {
      role,
      form: dependentLookupsForm,
      browser: {
        entrypoint: "src/dependent-lookups-form.ts",
        exportName: "dependentLookupsForm",
      },
      onSubmit: (input) =>
        Effect.gen(function* () {
          for (const [field, kind] of [
            ["depot", "Depot"],
            ["recipient", "Recipient"],
          ] as const) {
            if (
              !choices(input.region, kind).some(
                (item) => item.value === input[field],
              )
            )
              return yield* new FormSubmissionError({
                field,
                message: "Select a choice in the current region.",
              })
          }
        }),
    })
    form.lookups.region.setQuery(() => Effect.succeed(regions))
    form.lookups.depot
      .dependsOn([form.lookups.region])
      .setQuery(({ region }, limit) =>
        Effect.succeed(choices(region, "Depot").slice(0, limit)),
      )
    form.lookups.recipient
      .dependsOn([form.lookups.region])
      .setQuery(({ region, filter }, limit) =>
        Effect.succeed(
          searchLookupItems(choices(region, "Recipient"), filter, limit),
        ),
      )
    this.start(form).end()
  }
}
