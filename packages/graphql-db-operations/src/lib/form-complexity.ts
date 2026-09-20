/**
 * Form complexity levels based on field count.
 */
export type FormComplexity = "Simple" | "Medium" | "Complex"

/**
 * Calculate form complexity based on number of fields.
 * - Simple: 0-5 fields (or null/no form)
 * - Medium: 6-15 fields
 * - Complex: 16+ fields
 */
export function calculateFormComplexity(
  formFields: number | null,
): FormComplexity {
  if (formFields === null || formFields <= 5) return "Simple"
  if (formFields <= 15) return "Medium"
  return "Complex"
}
