import { Effect } from "effect"
import Link from "next/link"
import { listDelegations } from "@/app/(protected)/act-on-behalf/actions"
import { DelegationsClient } from "@/app/(protected)/act-on-behalf/delegations-client"
import { BasePage } from "@/lib/effect/runtime"

// The issuer authorizes this selected owner and each operation independently.
// Inspection permission never implies permission to issue or replace a secret.
export default BasePage.build(
  ({ params }: { params: Promise<{ userId: string }> }) =>
    Effect.gen(function* () {
      const { userId } = yield* Effect.promise(() => params)
      const result = yield* Effect.promise(() => listDelegations(userId))
      return (
        <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
          <Link
            className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
            href={`/settings/users/${encodeURIComponent(userId)}`}
          >
            Back to user
          </Link>
          <h1 className="text-2xl font-semibold">User tokens</h1>
          {result.kind !== "success" ? (
            <p role="alert">{result.message}</p>
          ) : (
            <DelegationsClient
              key={result.owner.userId}
              owner={result.owner}
              ownerUserId={userId}
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
