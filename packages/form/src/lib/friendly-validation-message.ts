const requiredPropertyPattern = /^must have required property ['"].+['"]$/i

// Some server-side validation messages come from process/embed boundaries and
// contain implementation names. Normalize them at the form display boundary.
const missingValuePatterns = [
  requiredPropertyPattern,
  /^is missing$/i,
  /^external participant email is required$/i,
]

const isMinimumOneCharacter = (params: Record<string, unknown> | undefined) =>
  params?.["limit"] === 1

const isTrueOnlyEnum = (params: Record<string, unknown> | undefined) => {
  const allowedValues = params?.["allowedValues"]
  return (
    Array.isArray(allowedValues) &&
    allowedValues.length === 1 &&
    allowedValues[0] === true
  )
}

const isFormat = (
  params: Record<string, unknown> | undefined,
  format: string,
) => params?.["format"] === format

export interface JsonSchemaValidationMessageInput {
  readonly keyword?: string
  readonly message?: string
  readonly params?: Record<string, unknown>
}

export const friendlyJsonSchemaValidationMessage = ({
  keyword,
  message,
  params,
}: JsonSchemaValidationMessageInput): string => {
  if (keyword === "required") {
    return "This field is required."
  }

  // AJV reports empty required strings as minLength errors, but form users
  // should see the same required-field copy as missing values.
  if (keyword === "minLength" && isMinimumOneCharacter(params)) {
    return "This field is required."
  }

  if (keyword === "enum" && isTrueOnlyEnum(params)) {
    return "This field is required."
  }

  if (keyword === "format" && isFormat(params, "email")) {
    return "Please enter a valid email address."
  }

  if (keyword === "format" && isFormat(params, "phone")) {
    return "Please enter a valid phone number."
  }

  return friendlyFormValidationMessage(message ?? "Validation failed")
}

export const friendlyFormValidationMessage = (message: string): string => {
  const trimmed = message.trim()

  if (missingValuePatterns.some((pattern) => pattern.test(trimmed))) {
    return "This field is required."
  }

  if (
    /^external participant email must be a valid email address$/i.test(
      trimmed,
    ) ||
    /^must be a valid email address$/i.test(trimmed)
  ) {
    return "Please enter a valid email address."
  }

  if (/^must be a valid phone number/i.test(trimmed)) {
    return "Please enter a valid phone number."
  }

  return message
}
