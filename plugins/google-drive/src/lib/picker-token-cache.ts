const EXPIRY_BUFFER_MS = 60_000

interface CachedPickerToken {
  readonly token: string
  readonly expiresAt: number
}

interface GetCachedPickerTokenInput {
  readonly clientId: string
  readonly now?: number
}

interface SetCachedPickerTokenInput {
  readonly clientId: string
  readonly token: string
  readonly expiresInSeconds: number
  readonly now?: number
}

// Module memory lets remounted picker fields share authorization without
// placing bearer tokens in browser storage or process state.
const pickerTokens = new Map<string, CachedPickerToken>()

export function getCachedPickerToken({
  clientId,
  now = Date.now(),
}: GetCachedPickerTokenInput): string | null {
  const cached = pickerTokens.get(clientId)
  if (!cached) return null
  if (now >= cached.expiresAt - EXPIRY_BUFFER_MS) {
    pickerTokens.delete(clientId)
    return null
  }
  return cached.token
}

export function setCachedPickerToken({
  clientId,
  token,
  expiresInSeconds,
  now = Date.now(),
}: SetCachedPickerTokenInput): void {
  pickerTokens.set(clientId, {
    token,
    expiresAt: now + expiresInSeconds * 1_000,
  })
}

/** Remove all in-memory picker tokens during plugin cleanup or logout. */
export function clearPickerTokenCache(): void {
  pickerTokens.clear()
}
