import { createHash } from "node:crypto"

const trimDashes = (value: string) => value.replace(/^-+|-+$/g, "")
const sanitize = (value: string) =>
  trimDashes(
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-"),
  )

// Turso's create API rejects longer names, including seeded backup databases.
export const buildTursoDatabaseName = (
  activeDatabaseName: string,
  suffix: string,
  maxLength = 56,
): string => {
  const base = sanitize(activeDatabaseName) || "pf-db"
  const tail = sanitize(suffix) || "database"
  const preferredName = `${base}-${tail}`
  if (preferredName.length <= maxLength) return preferredName

  const hash = createHash("sha256")
    .update(preferredName)
    .digest("hex")
    .slice(0, 8)
  const truncatedSuffix =
    trimDashes(tail.slice(0, maxLength - hash.length - 3)) || "database"
  const maxBaseLength = maxLength - truncatedSuffix.length - hash.length - 2
  const truncatedBase =
    trimDashes(base.slice(0, Math.max(1, maxBaseLength))) || "pf"

  return `${truncatedBase}-${hash}-${truncatedSuffix}`
}

/** Match only generated recovery names owned by this environment, including shortened names. */
export const isTursoRecoveryDatabase = (
  activeName: string,
  name: string,
): boolean => {
  const suffix = name.match(
    /-((?:candidate|backup-before|upload)-(?:\d{8}t\d{6}(?:\d{3})?z|invalid-[a-f0-9]{8}))$/,
  )?.[1]
  return (
    suffix !== undefined &&
    (buildTursoDatabaseName(activeName, suffix) === name ||
      // Include artifacts generated before the create-API limit was corrected.
      buildTursoDatabaseName(activeName, suffix, 64) === name)
  )
}
