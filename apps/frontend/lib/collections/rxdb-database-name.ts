/** Stable, collision-free encoding of the token's authorization scope. */
export const getRxDbDatabaseName = ({
  orgId,
  userId,
  roles,
}: {
  readonly orgId: string
  readonly userId: string
  readonly roles: readonly string[] | undefined
}): string => {
  const scope = JSON.stringify([userId, [...new Set(roles ?? [])].sort()])
  const fingerprint = Array.from(new TextEncoder().encode(scope), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
  return `pf-${orgId}-session-v1-${fingerprint}`
}

export const getLegacyRxDbDatabaseName = (orgId: string): string =>
  `pf-${orgId}`
