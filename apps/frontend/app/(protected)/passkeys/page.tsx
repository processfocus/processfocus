import { Effect } from "effect"
import { DateTimeDisplayProvider } from "@pf/shadcn-components/date-time-display"
import { listPasskeys } from "./actions"
import { PasskeysClient } from "./passkeys-client"
import { BasePage } from "@/lib/effect/runtime"

// The authenticated layout can omit this page while checking the session.
export const instant = false

const Passkeys = BasePage.build(() =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(() => listPasskeys())
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
        <div>
          <h1 className="text-2xl font-semibold">Passkeys</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Add, name, and remove the Passkeys that can sign in to this
            organisation, and see when each was last used.
          </p>
        </div>
        {result.kind !== "success" ? (
          <p role="alert">{result.message}</p>
        ) : (
          <DateTimeDisplayProvider initialNow={Date.now()}>
            <PasskeysClient
              key={result.account.userId}
              organisationName={result.organisation.name}
              account={result.account}
              initialCredentials={result.credentials}
            />
          </DateTimeDisplayProvider>
        )}
      </div>
    )
  }),
)

export default Passkeys
