import { and, eq, isNull, not } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import { OrgQueries } from "@pf/graphql-db-operations"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"

type OrgUnitDepthRow = {
  readonly id: string
  readonly parentOrgUnitId: string | null
  readonly orgUnitLevel: string
}

/**
 * Compute max depth per org unit level by walking parent links in memory.
 * Turso Local does not support recursive CTEs; org trees are small enough
 * for an application-side walk.
 *
 * Roots (parent null) have depth 1. Results are sorted by maxDepth ascending.
 * Visited-set prevents hangs on cyclic parent links (corrupt data).
 */
const computeOrgLevelsFromUnits = (
  units: ReadonlyArray<OrgUnitDepthRow>,
): Array<{ level: string; maxDepth: number }> => {
  const childrenByParentId = new Map<string, OrgUnitDepthRow[]>()
  const roots: OrgUnitDepthRow[] = []

  for (const unit of units) {
    if (unit.parentOrgUnitId === null) {
      roots.push(unit)
      continue
    }
    const siblings = childrenByParentId.get(unit.parentOrgUnitId)
    if (siblings === undefined) {
      childrenByParentId.set(unit.parentOrgUnitId, [unit])
    } else {
      siblings.push(unit)
    }
  }

  const maxDepthByLevel = new Map<string, number>()
  const visited = new Set<string>()
  const queue: Array<{ unit: OrgUnitDepthRow; depth: number }> = []

  for (const root of roots) {
    visited.add(root.id)
    queue.push({ unit: root, depth: 1 })
  }

  // Index cursor keeps the walk O(n); org trees stay small either way.
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]
    if (current === undefined) {
      break
    }
    const { unit, depth } = current
    const previousMax = maxDepthByLevel.get(unit.orgUnitLevel)
    if (previousMax === undefined || depth > previousMax) {
      maxDepthByLevel.set(unit.orgUnitLevel, depth)
    }
    for (const child of childrenByParentId.get(unit.id) ?? []) {
      if (visited.has(child.id)) {
        continue
      }
      visited.add(child.id)
      queue.push({ unit: child, depth: depth + 1 })
    }
  }

  return Array.from(maxDepthByLevel.entries())
    .map(([level, maxDepth]) => ({ level, maxDepth }))
    .sort((a, b) => a.maxDepth - b.maxDepth)
}

/**
 * Live implementation of OrgQueries service for SQLite.
 */
export const SqliteOrgQueriesLive = Layer.effect(
  OrgQueries,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle

    return {
      queryRoot: Effect.gen(function* () {
        const results = yield* db
          .select()
          .from(schema.orgUnit)
          .where(
            and(
              isNull(schema.orgUnit.parentOrgUnitId),
              not(schema.orgUnit._deleted),
            ),
          )
          .limit(1)

        return results[0] ?? null
      }),

      queryChildren: (parentId: string) =>
        db
          .select()
          .from(schema.orgUnit)
          .where(
            and(
              eq(schema.orgUnit.parentOrgUnitId, parentId),
              not(schema.orgUnit._deleted),
            ),
          ),

      queryProcesses: (orgUnitId: string) =>
        db
          .select()
          .from(schema.process)
          .where(
            and(
              eq(schema.process.orgUnitId, orgUnitId),
              eq(schema.process._deleted, false),
            ),
          ),

      queryRoles: (orgUnitId: string) =>
        db
          .select()
          .from(schema.role)
          .where(
            and(
              eq(schema.role.orgUnitId, orgUnitId),
              eq(schema.role._deleted, false),
            ),
          ),

      queryOrgLevels: Effect.gen(function* () {
        // Avoid WITH RECURSIVE: Turso Local does not support recursive CTEs.
        // Soft-deleted units are excluded, matching queryRoot/queryChildren.
        // (Issue #2247: SQLite path only; Postgres CTE twin may still see deleted rows.)
        const units = yield* db
          .select({
            id: schema.orgUnit.id,
            parentOrgUnitId: schema.orgUnit.parentOrgUnitId,
            orgUnitLevel: schema.orgUnit.orgUnitLevel,
          })
          .from(schema.orgUnit)
          .where(not(schema.orgUnit._deleted))

        return computeOrgLevelsFromUnits(units)
      }),
    }
  }),
)
