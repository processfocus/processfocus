/**
 * Generic recursive org unit type that can handle any nesting depth
 * This is more flexible than the GraphQL-generated type which has a fixed depth
 */
interface RecursiveOrgUnit {
  id: string
  name: string
  level: string
  subunits: RecursiveOrgUnit[]
}

/**
 * Flattened org unit structure for the org chart layout
 */
interface FlatOrgUnit {
  id: string
  name: string
  level: string
  parentId?: string
}

/**
 * Flatten a nested GraphQL org structure into a flat array with parentId references
 */
export const flattenOrgUnits = (
  orgUnit: RecursiveOrgUnit,
  parentId?: string,
): FlatOrgUnit[] => {
  const result: FlatOrgUnit[] = []

  // Add the current unit
  const flatUnit: FlatOrgUnit = {
    id: orgUnit.id,
    name: orgUnit.name,
    level: orgUnit.level,
  }

  if (parentId !== undefined) {
    flatUnit.parentId = parentId
  }

  result.push(flatUnit)

  // Recursively process subunits
  for (const subunit of orgUnit.subunits) {
    result.push(...flattenOrgUnits(subunit, orgUnit.id))
  }

  return result
}
