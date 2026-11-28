import { Effect } from "effect"
import type { Metadata } from "next"
import { refresh } from "next/cache"
import { headers } from "next/headers"
import { DisconnectForm } from "./disconnect-form"
import { getSessionWithTokenAndExpiry } from "@/lib/auth/session"
import { BasePage } from "@/lib/effect/runtime"
import { disconnectConnection, listConnections } from "@/lib/mcp/oauth"
import { mcpOriginForHost } from "@/lib/mcp/origin"

export const metadata: Metadata = { title: "Connected apps" }
export const instant = false

async function connectionAccount(requestHeaders: Headers) {
  const origin = mcpOriginForHost(requestHeaders.get("host"))
  if (!origin) return null
  const session = await getSessionWithTokenAndExpiry()
  if (
    !session ||
    !("email" in session) ||
    !session.humanSession ||
    session.delegation
  )
    return null
  return { origin, userId: session.userId, email: session.email }
}

async function disconnect(_previous: string | null, form: FormData) {
  "use server"
  const requestHeaders = await headers()
  const account = await connectionAccount(requestHeaders)
  const clientId = form.get("client")
  const grantId = form.get("grant")
  const disconnected =
    account &&
    requestHeaders.get("origin") === account.origin &&
    typeof clientId === "string" &&
    typeof grantId === "string" &&
    (await disconnectConnection({ ...account, clientId, grantId }))

  if (!disconnected) return "Unable to disconnect the app. Try again."
  // An action redirect renders through the internal host, which has a different
  // MCP grant partition. Refresh the current page on its existing origin.
  refresh()
  return null
}

export default BasePage.build(() =>
  Effect.promise(async () => {
    const account = await connectionAccount(await headers())
    const connections = account
      ? await listConnections(account.origin, account.userId)
      : []
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
        <div>
          <h1 className="text-2xl font-semibold">Connected apps</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Manage the MCP apps you’ve authorised for this environment.
          </p>
        </div>
        {account ? (
          <>
            <div className="space-y-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">
              <p>Environment: {account.origin}</p>
              <p>Signed in as {account.email}</p>
            </div>
            {connections.length > 0 ? (
              <ul className="divide-y rounded-lg border">
                {connections.map(
                  ({ id, clientId, name, access, authorisedAt }) => (
                    <li key={id} className="p-4">
                      <DisconnectForm
                        action={disconnect}
                        name={name}
                        access={access}
                        authorisedAt={authorisedAt}
                        clientId={clientId}
                        grantId={id}
                      />
                    </li>
                  ),
                )}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No connected apps.
              </p>
            )}
          </>
        ) : (
          <p role="alert">MCP connections are unavailable for this session.</p>
        )}
      </div>
    )
  }),
)
