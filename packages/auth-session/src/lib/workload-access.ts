/** Access-only conversion. A failed workload exchange never falls back to a secret. */
export async function exchangeWorkloadAccess(input: {
  readonly endpoint: string
  readonly accessToken: string
  readonly scope: string
}): Promise<
  | { readonly err: true }
  | {
      readonly err: false
      readonly tokens: {
        readonly access: string
        readonly expiresIn: number
        readonly refresh?: never
        readonly refreshExpiresIn?: never
      }
    }
> {
  const response = await fetch(input.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token: input.accessToken,
      scope: input.scope,
    }),
    cache: "no-store",
    redirect: "error",
  })
  if (!response.ok) return { err: true }
  const body: unknown = await response.json()
  if (
    typeof body !== "object" ||
    body === null ||
    !("access_token" in body) ||
    typeof body.access_token !== "string" ||
    !("expires_in" in body) ||
    typeof body.expires_in !== "number" ||
    !Number.isFinite(body.expires_in) ||
    body.expires_in <= 0 ||
    "refresh_token" in body
  )
    return { err: true }
  return {
    err: false,
    tokens: { access: body.access_token, expiresIn: body.expires_in },
  }
}
