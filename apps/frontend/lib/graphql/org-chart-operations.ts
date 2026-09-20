import { Data, Effect } from "effect"
import { orgChartDataQuery } from "./org-chart-queries"
import { GraphQLService } from "@/lib/effect/services/graphql"
import type { OrgChartDataQuery } from "@/lib/generated/gql/graphql"

/**
 * Custom error type for org chart data fetching
 */
class OrgChartDataError extends Data.TaggedError("OrgChartDataError")<{
  readonly reason: "fetch_failed" | "missing_org" | "missing_levels"
  readonly message: string
}> {}

/**
 * Validated org chart data with guaranteed non-null org
 */
type ValidatedOrgChartData = Omit<OrgChartDataQuery, "org"> & {
  org: NonNullable<OrgChartDataQuery["org"]>
}

/**
 * Fetch org chart data using Effect and GraphQLService.
 * @returns Effect that yields validated org chart data or fails with OrgChartDataError
 */
export const fetchOrgChartDataEffect = () =>
  Effect.gen(function* () {
    const graphql = yield* GraphQLService

    // Fetch data via GraphQL service
    const data = yield* graphql
      .request<OrgChartDataQuery>(orgChartDataQuery)
      .pipe(
        Effect.mapError(
          (error) =>
            new OrgChartDataError({
              reason: "fetch_failed",
              message: error.message,
            }),
        ),
      )

    // Validate org exists
    if (!data.org) {
      yield* Effect.fail(
        new OrgChartDataError({
          reason: "missing_org",
          message: "No organization data available",
        }),
      )
    }

    // Validate orgLevels exist
    if (!data.orgLevels || data.orgLevels.length === 0) {
      yield* Effect.fail(
        new OrgChartDataError({
          reason: "missing_levels",
          message: "No organization levels available",
        }),
      )
    }

    return data as ValidatedOrgChartData
  })
