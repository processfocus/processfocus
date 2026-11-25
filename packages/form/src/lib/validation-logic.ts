import {
  type AnyFieldMeta,
  type ValidationLogicProps,
  defaultValidationLogic,
} from "@tanstack/react-form"

/**
 * Subset of TanStack Form's AnyFieldMeta that we access in validation logic.
 * This provides a stable interface that won't break if TanStack Form's internal
 * types change, while still maintaining type safety.
 */
type FieldMetaSubset = Pick<
  AnyFieldMeta,
  "isDirty" | "errors" | "isDefaultValue"
>

/**
 * Runtime type guard to validate that a value conforms to FieldMetaSubset.
 * Used defensively when accessing form.state.fieldMeta to ensure the properties
 * we depend on actually exist at runtime.
 */
const isFieldMetaSubset = (meta: unknown): meta is FieldMetaSubset => {
  if (typeof meta !== "object" || meta === null) return false
  const m = meta as Record<string, unknown>
  return (
    "isDirty" in m &&
    typeof m["isDirty"] === "boolean" &&
    "errors" in m &&
    Array.isArray(m["errors"]) &&
    "isDefaultValue" in m &&
    typeof m["isDefaultValue"] === "boolean"
  )
}

/**
 * Helper to safely get fieldMeta as a Record of FieldMetaSubset.
 * Returns undefined if fieldMeta is not available or empty.
 */
const getFieldMetaRecord = (
  fieldMeta: unknown,
): Record<string, FieldMetaSubset> | undefined => {
  if (typeof fieldMeta !== "object" || fieldMeta === null) return undefined
  const record = fieldMeta as Record<string, unknown>
  // Filter to only entries that match our expected shape
  const validEntries = Object.entries(record).filter(([, value]) =>
    isFieldMetaSubset(value),
  )
  if (validEntries.length === 0) return undefined
  return Object.fromEntries(validEntries) as Record<string, FieldMetaSubset>
}

/**
 * Custom validation logic for dynamic form fields.
 *
 * Improves UX over revalidateLogic by:
 * - Skipping blur validation on non-dirty fields (prevents errors on tab-through)
 * - Re-validating on change when field already has errors (clears errors as user types)
 * - Always validating on submit
 * - Always validating after first submission attempt (same as revalidateLogic)
 *
 * Type Safety Note:
 * The function is cast to ValidationLogicFn at the end because TanStack Form's type
 * definition declares this as returning void. However, internally TanStack Form's
 * getSyncValidatorArray relies on the return value flowing through from runValidation.
 * This matches the pattern used by revalidateLogic in the TanStack Form source.
 * The cast is necessary to satisfy TypeScript while preserving the runtime behavior
 * that TanStack Form expects.
 */
export const customValidationLogic = ((props: ValidationLogicProps) => {
  const { form, validators, event, runValidation } = props

  const validatorKeys = Object.keys(validators ?? {})
  if (validatorKeys.length === 0) {
    return runValidation({ validators: [], form })
  }

  type Validator = Parameters<
    ValidationLogicProps["runValidation"]
  >[0]["validators"][number]

  const validatorFn = event.async
    ? validators?.["onDynamicAsync"]
    : validators?.["onDynamic"]

  if (!validatorFn) {
    return runValidation({ validators: [], form })
  }

  const dynamicValidator: Validator = {
    fn: validatorFn,
    cause: "dynamic" as const,
  }

  // Collect default validators from defaultValidationLogic
  let defaultValidators: Validator[] = []
  defaultValidationLogic({
    ...props,
    runValidation: (vProps) => {
      defaultValidators = vProps.validators
    },
  })

  const afterSubmission = form.state.submissionAttempts > 0
  let includeDynamic = false

  switch (event.type) {
    case "submit": {
      // Always validate on submit
      includeDynamic = true
      break
    }
    case "blur": {
      if (afterSubmission) {
        // After submission: always validate on blur
        includeDynamic = true
      } else {
        // Before submission: only validate if any field has been modified (prevents #1)
        const fieldMeta = getFieldMetaRecord(form.state.fieldMeta)
        includeDynamic = fieldMeta
          ? Object.values(fieldMeta).some((m) => m.isDirty)
          : false
      }
      break
    }
    case "change": {
      if (afterSubmission) {
        // After submission: always validate on change
        includeDynamic = true
      } else {
        // Before submission: only re-validate when a dirty field has errors (fixes #4, #5).
        // Fields at their default value may have stale errors from a previous editing cycle;
        // those should not trigger re-validation so the field behaves as untouched.
        const fieldMeta = getFieldMetaRecord(form.state.fieldMeta)
        includeDynamic = fieldMeta
          ? Object.values(fieldMeta).some(
              (m) => m.errors.length > 0 && !m.isDefaultValue,
            )
          : false
      }
      break
    }
    default: {
      // mount, server — do not add dynamic validator
      includeDynamic = false
    }
  }

  if (includeDynamic) {
    return runValidation({
      validators: [...defaultValidators, dynamicValidator],
      form,
    })
  }

  // For blur/change: clear stale onDynamic errors with a no-op validator.
  // This mirrors how defaultValidationLogic clears onServer errors using () => undefined.
  // Without this, errors from a previous validation cycle persist in errorMap.onDynamic.
  if (event.type === "blur" || event.type === "change") {
    const clearDynamic: Validator = {
      fn: () => undefined,
      cause: "dynamic" as const,
    }
    return runValidation({
      validators: [...defaultValidators, clearDynamic],
      form,
    })
  }

  return runValidation({ validators: defaultValidators, form })
  // Cast: ValidationLogicFn type declares void, but TanStack Form internally
  // relies on the return value. Required to match revalidateLogic pattern.
}) as (props: ValidationLogicProps) => void
