"use client"

import { useSearchParams } from "next/navigation"
import { LoginFormContent } from "./login-form-content"

interface LoginFormProps {
  hasPasskey: boolean
  oauthProviders: string[]
  passkeyOpenRegistration?: boolean
  secretLoginEnabled?: boolean
}

export function LoginForm({
  hasPasskey,
  oauthProviders,
  passkeyOpenRegistration = false,
  secretLoginEnabled = false,
}: LoginFormProps) {
  const searchParams = useSearchParams()

  return (
    <LoginFormContent
      hasPasskey={hasPasskey}
      oauthProviders={oauthProviders}
      passkeyOpenRegistration={passkeyOpenRegistration}
      secretLoginEnabled={secretLoginEnabled}
      searchParams={searchParams}
    />
  )
}
