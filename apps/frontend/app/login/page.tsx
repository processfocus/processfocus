import { connection } from "next/server"
import { type ComponentProps, Suspense } from "react"
import { LoginForm } from "./login-form"
import { getLoginAuthProviders } from "@/lib/auth/providers"
import { isSecretLoginEnabled } from "@/lib/auth/secret-login-presentation"
import { ensureCedarPolicies } from "@/lib/effect/services"
import { getPublicOrgIdentity } from "@/lib/org-identity"

export default async function LoginPage() {
  // Cached functions throw on error so transient failures aren't baked into
  // the cache. Catch here and degrade gracefully (generic text, no providers).
  const [, authProviders, orgIdentity] = await Promise.all([
    ensureCedarPolicies().catch(() => {}),
    getLoginAuthProviders().catch(() => ({
      providers: [] as string[],
      passkeyOpenRegistration: false,
    })),
    getPublicOrgIdentity().catch(() => null),
  ])

  const orgName = orgIdentity?.acronym ?? orgIdentity?.name
  const hasPasskey = authProviders.providers.includes("passkey")
  const oauthProviders = authProviders.providers.filter((p) => p !== "passkey")

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md space-y-8 px-4">
        <div className="text-center">
          <h1 className="text-3xl font-bold">Sign In</h1>
          <p className="mt-2 text-gray-600">
            {orgName
              ? `Sign in to access your ${orgName} workspace`
              : "Sign in to access your workspace"}
          </p>
        </div>
        <Suspense fallback={null}>
          <AvailableLoginForm
            hasPasskey={hasPasskey}
            oauthProviders={oauthProviders}
            passkeyOpenRegistration={authProviders.passkeyOpenRegistration}
          />
        </Suspense>
      </div>
    </div>
  )
}

async function AvailableLoginForm(props: ComponentProps<typeof LoginForm>) {
  await connection()
  const secretLoginEnabled = await isSecretLoginEnabled()
  return <LoginForm {...props} secretLoginEnabled={secretLoginEnabled} />
}
