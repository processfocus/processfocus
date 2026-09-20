import { and, eq, isNull, not, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-postgres"
import { OrgQueries } from "@pf/graphql-db-operations"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"

/**
 * Live implementation of OrgQueries service for Postgres.
 */
export const PostgresOrgQueriesLive = Layer.effect(
  OrgQueries,
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle
    const execute = <T extends Record<string, unknown>>(
      query: Parameters<typeof db.execute>[0],
    ) => Effect.promise(() => Promise.resolve(db.execute<T>(query)))

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
        type Row = { level: string; maxdepth: number }
        type Result = { rowCount: number; rows: Row[] }
        const result = yield* execute<Result>(sql`
          WITH RECURSIVE org_hierarchy(id, org_unit_level, depth) AS (
            SELECT id, org_unit_level, 1 as depth
            FROM pf_org_unit
            WHERE parent_org_unit IS NULL
            UNION ALL
            SELECT ou.id, ou.org_unit_level, oh.depth + 1
            FROM pf_org_unit ou
            INNER JOIN org_hierarchy oh ON ou.parent_org_unit = oh.id
          )
          SELECT org_unit_level AS level, MAX(depth) AS maxdepth
          FROM org_hierarchy
          GROUP BY org_unit_level
          ORDER BY maxdepth
        `)

        const rows = result[0] ? result[0].rows : []

        return rows.map((row) => ({
          level: row.level,
          maxDepth: row.maxdepth,
        }))
      }),
    }
  }),
)
