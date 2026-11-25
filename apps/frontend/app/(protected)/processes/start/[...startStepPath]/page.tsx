import { Effect } from "effect"
import StartProcessClient from "./client"
import ListPage from "@/app/(protected)/lists/[...listPath]/page"
import { parseListReturnDestination } from "@/app/(protected)/lists/lib/list-refresh"
import { NotFound } from "@/lib/effect/navigation"
import { BasePage } from "@/lib/effect/runtime"

export const instant = false

/**
 * Start process page - thin server wrapper that passes URL params to client.
 * Form metadata is fetched client-side via GraphQL.
 */
const StartProcessPage = Effect.fn("StartProcessPage")(function* ({
  params,
  searchParams,
}: {
  params: Promise<{ startStepPath: string[] }>
  searchParams: Promise<{ returnTo?: string | string[] }>
}) {
  const { startStepPath: pathSegments } = yield* Effect.promise(() => params)
  const { returnTo } = yield* Effect.promise(() => searchParams)

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

  // Relative List destinations are validated by the same parser as close/submit.
  // A hard navigation has no intercepted background: render the real List here.
  // Match the client's URLSearchParams.get() behavior for repeated parameters.
  const destination = parseListReturnDestination(
    (Array.isArray(returnTo) ? returnTo[0] : returnTo) ?? null,
    "http://localhost",
  )
  if (destination) {
    const listUrl = new URL(destination.href, "http://localhost")
    return (
      <ListPage
        params={Promise.resolve({
          listPath: destination.listPath.slice(1).split("/"),
        })}
        searchParams={Promise.resolve(Object.fromEntries(listUrl.searchParams))}
      />
    )
  }

  return <StartProcessClient startStepPath={startStepPath} />
})

export default BasePage.build(StartProcessPage)
