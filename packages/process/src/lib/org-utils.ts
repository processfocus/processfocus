/**
 * Normalizes a path for database storage by ensuring it starts with a forward slash.
 * Paths in constructs don't have a leading slash, but stored paths should have one
 * to clearly indicate they are paths.
 *
 * @param path - Path like "Demo/engineering/bug-fix" or "/Demo/engineering/bug-fix"
 * @returns Normalized path with leading slash like "/Demo/engineering/bug-fix"
 *
 * @example
 * ```ts
 * normalizePath("Demo/engineering/bug-fix")
 * // => "/Demo/engineering/bug-fix"
 *
 * normalizePath("/Demo/engineering/bug-fix")
 * // => "/Demo/engineering/bug-fix"
 * ```
 */
export const normalizePath = (path: string): string => {
  return path.startsWith("/") ? path : `/${path}`
}

/**
 * Strips the leading slash from a path, converting from database format to construct format.
 * This is the inverse of normalizePath.
 *
 * @param path - Path like "/Demo/engineering/bug-fix" or "Demo/engineering/bug-fix"
 * @returns Path without leading slash like "Demo/engineering/bug-fix"
 *
 * @example
 * ```ts
 * toConstructPath("/Demo/engineering/bug-fix")
 * // => "Demo/engineering/bug-fix"
 *
 * toConstructPath("Demo/engineering/bug-fix")
 * // => "Demo/engineering/bug-fix"
 * ```
 */
export const toConstructPath = (path: string): string => {
  return path.startsWith("/") ? path.slice(1) : path
}

/**
 * Converts a construct path to a PascalCase name.
 * Used for generating GraphQL type names from step/process paths.
 * Path format: "orgUnit/processName/stepName" or "/orgUnit/processName/stepName"
 *
 * Handles optional leading slash for backward compatibility.
 *
 * @param path - Full construct path like "engineering/bug-report-fix/Report bug"
 *               or "/engineering/bug-report-fix/Report bug"
 * @returns PascalCase name like "EngineeringBugReportFixReportBug"
 *
 * @example
 * ```ts
 * pathToPascalCase("engineering/bug-report-fix/Report bug")
 * // => "EngineeringBugReportFixReportBug"
 *
 * pathToPascalCase("/engineering/bug-report-fix/Report bug")
 * // => "EngineeringBugReportFixReportBug"
 * ```
 */
export const pathToPascalCase = (path: string): string => {
  const segments = path.split("/").filter((segment) => segment.length > 0)

  const pascalSegments = segments.map((segment) => {
    const words = segment
      .replace(/-/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 0)

    return words
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join("")
  })

  return pascalSegments.join("")
}
