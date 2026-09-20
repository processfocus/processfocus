import "@xyflow/react/dist/style.css"
import { Effect } from "effect"
import { OrgChartClient } from "./org-chart-client"
import { BasePage } from "@/lib/effect/runtime"
import { fetchOrgChartDataEffect } from "@/lib/graphql/org-chart-operations"
import { flattenOrgUnits } from "@/lib/org-chart-data"
import { getDepthConfig } from "@/lib/org-chart-depth-config"
import { layoutOrgChart } from "@/lib/org-chart-layout"

const OrgChartPage = Effect.fn("OrgChartPage")(function* () {
  // Fetch data with error handling - return empty state on error
  const data = yield* fetchOrgChartDataEffect().pipe(
    Effect.catchAll((error) => {
      // Log error for debugging
      console.error("Failed to fetch org chart data:", error.message)
      // Return empty data structure for graceful degradation
      return Effect.succeed({
        orgLevels: [],
        org: {
          id: "",
          name: "Organization",
          level: "organization",
          subunits: [],
        },
      })
    }),
  )

  // Handle empty data case
  if (data.orgLevels.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <section className="space-y-4 pb-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
            <h2 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">
              Organization Chart
            </h2>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              No organization data available. The chart will appear when data is
              loaded.
            </p>
          </div>
        </section>
      </div>
    )
  }

  // Create mapping from level name to depth (maxDepth)
  const levelToDepth = new Map(
    data.orgLevels.map((level) => [level.level, level.maxDepth]),
  )

  // Flatten nested structure to flat array with parentId
  // Type assertion is safe because the GraphQL type is structurally compatible with RecursiveOrgUnit
  const flatOrgUnits = flattenOrgUnits(
    data.org as Parameters<typeof flattenOrgUnits>[0],
  )

  // Layout the org chart
  const { nodes, edges } = layoutOrgChart(flatOrgUnits)

  // Enrich nodes with depth information from levelToDepth mapping
  const enrichedNodes = nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      depth: levelToDepth.get(node.data.level) ?? 1,
    },
  }))

  // Create legend items from actual org levels
  const legendItems = data.orgLevels
    .sort((a, b) => a.maxDepth - b.maxDepth)
    .map((level) => {
      const config = getDepthConfig(level.maxDepth)
      return {
        level: level.level,
        depth: level.maxDepth,
        color: config.bgColor,
        icon: config.icon,
      }
    })

  return (
    <div className="flex h-full flex-col">
      {/* Header Section */}
      <section className="space-y-4 pb-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <h2 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">
            Organization Chart
          </h2>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Visual representation of your organization structure. Use mouse
            wheel to zoom, drag to pan, and hover over units to see details.
          </p>

          {/* Legend */}
          <div className="mt-4 flex flex-wrap items-center gap-4">
            {legendItems.map((item) => (
              <div key={item.level} className="flex items-center gap-2">
                <div className={`h-3 w-3 rounded-full ${item.color}`} />
                <span className="text-sm text-slate-600 capitalize dark:text-slate-400">
                  {item.level}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Org Chart */}
      <div className="flex-1 rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
        <OrgChartClient nodes={enrichedNodes} edges={edges} />
      </div>
    </div>
  )
})

// Export using BasePage builder to provide AppLive layer
export default BasePage.build(OrgChartPage)
