import "server-only"
import { getFrontendAuthClientConfig } from "./issuer"

export async function isSecretLoginEnabled(): Promise<boolean> {
  try {
    const { issuer, jwt } = getFrontendAuthClientConfig()
    const url = new URL(issuer)
    if (
      url.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      return false
    const response = await fetch(`${issuer}/oauth/delegation/availability`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return false
    const presentation: unknown = await response.json()
    return (
      typeof presentation === "object" &&
      presentation !== null &&
      "secretLoginEnabled" in presentation &&
      presentation.secretLoginEnabled === true
    )
  } catch {
    return false
  }
}
