import { Effect } from "effect"
import { listPasskeys } from "./actions"
import { PasskeysClient } from "./passkeys-client"
import { BasePage } from "@/lib/effect/runtime"

const Passkeys = BasePage.build(() =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(() => listPasskeys())
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
        <div>
          <h1 className="text-2xl font-semibold">Passkeys</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Add and name the Passkeys that can sign in to this organisation, and
            see when each was last used.
          </p>
        </div>
        {result.kind !== "success" ? (
          <p role="alert">{result.message}</p>
        ) : (
          <PasskeysClient
            key={result.account.userId}
            organisationName={result.organisation.name}
            account={result.account}
            initialCredentials={result.credentials}
          />
        )}
      </div>
    )
  }),
)

export default Passkeys
