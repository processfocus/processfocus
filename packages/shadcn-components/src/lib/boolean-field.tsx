import type { StandardSchemaV1Issue } from "@tanstack/react-form"
import { useFieldContext, useFormContext } from "./form-context"
import { Checkbox } from "./ui/checkbox"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "./ui/field"

export function BooleanField({
  label,
  descriptionHtml,
  readOnly,
}: {
  label: string
  descriptionHtml?: string | undefined | null
  readOnly?: boolean
  required?: boolean
}) {
  const field = useFieldContext<boolean>()
  const form = useFormContext()
  const validationErrors = field.state.meta
    .errors as unknown as StandardSchemaV1Issue[]
  // Server-side errors are stored in errorMap.onSubmit
  const serverError = field.state.meta.errorMap?.onSubmit
  // Combine validation errors with server-side error
  const allErrors: Array<{ message?: string }> = [
    ...validationErrors,
    ...(serverError ? [{ message: serverError as string }] : []),
  ]
  const { isTouched, isDefaultValue } = field.state.meta
  const afterSubmission = form.state.submissionAttempts > 0
  // Show errors after user has actively edited the field, or after first submit attempt
  const isInvalid =
    (afterSubmission && allErrors.length > 0) ||
    (isTouched && !isDefaultValue && allErrors.length > 0)
  const errorId = `${field.name}-error`
  const descriptionId = `${field.name}-description`
  const describedBy = [
    descriptionHtml ? descriptionId : undefined,
    isInvalid ? errorId : undefined,
  ]
    .filter((id): id is string => id !== undefined)
    .join(" ")

  return (
    <Field orientation="horizontal">
      <Checkbox
        id={field.name}
        checked={field.state.value ?? false}
        onCheckedChange={(checked) => {
          if (!readOnly) {
            field.handleChange(checked === true)
          }
        }}
        onBlur={() => field.handleBlur()}
        disabled={readOnly}
        aria-invalid={isInvalid}
        aria-describedby={describedBy.length > 0 ? describedBy : undefined}
        {...(readOnly && { tabIndex: -1 })}
      />
      <FieldContent>
        <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
        {descriptionHtml && (
          <FieldDescription id={descriptionId} trustedHtml={descriptionHtml} />
        )}
        {isInvalid && <FieldError errors={allErrors} id={errorId} />}
      </FieldContent>
    </Field>
  )
}
