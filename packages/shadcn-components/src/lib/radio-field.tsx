import type { StandardSchemaV1Issue } from "@tanstack/react-form"
import { useEffect, useRef } from "react"
import type { RadioFieldOption as FormSchemaRadioFieldOption } from "@pf/form-schema"
import { useFieldContext, useFormContext } from "./form-context"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "./ui/field"

export type { RadioFieldOption } from "@pf/form-schema"

export function RadioField({
  label,
  descriptionHtml,
  options,
  autoFocus,
  readOnly,
}: {
  readonly label: string
  readonly descriptionHtml?: string | undefined | null
  readonly options: readonly [
    FormSchemaRadioFieldOption,
    ...FormSchemaRadioFieldOption[],
  ]
  readonly autoFocus?: boolean
  readonly readOnly?: boolean
}) {
  const field = useFieldContext<string>()
  const form = useFormContext()
  const firstOptionRef = useRef<HTMLInputElement>(null)
  const validationErrors = field.state.meta
    .errors as unknown as StandardSchemaV1Issue[]
  const serverError = field.state.meta.errorMap?.onSubmit
  const allErrors: Array<{ message?: string }> = [
    ...validationErrors,
    ...(serverError ? [{ message: serverError as string }] : []),
  ]
  const { isTouched, isDefaultValue } = field.state.meta
  const afterSubmission = form.state.submissionAttempts > 0
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

  useEffect(() => {
    if (autoFocus === true && readOnly !== true) {
      firstOptionRef.current?.focus()
    }
  }, [autoFocus, readOnly])

  return (
    <FieldSet
      aria-describedby={describedBy.length > 0 ? describedBy : undefined}
      aria-invalid={isInvalid}
    >
      <FieldLegend>{label}</FieldLegend>
      {descriptionHtml && (
        <FieldDescription id={descriptionId} trustedHtml={descriptionHtml} />
      )}
      <div data-slot="radio-group" className="flex flex-col gap-3">
        {options.map((option, index) => {
          const id = `${field.name}-${option.value}`
          return (
            <Field key={option.value} orientation="horizontal">
              <input
                ref={index === 0 ? firstOptionRef : undefined}
                id={id}
                name={field.name}
                type="radio"
                value={option.value}
                checked={field.state.value === option.value}
                onChange={() => field.handleChange(option.value)}
                onBlur={() => field.handleBlur()}
                disabled={readOnly}
                className="size-4 shrink-0 rounded-full border border-input accent-primary"
              />
              <FieldLabel htmlFor={id}>{option.label}</FieldLabel>
            </Field>
          )
        })}
      </div>
      {isInvalid && <FieldError errors={allErrors} id={errorId} />}
    </FieldSet>
  )
}
