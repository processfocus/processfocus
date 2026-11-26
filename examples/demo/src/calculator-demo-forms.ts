// Public executable definitions; runtime callbacks stay in the process module.
import { Schema as ES } from "effect"
import { NumberFieldFrom, NumberFromString, TextField } from "@pf/form-schema"

export const enterNumbersForm = ES.Struct({
  email: TextField({ label: "Email" }),
  a: NumberFieldFrom(NumberFromString, {
    label: "First number",
    required: true,
  }),
  b: NumberFieldFrom(NumberFromString, {
    label: "Second number",
    required: true,
  }),
})

export const showResultForm = ES.Struct({
  firstNumber: TextField({
    label: "First number",
    readOnly: true,
  }),
  secondNumber: TextField({
    label: "Second number",
    readOnly: true,
  }),
  sum: TextField({
    label: "Sum",
    readOnly: true,
  }),
})
