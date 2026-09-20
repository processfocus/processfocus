import { NotFound } from "@mcrovero/effect-nextjs/Navigation"
import { Effect } from "effect"
import { Suspense } from "react"
import type { ProviderUserSession } from "@pf/auth-session"
import { AuthorizationAccess } from "../access-handbook"
import { AuthorizationLoading } from "../authorization-loading"
import { CedarSource } from "../cedar-source"
import { AuthorizationExplorer } from "../explorer"
import { loadAuthorizationCedar } from "../load-cedar"
import { loadHandbookData } from "../load-handbook"
import { getSessionWithToken } from "@/lib/auth/session"
import { parseAuthorizationTab } from "@/lib/authorization-tabs"
import { BasePageWithAuthorization } from "@/lib/effect/runtime"
import { checkFeaturePermissions } from "@/lib/effect/services"

type AuthorizationPageProps = {
  params: Promise<{ tab?: readonly string[] }>
}

const denied = (
  <div className="rounded-md border border-amber-200 bg-amber-50 p-6 text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
    <p className="font-medium">Authorisation is not available</p>
    <p className="mt-1 text-sm">
      You do not have permission to view authorisation.
    </p>
  </div>
)

const AuthorizationPageContent = Effect.fn("AuthorizationPageContent")(
  function* ({ params }: AuthorizationPageProps) {
    const sessionResult = yield* getSessionWithToken.pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    )
    if (!sessionResult || !("email" in sessionResult)) {
      return denied
    }

    const permissions = yield* checkFeaturePermissions(
      sessionResult as ProviderUserSession,
    )
    if (!permissions.viewAuthorization) {
      return denied
    }

    const { tab: segments } = yield* Effect.promise(() => params)
    if (segments && segments.length > 1) {
      return yield* NotFound
    }
    const tab = parseAuthorizationTab(segments?.[0])
    if (!tab) {
      return yield* NotFound
    }

    const cedar = yield* Effect.promise(() => loadAuthorizationCedar())
    const handbook =
      tab === "access"
        ? yield* Effect.promise(() => loadHandbookData(cedar))
        : null

    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {cedar.loadError ? (
          <p className="mb-4 shrink-0 text-sm text-rose-700">
            {cedar.loadError}
          </p>
        ) : null}
        {handbook ? <AuthorizationAccess handbook={handbook} /> : null}
        {tab === "explorer" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <AuthorizationExplorer cedar={cedar} />
          </div>
        ) : null}
        {tab === "policies" ? (
          <CedarSource
            source={cedar.policiesText}
            empty="No combined Cedar policies are available."
          />
        ) : null}
        {tab === "schema" ? (
          <CedarSource
            source={cedar.schemaText}
            empty="No combined Cedar schema is available."
          />
        ) : null}
      </div>
    )
  },
)

const AuthorizationContent = BasePageWithAuthorization.build(
  AuthorizationPageContent,
)

export default function AuthorizationPage(props: AuthorizationPageProps) {
  return (
    <Suspense fallback={<AuthorizationLoading />}>
      <AuthorizationContent {...props} />
    </Suspense>
  )
}
