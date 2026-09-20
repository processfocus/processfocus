"use client"

import { Button } from "@pf/shadcn-components"

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
  apple: "Apple",
}

interface LoginButtonProps {
  provider: string
  redirect?: string | undefined
}

export function LoginButton({ provider, redirect }: LoginButtonProps) {
  const label = PROVIDER_LABELS[provider] ?? provider

  async function handleLogin() {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, redirect }),
    })
    const { url } = await response.json()
    window.location.href = url
  }

  return (
    <Button onClick={handleLogin} className="w-full">
      Sign in with {label}
    </Button>
  )
}
