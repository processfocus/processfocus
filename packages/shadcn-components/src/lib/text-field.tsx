import type { StandardSchemaV1Issue } from "@tanstack/react-form"
import { useFieldContext, useFormContext } from "./form-context"
import { Field, FieldDescription, FieldError, FieldLabel } from "./ui/field"
import { Input } from "./ui/input"
import { Textarea } from "./ui/textarea"

// Note: Character filtering is intentionally liberal during typing.
// Strict validation happens via schema on blur.

/**
 * Filters input value based on regex pattern, preserving cursor position.
 * Returns the filtered value and whether filtering occurred.
 */
const filterInput = (
  value: string,
  pattern: RegExp,
  input: HTMLInputElement,
  cursorPos: number,
): { value: string; filtered: boolean } => {
  const filtered = value.replace(pattern, "")
  if (filtered !== value) {
    const charsRemoved = value.length - filtered.length
    // Restore cursor position accounting for removed characters
    requestAnimationFrame(() => {
      const newPos = Math.max(0, cursorPos - charsRemoved)
      input.setSelectionRange(newPos, newPos)
    })
    return { value: filtered, filtered: true }
  }
  return { value, filtered: false }
}

const useStringFieldState = () => {
  const field = useFieldContext<string>()
  const form = useFormContext()
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

  return {
    field,
    isInvalid,
    allErrors,
    errorId: `${field.name}-error`,
  }
}

const tabbableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",")

const moveTextareaFocus = (
  textarea: HTMLTextAreaElement,
  direction: "next" | "previous",
) => {
  const root = textarea.form ?? document
  const tabbables = Array.from(
    root.querySelectorAll<HTMLElement>(tabbableSelector),
  ).filter(
    (element) =>
      element.tabIndex >= 0 &&
      (element.checkVisibility?.() ?? element.offsetParent !== null) &&
      element.getAttribute("aria-hidden") !== "true",
  )
  const currentIndex = tabbables.indexOf(textarea)
  if (currentIndex === -1) return

  const nextIndex = direction === "next" ? currentIndex + 1 : currentIndex - 1
  const next = tabbables[nextIndex]
  if (!next) return

  next.focus()
}

export function TextField({
  label,
  descriptionHtml,
  type,
  inputMode,
  autoComplete,
  autoFocus,
  readOnly,
}: {
  label: string
  descriptionHtml?: string | undefined | null
  type?: string
  inputMode?: "decimal" | "text" | "email" | "tel"
  autoComplete?: string | undefined
  autoFocus?: boolean
  readOnly?: boolean
}) {
  const { field, isInvalid, allErrors, errorId } = useStringFieldState()

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (readOnly === true) return

    const input = e.target as HTMLInputElement
    const value = input.value
    const cursorPos = input.selectionStart ?? value.length

    // Filter non-numeric characters when in decimal inputMode
    // Allow: digits, decimal points, commas, plus, minus, spaces
    if (inputMode === "decimal" && value) {
      const { value: filtered, filtered: didFilter } = filterInput(
        value,
        /[^0-9.,+\s-]/g,
        input,
        cursorPos,
      )
      if (didFilter) {
        field.handleChange(filtered)
        return
      }
    }

    // Filter invalid characters when in tel inputMode (phone numbers)
    // Allow: digits, +, -, spaces, parentheses (matches server validation)
    if (inputMode === "tel" && value) {
      // First filter: only allow valid phone characters
      const { value: filteredChars, filtered: didFilterChars } = filterInput(
        value,
        /[^0-9+\s\-()]/g,
        input,
        cursorPos,
      )

      // Second filter: plus sign must be at start
      let filtered = filteredChars
      if (filtered.includes("+") && !filtered.startsWith("+")) {
        // Remove plus signs that aren't at the start
        filtered = filtered.replace(/(?!^)\+/g, "")
        const charsRemoved = filteredChars.length - filtered.length
        requestAnimationFrame(() => {
          const newPos = Math.max(0, cursorPos - charsRemoved)
          input.setSelectionRange(newPos, newPos)
        })
        field.handleChange(filtered)
        return
      }

      if (didFilterChars) {
        field.handleChange(filtered)
        return
      }
    }

    field.handleChange(value)
  }

  return (
    <Field>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Input
        name={field.name}
        value={field.state.value ?? ""}
        type={type ?? ""}
        inputMode={inputMode}
        autoComplete={autoComplete}
        onChange={handleChange}
        onBlur={() => field.handleBlur()}
        onFocus={(e) => {
          if (readOnly !== true) {
            e.target.select()
          }
        }}
        placeholder={undefined}
        autoFocus={autoFocus}
        readOnly={readOnly}
        aria-invalid={isInvalid}
        aria-describedby={isInvalid ? errorId : undefined}
      />
      {isInvalid && allErrors.length > 0 && (
        <FieldError errors={allErrors} id={errorId} />
      )}
      {descriptionHtml && <FieldDescription trustedHtml={descriptionHtml} />}
    </Field>
  )
}

export function TextAreaField({
  label,
  descriptionHtml,
  autoFocus,
  readOnly,
}: {
  label: string
  descriptionHtml?: string | undefined | null
  autoFocus?: boolean
  readOnly?: boolean
}) {
  const { field, isInvalid, allErrors, errorId } = useStringFieldState()

  return (
    <Field>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Textarea
        id={field.name}
        name={field.name}
        value={field.state.value ?? ""}
        onChange={(e) => {
          if (readOnly === true) return
          field.handleChange(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return
          const active = document.activeElement
          moveTextareaFocus(e.currentTarget, e.shiftKey ? "previous" : "next")
          if (document.activeElement !== active) {
            e.preventDefault()
          }
        }}
        onBlur={() => field.handleBlur()}
        onFocus={(e) => {
          if (readOnly !== true) {
            e.target.select()
          }
        }}
        autoFocus={autoFocus}
        readOnly={readOnly}
        rows={4}
        aria-invalid={isInvalid}
        aria-describedby={isInvalid ? errorId : undefined}
        className="min-h-24"
      />
      {isInvalid && allErrors.length > 0 && (
        <FieldError errors={allErrors} id={errorId} />
      )}
      {descriptionHtml && <FieldDescription trustedHtml={descriptionHtml} />}
    </Field>
  )
}
