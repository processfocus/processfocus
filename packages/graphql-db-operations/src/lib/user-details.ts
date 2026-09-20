import { Context, Effect, FiberRef, Option, Schema } from "effect"

const DelegationAudit = Schema.Struct({
  version: Schema.Literal(1),
  ownerUserId: Schema.String,
  ownerEmail: Schema.String,
  delegationId: Schema.String,
  generationId: Schema.String,
  name: Schema.String,
})

export type DelegationAuditValue = typeof DelegationAudit.Type

const delegationAuditPrefix = "pf:delegation:"

/** Durable attribution, not a credential or authorization principal. */
export const encodeDelegationAudit = (actor: DelegationAuditValue): string =>
  delegationAuditPrefix + JSON.stringify(actor)

export const decodeDelegationAudit = (
  by: string,
): Option.Option<DelegationAuditValue> =>
  by.startsWith(delegationAuditPrefix)
    ? Schema.decodeUnknownOption(Schema.parseJson(DelegationAudit))(
        by.slice(delegationAuditPrefix.length),
      )
    : Option.none()

export const delegationAuditLabel = (by: string): string | undefined =>
  Option.match(decodeDelegationAudit(by), {
    onNone: () => undefined,
    onSome: (actor) => `${actor.ownerEmail} via ${actor.name}`,
  })

/**
 * User details value containing the user identifier for audit fields.
 * The "by" field is used to populate createdBy and updatedBy database fields.
 * The "id" field is the user's database ID.
 */
export interface UserDetailsValue {
  by: string
  id: string | null
}

/**
 * Service providing a FiberRef with user details for all operations within a request.
 * This ensures all database operations use the same user identifier for audit trails
 * (createdBy and updatedBy fields).
 *
 * The user details are set at the start of each GraphQL request based on JWT payload
 * (email with userId fallback, or "SYSTEM" if no authentication) and inherited
 * by all resolver effects running in child fibers.
 *
 * @effect-leakable-service
 */
export class UserDetails extends Context.Tag(
  "@pf/graphql-db-operations/UserDetails",
)<UserDetails, FiberRef.FiberRef<UserDetailsValue>>() {}

/**
 * Helper to get the current user details from the UserDetails FiberRef.
 *
 * @example
 * ```typescript
 * const userDetails = yield* getUserDetails()
 * // Insert with audit fields
 * yield* db.insert(table).values({
 *   ...data,
 *   createdBy: userDetails.by,
 *   updatedBy: userDetails.by,
 * })
 * ```
 */
export const getUserDetails = (): Effect.Effect<
  UserDetailsValue,
  never,
  UserDetails
> => Effect.flatMap(UserDetails, FiberRef.get)

/** Keep worker attribution local even when a caller runs jobs in one fiber. */
export const withUserDetailsScope = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | UserDetails> =>
  Effect.gen(function* () {
    const ref = yield* UserDetails
    const current = yield* FiberRef.get(ref)
    return yield* effect.pipe(Effect.locally(ref, current))
  })
