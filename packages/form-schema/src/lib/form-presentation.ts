import { Schema } from "effect"

/** Request data only. The executable schema remains the source of field structure. */
export const FormPresentation = Schema.Struct({
  label: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  href: Schema.optional(Schema.String),
})
export type FormPresentation = typeof FormPresentation.Type
export const FormRequestData = Schema.Struct({
  presentation: Schema.Record(Schema.String, FormPresentation),
  inaccessible: Schema.Array(Schema.String),
  originalValues: Schema.Record(Schema.String, Schema.Unknown),
  lookups: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        dependencies: Schema.Array(Schema.String),
        queryName: Schema.String,
      }),
    ),
  ),
  prefill: Schema.optional(
    Schema.Struct({
      dependency: Schema.String,
      fields: Schema.Array(Schema.String),
      concealed: Schema.Array(Schema.String),
      queryName: Schema.String,
    }),
  ),
})
export type FormRequestData = typeof FormRequestData.Type
