import { createFormHook, createFormHookContexts } from "@tanstack/react-form"
import { BooleanField } from "./boolean-field"
import { FileField } from "./file-field"
import { TextField } from "./text-field"

// export useFieldContext/useFormContext for use in your custom components
export const { fieldContext, formContext, useFieldContext, useFormContext } =
  createFormHookContexts()

export const { useAppForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: {
    BooleanField,
    FileField,
    TextField,
  },
  formComponents: {},
})
