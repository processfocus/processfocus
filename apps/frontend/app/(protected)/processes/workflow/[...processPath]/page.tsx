import "@xyflow/react/dist/style.css"
import { NotFound } from "@mcrovero/effect-nextjs/Navigation"
import { Effect } from "effect"
import Link from "next/link"
import { ProcessDocumentation } from "./process-documentation"
import { WorkflowFlow } from "./workflow-flow"
import { BasePage } from "@/lib/effect/runtime"
import { fetchProcessWorkflowEffect } from "@/lib/graphql/workflow-operations"
import { getPhaseColors } from "@/lib/workflow/constants"
import { createInitialLayout } from "@/lib/workflow/layout"

const WorkflowPage = Effect.fn("WorkflowPage")(function* ({
  params,
}: {
  params: Promise<{ processPath: string[] }>
}) {
  const { processPath: pathSegments } = yield* Effect.promise(() => params)

  // Guard against asset-like requests accidentally hitting this catch-all route
  // (e.g. `/processes/workflow/hr/installHook.js.map`).
  if (pathSegments.some((segment) => segment.toLowerCase().endsWith(".map"))) {
    return yield* NotFound
  }

  // Reconstruct the full process path from URL segments with leading slash
  const processPath = `/${pathSegments.map(decodeURIComponent).join("/")}`

  // Fetch workflow data with error handling - return error state on failure
  const data = yield* fetchProcessWorkflowEffect(processPath).pipe(
    Effect.catchAll((error) => {
      console.error("Failed to fetch workflow data:", error.message)
      // Return empty/error state for graceful degradation
      return Effect.succeed({
        processWorkflow: null,
        error: error.message,
      })
    }),
  )

  // Handle error state
  if (!data.processWorkflow) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link
            href="/processes"
            className="text-sm font-medium text-blue-500 hover:text-blue-600"
          >
            &larr; Back to processes
          </Link>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">
            Workflow Not Found
          </h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Process path: {processPath}
          </p>
          <p className="mt-2 text-sm text-red-600">
            Unable to load workflow data
          </p>
        </div>
      </div>
    )
  }

  const workflowData = data.processWorkflow

  // Create initial layout - will be refined client-side after measurement
  const {
    nodes: initialNodes,
    edges,
    phases,
  } = createInitialLayout(workflowData)

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link
          href="/processes"
          className="text-sm font-medium text-blue-500 hover:text-blue-600"
        >
          &larr; Back to processes
        </Link>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">
            {workflowData.processName}
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {workflowData.processPurpose}
          </p>

          {phases.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-4">
              {phases.map((phase) => {
                const colors = getPhaseColors(phase.index)
                return (
                  <div
                    key={phase.id}
                    className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400"
                  >
                    <span
                      className="h-3 w-3 rounded-full"
                      style={{ backgroundColor: colors.accent }}
                    />
                    <span className="font-medium">{phase.name}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <WorkflowFlow
          initialWorkflowData={workflowData}
          initialNodes={initialNodes}
          edges={edges}
          processPath={processPath}
        />

        <ProcessDocumentation processPath={processPath} />
      </div>
    </div>
  )
})

export default BasePage.build(WorkflowPage)
