import { Effect } from "effect"
import { redirect } from "next/navigation"
import { listDelegations } from "./actions"
import { DelegationsClient } from "./delegations-client"
import { BasePage } from "@/lib/effect/runtime"

const PersonalTokens = BasePage.build(() =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(() => listDelegations())
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
        <div>
          <h1 className="text-2xl font-semibold">Act on behalf tokens</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Create and manage tokens for tools that act on your behalf.
          </p>
        </div>
        {result.kind !== "success" ? (
          <p role="alert">{result.message}</p>
        ) : (
          <DelegationsClient
            key={result.owner.userId}
            owner={result.owner}
            initialCanIssue={result.canIssue}
            initialIssuanceDeadline={result.issuanceDeadline}
            initialNow={Date.now()}
            initialDelegations={result.delegations}
          />
        )}
      </div>
    )
  }),
)

export default async function MyTokensPage({
  searchParams,
}: {
  searchParams: Promise<{ ownerUserId?: string | string[] }>
}) {
  const query = await searchParams
  const ownerUserId =
    typeof query.ownerUserId === "string" ? query.ownerUserId.trim() : ""
  if (ownerUserId)
    redirect(`/settings/users/${encodeURIComponent(ownerUserId)}/tokens`)
  return <PersonalTokens />
}
