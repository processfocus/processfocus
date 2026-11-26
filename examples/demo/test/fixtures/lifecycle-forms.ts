import { Schema } from "effect"
export const controlForm = Schema.Struct({ control: Schema.String })
export const dateForm = Schema.Struct({ date: Schema.String })
export const emptyForm = Schema.Struct({})
