import { Effect } from "effect"
import StartProcessModalClient from "./client"
import { NotFound } from "@/lib/effect/navigation"
import { BasePage } from "@/lib/effect/runtime"

export const instant = false

/**
 * Start process modal - thin server wrapper that passes URL params to client.
 * Form metadata is fetched client-side via GraphQL.
 */
const StartProcessModal = Effect.fn("StartProcessModal")(function* ({
  params,
}: {
  params: Promise<{ startStepPath: string[] }>
}) {
  const { startStepPath: pathSegments } = yield* Effect.promise(() => params)

  // Guard against asset-like requests accidentally hitting this catch-all route
  // (e.g. `/processes/start/hr/installHook.js.map`).
  if (pathSegments.some((segment) => segment.toLowerCase().endsWith(".map"))) {
    return yield* NotFound
  }

  if (pathSegments.length === 0) {
    return yield* NotFound
  }

  // Reconstruct the full step path from URL segments with leading slash
  // URL: /processes/start/engineering/bug-report-fix/Report bug
  // pathSegments = ["engineering", "bug-report-fix", "Report bug"]
  // Full path for lookup: "/engineering/bug-report-fix/Report bug"
  const startStepPath = `/${pathSegments.map(decodeURIComponent).join("/")}`

  return <StartProcessModalClient startStepPath={startStepPath} />
})

export default BasePage.build(StartProcessModal)
