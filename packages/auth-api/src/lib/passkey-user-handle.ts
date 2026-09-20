import type { ProviderUserRecord } from "./authentication-database.js"

/** Preserve native passkey identities; additional credentials use the existing backing User ID. */
export const getPasskeyUserHandle = (
  identity: Pick<ProviderUserRecord, "provider" | "sub"> & {
    readonly userId: ProviderUserRecord["id"]
  },
): string =>
  identity.provider === "passkey"
    ? identity.sub
    : Buffer.from(identity.userId).toString("base64url")
