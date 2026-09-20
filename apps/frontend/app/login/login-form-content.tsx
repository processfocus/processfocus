import { LoginButton } from "./login-button"
import { PasskeyButton } from "./passkey-button"
import { SecretLoginForm } from "./secret-login-form"
import { getDummyBypassUserMissingMessage } from "@/lib/auth/callback-error"

const errorMessages: Record<string, { title: string; message: string }> = {
  not_authorized: {
    title: "Access Denied",
    message:
      "You don't have permission to access this application. Please contact your administrator to request access.",
  },
  auth_failed: {
    title: "Authentication Failed",
    message: "We couldn't verify your identity. Please try again.",
  },
  exchange_failed: {
    title: "Login Failed",
    message: "Something went wrong during login. Please try again.",
  },
  verification_failed: {
    title: "Session Error",
    message: "We couldn't verify your session. Please try again.",
  },
  invalid_state: {
    title: "Security Error",
    message: "Security validation failed. Please try again.",
  },
}

const emailLikePattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface LoginFormContentProps {
  hasPasskey: boolean
  oauthProviders: string[]
  passkeyOpenRegistration?: boolean
  secretLoginEnabled?: boolean
  searchParams: Pick<URLSearchParams, "get">
}

export function LoginFormContent({
  hasPasskey,
  oauthProviders,
  passkeyOpenRegistration = false,
  secretLoginEnabled = false,
  searchParams,
}: LoginFormContentProps) {
  const error = searchParams.get("error") ?? undefined
  const dummyBypassUser = searchParams.get("dummy_bypass_user")
  const redirectTo = searchParams.get("redirect") ?? undefined

  const errorInfo = error ? errorMessages[error] : null
  const validDummyBypassUser =
    dummyBypassUser && emailLikePattern.test(dummyBypassUser)
      ? dummyBypassUser
      : null
  const errorMessage =
    error === "not_authorized" && validDummyBypassUser
      ? getDummyBypassUserMissingMessage(validDummyBypassUser)
      : errorInfo?.message

  return (
    <>
      {errorInfo && (
        <div
          className="rounded-lg border border-red-200 bg-red-50 p-4"
          role="alert"
        >
          <div className="flex">
            <div className="shrink-0">
              <svg
                className="h-5 w-5 text-red-400"
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">
                {errorInfo.title}
              </h3>
              <p className="mt-1 text-sm text-red-700">{errorMessage}</p>
            </div>
          </div>
        </div>
      )}

      {hasPasskey && (
        <PasskeyButton
          redirect={redirectTo}
          openRegistration={passkeyOpenRegistration}
        />
      )}
      {hasPasskey && oauthProviders.length > 0 && (
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-border border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-background px-2 text-muted-foreground">
              Or continue with
            </span>
          </div>
        </div>
      )}
      {oauthProviders.map((provider) => (
        <LoginButton key={provider} provider={provider} redirect={redirectTo} />
      ))}
      <SecretLoginForm enabled={secretLoginEnabled} redirect={redirectTo} />
    </>
  )
}
