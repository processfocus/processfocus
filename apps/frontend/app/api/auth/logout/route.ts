import { cookies, headers } from "next/headers"
import { type NextRequest, NextResponse } from "next/server"
import { getIssuerUrl } from "@/lib/auth/client"
import { clearSession, getCookieNamesFromHost } from "@/lib/auth/session"

const performLogout = async () => {
  const cookieStore = await cookies()
  const h = await headers()
  const { refreshToken: RT } = getCookieNamesFromHost(h.get("host") ?? "")
  const refreshToken = cookieStore.get(RT)?.value

  if (refreshToken) {
    try {
      const response = await fetch(`${getIssuerUrl()}/oauth/logout`, {
        method: "POST",
        body: new URLSearchParams({ token: refreshToken }),
      })
      if (!response.ok) console.error("Server logout request failed")
    } catch {
      console.error("Server logout request failed")
    }
  }

  await clearSession()
}

export const POST = async () => {
  await performLogout()
  return NextResponse.json({ success: true })
}

export const GET = async (request: NextRequest) => {
  await performLogout()
  const url = new URL(request.url)
  return NextResponse.redirect(
    new URL("/login", `${url.protocol}//${url.host}`),
  )
}
