import { NotFound } from "@mcrovero/effect-nextjs/Navigation"
import { Effect } from "effect"
import CompleteTodoModalClient from "./client"
import { BasePage } from "@/lib/effect/runtime"

/**
 * Complete todo modal - thin server wrapper that passes URL params to client.
 * Form metadata is fetched client-side via GraphQL.
 */
const CompleteTodoModal = Effect.fn("CompleteTodoModal")(function* ({
  params,
  searchParams,
}: {
  params: Promise<{ stepPath: string[] }>
  searchParams: Promise<{ todoId?: string }>
}) {
  const { stepPath: pathSegments } = yield* Effect.promise(() => params)
  const { todoId } = yield* Effect.promise(() => searchParams)

  // Guard against asset-like requests accidentally hitting this catch-all route
  // (e.g. `/to-dos/complete/hr/installHook.js.map`).
  if (pathSegments.some((segment) => segment.toLowerCase().endsWith(".map"))) {
    return yield* NotFound
  }

  if (pathSegments.length === 0) {
    return yield* NotFound
  }

  // Reconstruct the full step path from URL segments with leading slash
  // URL: /to-dos/complete/engineering/bug-report-fix/Review bug
  // pathSegments = ["engineering", "bug-report-fix", "Review bug"]
  // Full path for lookup: "/engineering/bug-report-fix/Review bug"
  const stepPath = `/${pathSegments.map(decodeURIComponent).join("/")}`

  // Extract step name from path (last segment, decode it)
  const stepName = decodeURIComponent(
    pathSegments[pathSegments.length - 1] ?? "",
  )

  return (
    <CompleteTodoModalClient
      todoId={todoId}
      stepPath={stepPath}
      stepName={stepName}
    />
  )
})

export default BasePage.build(CompleteTodoModal)
