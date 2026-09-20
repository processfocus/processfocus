import { useStore } from "@tanstack/react-form"
import { useEffect, useRef } from "react"
import { useFieldContext, useFormContext } from "./form-context"
import { Field, FieldDescription, FieldError, FieldLabel } from "./ui/field"

/** Fixed string choices, projected from the authoritative submission schema. */
export function SelectField({
  label,
  descriptionHtml,
  options,
  emptyValue,
  autoFocus,
  readOnly,
}: {
  readonly label: string
  readonly descriptionHtml?: string | null | undefined
  readonly options: readonly string[]
  readonly emptyValue?: "null" | "undefined"
  readonly autoFocus?: boolean
  readonly readOnly?: boolean
}) {
  const ref = useRef<HTMLSelectElement>(null)
  useEffect(() => {
    if (autoFocus && !readOnly) ref.current?.focus()
  }, [autoFocus, readOnly])
  const field = useFieldContext<string | null | undefined>()
  const selectedIndex =
    field.state.value == null ? -1 : options.indexOf(field.state.value)
  const form = useFormContext()
  const afterSubmission = useStore(
    form.store,
    (state) => state.submissionAttempts > 0,
  )
  const errors: Array<{ message: string }> = field.state.meta.errors.flatMap(
    (error: unknown) => {
      if (typeof error === "string") return [{ message: error }]
      if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
      )
        return [{ message: error.message }]
      return []
    },
  )
  const serverError: unknown = field.state.meta.errorMap?.onSubmit
  if (
    typeof serverError === "string" &&
    !errors.some((error) => error.message === serverError)
  ) {
    errors.push({ message: serverError })
  }
  const invalid =
    errors.length > 0 &&
    (afterSubmission ||
      (field.state.meta.isTouched && !field.state.meta.isDefaultValue))
  const errorId = `${field.name}-error`
  const descriptionId = `${field.name}-description`
  const describedBy = [
    descriptionHtml ? descriptionId : null,
    invalid ? errorId : null,
  ]
    .filter(Boolean)
    .join(" ")
  return (
    <Field>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <select
        id={field.name}
        name={field.name}
        // An unmatched value would make the browser display the first enabled
        // option even though the form has not selected it.
        value={selectedIndex < 0 ? "" : String(selectedIndex)}
        ref={ref}
        disabled={readOnly}
        onChange={(event) =>
          field.handleChange(
            event.target.value === ""
              ? emptyValue === "null"
                ? null
                : undefined
              : options[Number(event.target.value)],
          )
        }
        onBlur={() => field.handleBlur()}
        aria-invalid={invalid}
        aria-describedby={describedBy || undefined}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:opacity-50"
      >
        <option value="" disabled={emptyValue === undefined}>
          {emptyValue === undefined ? "Select an option" : "No selection"}
        </option>
        {options.map((option, index) => (
          <option key={option} value={String(index)}>
            {option || "No value"}
          </option>
        ))}
      </select>
      {descriptionHtml ? (
        <FieldDescription id={descriptionId} trustedHtml={descriptionHtml} />
      ) : null}
      {invalid ? <FieldError errors={errors} id={errorId} /> : null}
    </Field>
  )
}
