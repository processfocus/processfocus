/**
 * Type definitions for org chart nodes
 */

export interface OrgUnit {
  id: string
  name: string
  level: string
  parentId?: string
}

export interface OrgUnitNodeData extends Record<string, unknown> {
  name: string
  level: string
  width: number
  depth?: number
}
