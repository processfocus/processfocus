import { cookies, headers } from "next/headers"
import { type NextRequest, NextResponse } from "next/server"
import { getAuthClient } from "@/lib/auth/client"
import { clearSession, getCookieNamesFromHost } from "@/lib/auth/session"

const performLogout = async () => {
  const cookieStore = await cookies()
  const h = await headers()
  const { refreshToken: RT } = getCookieNamesFromHost(h.get("host") ?? "")
  const refreshToken = cookieStore.get(RT)?.value

  if (refreshToken) {
    const authClient = getAuthClient()
    await authClient.logout(refreshToken).catch((err) => {
      console.error("Failed to invalidate refresh token on server:", err)
    })
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
