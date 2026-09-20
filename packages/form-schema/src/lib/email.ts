import { Schema } from "effect"
import isEmail from "validator/lib/isEmail"
import { FormEmailInput } from "./form-annotations"
import { type FieldOptions, applyFieldAnnotations } from "./form-schema"

/**
 * Email schema using validator.js for robust email validation.
 *
 * Configured to allow:
 * - UTF-8 local parts (e.g., üñîcödé@example.com)
 * - IDN/punycode domains (e.g., user@日本語.jp)
 * - localhost-style emails for development (e.g., user@localhost)
 *
 * The value is trimmed before validation.
 *
 * @example
 * ```typescript
 * import { EmailField } from "@pf/form-schema"
 *
 * const form = Schema.Struct({
 *   contactEmail: EmailField(),
 * })
 * ```
 */
export const Email = Schema.Trim.pipe(
  Schema.filter(
    (s) =>
      isEmail(s, {
        require_tld: false,
        allow_utf8_local_part: true,
        allow_ip_domain: true,
      }),
    { message: () => "must be a valid email address" },
  ),
  Schema.annotations({
    identifier: "Email",
    title: "Email address",
    description: "A valid email address",
    jsonSchema: { format: "email" },
    [FormEmailInput]: true,
  }),
)

export const EmailField = (
  options?: FieldOptions<string>,
): Schema.Schema<string, string, never> =>
  applyFieldAnnotations(Email, {
    autoComplete: options?.autoComplete ?? "email",
    ...options,
  })
