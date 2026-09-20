import { headers } from "next/headers"
import { RegisterPasskeyClient } from "./register-passkey-client"
import { getCookieNamesFromHost } from "@/lib/auth/session"

/**
 * Public Invitation Registration page.
 *
 * The Registration Link token is carried only in the URI fragment and is
 * scrubbed client-side before analytics or third-party code can observe it.
 * Server-rendered HTML contains no bearer secrets.
 *
 * Dynamic via `headers()` (Cache Components / Next.js 16). Do not use
 * `export const dynamic = "force-dynamic"` — it is incompatible with
 * `nextConfig.cacheComponents`.
 */
export default async function RegisterPasskeyPage() {
  const h = await headers()
  const host = h.get("host") ?? ""
  const cookieHeader = h.get("cookie") ?? ""
  const { accessToken: AT } = getCookieNamesFromHost(host)

  // Align with API routes: only a non-empty access-token value counts.
  const isSignedIn = cookieHeader.split(";").some((part) => {
    const trimmed = part.trim()
    if (!trimmed.startsWith(`${AT}=`)) return false
    return trimmed.slice(AT.length + 1).length > 0
  })

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md space-y-8 px-4">
        <RegisterPasskeyClient isSignedIn={isSignedIn} />
      </div>
    </div>
  )
}
