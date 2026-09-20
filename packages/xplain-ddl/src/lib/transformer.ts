import { Effect } from "effect"
import type { BaseDeclaration, Program, TypeDeclaration } from "./ast.js"

/**
 * Helper function to resolve an attribute name against one or more symbol tables.
 * Follows the resolution logic:
 * 1. Try the attribute name as-is
 * 2. If not found and name contains underscore, try the part after first underscore
 */
const resolveAttributeName = (
  attrName: string,
  maps: Map<string, unknown>[],
): string => {
  // Try the attribute name as-is first
  let resolvedBaseName = attrName

  // Check if found in any map
  const isFound = maps.some((map) => map.has(resolvedBaseName))

  // If not found, try derived name (split at first underscore)
  if (!isFound) {
    const underscoreIndex = attrName.indexOf("_")
    if (underscoreIndex > 0) {
      const derivedName = attrName.substring(underscoreIndex + 1)
      if (maps.some((map) => map.has(derivedName))) {
        resolvedBaseName = derivedName
      }
    }
  }

  return resolvedBaseName
}

/**
 * Resolve base names for all attributes in the program.
 * This is a pure transformation that returns a new AST with resolved base names.
 *
 * The resolution logic:
 * 1. Try the attribute name as-is (e.g., "price" stays "price")
 * 2. If not found and name contains underscore, try the part after first underscore
 *    (e.g., "unit_price" resolves to "price")
 */
export const resolveBaseNames = (
  program: Program,
): Effect.Effect<Program, never> =>
  Effect.sync(() => {
    // Build symbol tables for lookup
    const baseMap = new Map<string, BaseDeclaration>()
    const typeMap = new Map<string, TypeDeclaration>()

    for (const base of program.bases) {
      baseMap.set(base.name, base)
    }

    for (const type of program.types) {
      typeMap.set(type.name, type)
    }

    // Transform types with resolved base names
    const transformedTypes = program.types.map((type) => ({
      ...type,
      attributes: type.attributes.map((attr) => {
        // For specializations, the name must be a type (will be validated later)
        const resolvedBaseName = attr.isSpecialization
          ? resolveAttributeName(attr.name, [typeMap])
          : resolveAttributeName(attr.name, [baseMap, typeMap])

        return {
          ...attr,
          baseName: resolvedBaseName,
        }
      }),
    }))

    return {
      ...program,
      types: transformedTypes,
    }
  })
