import { workloadAuditLabel } from "@pf/auth-session"
import { delegationAuditLabel } from "@pf/graphql-db-operations"

/** Presentation only: never feed this label back into authentication or audit writes. */
export function attributedActorDisplayLabel(value: string): string | undefined {
  return (
    workloadAuditLabel(value) ??
    (value.startsWith("pf:delegation:")
      ? (delegationAuditLabel(value) ?? "")
      : undefined)
  )
}

export function actorDisplayLabel(value: string): string {
  return attributedActorDisplayLabel(value) ?? value
}

// Known attribution fields in List projections. The encoded prefix alone cannot
// identify an actor: ordinary editable business text may contain it too.
const listActorFields = new Set([
  "actor",
  "createdBy",
  "updatedBy",
  "changedBy",
  "signedInBy",
  "signedOutBy",
])

export function listFieldDisplayLabel(field: string, value: string): string {
  return listActorFields.has(field) ? actorDisplayLabel(value) : value
}

/** List projections include authored actor fields and nested history tables. */
export function presentListActors(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(presentListActors)
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        typeof child === "string"
          ? listFieldDisplayLabel(key, child)
          : presentListActors(child),
      ]),
    )
  }
  return value
}
