import { Schema } from "effect"
import { FormPhoneInput } from "./form-annotations"
import { type FieldOptions, applyFieldAnnotations } from "./form-schema"

/**
 * Validates a phone number using practical rules:
 * - Must contain only digits, spaces, dashes, parentheses, and plus sign
 * - Must have between 7 and 15 digits (ITU E.164 standard)
 * - Plus sign (country code prefix) can only appear at the start
 *
 * This is more practical than isMobilePhone which has locale-specific
 * rules that reject valid numbers.
 *
 * @example
 * ```typescript
 * import { PhoneField } from "@pf/form-schema"
 *
 * const form = Schema.Struct({
 *   contactPhone: PhoneField(),
 * })
 * ```
 */

// Valid characters with an optional leading country-code plus sign.
const VALID_PHONE_CHARS = /^\+?[\d\s\-()]+$/

// Count digits in the string
const countDigits = (s: string): number => {
  return (s.match(/\d/g) || []).length
}

const isPhoneNumber = (s: string): boolean => {
  if (!VALID_PHONE_CHARS.test(s)) {
    return false
  }

  const digitCount = countDigits(s)
  return digitCount >= 7 && digitCount <= 15
}

export const Phone = Schema.Trim.pipe(
  Schema.filter((s) => isPhoneNumber(s), {
    message: () => "must be a valid phone number (7-15 digits)",
  }),
  Schema.annotations({
    identifier: "Phone",
    title: "Phone number",
    description: "A valid phone number",
    jsonSchema: { format: "phone" },
    [FormPhoneInput]: true,
  }),
)

export const PhoneField = (
  options?: FieldOptions<string>,
): Schema.Schema<string, string, never> =>
  applyFieldAnnotations(Phone, {
    autoComplete: options?.autoComplete ?? "tel",
    ...options,
  })
