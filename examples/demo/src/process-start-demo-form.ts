import { Effect, Schema } from "effect"
import {
  FileField,
  ListField,
  LookupField,
  RadioField,
  TextField,
} from "@pf/form-schema"
import { withFormRules } from "@pf/form-submission-schema"
import { testDocumentsId } from "./file-upload-test-forms"

export const processStartDemoForm = withFormRules(
  Schema.Struct({
    kind: RadioField({
      label: "Request type",
      options: [
        { value: "standard", label: "Standard request" },
        { value: "exception", label: "Exception request" },
        { value: "attachment", label: "Request with attachment" },
        { value: "items", label: "Request with items" },
        { value: "region", label: "Request with region" },
        { value: "optional-region", label: "Request with optional region" },
      ],
      default: "standard",
    }),
    reason: Schema.optional(TextField({ label: "Exception reason" })),
    attachment: Schema.optional(
      FileField({
        label: "Supporting document",
        documentStore: { node: { path: `/${testDocumentsId}` } },
      }),
    ),
    items: Schema.optional(
      ListField({ name: TextField() }, { label: "Items", default: [] }),
    ),
    region: Schema.optional(
      LookupField({
        label: "Region",
        default: "region-1",
        query: () =>
          Effect.succeed([{ value: "region-1", label: "Region One" }]),
      }),
    ),
  }),
  ({ kind }) => ({
    reason: { hidden: kind !== "exception", required: kind === "exception" },
    attachment: {
      hidden: kind !== "attachment",
      required: kind === "attachment",
    },
    items: { hidden: kind !== "items", required: kind === "items" },
    region: {
      hidden: kind !== "region" && kind !== "optional-region",
      required: kind === "region",
    },
  }),
)
