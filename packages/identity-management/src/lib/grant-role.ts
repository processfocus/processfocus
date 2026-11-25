import { Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import type { RoleManagementPersistence } from "./persistence"

export const PROVIDER_USER_NOT_FOUND_ERROR = "provider user not found" as const
export const ROLE_NOT_FOUND_ERROR = "role not found" as const

export type GrantRoleError =
  | typeof PROVIDER_USER_NOT_FOUND_ERROR
  | typeof ROLE_NOT_FOUND_ERROR

export interface GrantRoleOutcome {
  readonly success: boolean
  readonly email: string
  readonly rolePath: string
  readonly alreadyHadRole: boolean
  readonly error: GrantRoleError | null
}

const normalizeRolePath = (input: string): string =>
  input.startsWith("/") ? input : `/${input}`

const normalizeEmail = (input: string): string => input.trim().toLowerCase()

export const grantRoleToProviderUser = (
  queries: RoleManagementPersistence,
  input: {
    readonly rolePath: string
    readonly email: string
    readonly grantedBy: string
  },
): Effect.Effect<GrantRoleOutcome, SqlError> =>
  Effect.gen(function* () {
    const email = normalizeEmail(input.email)
    const rolePath = normalizeRolePath(input.rolePath)

    const providerUser = yield* queries.queryProviderUserByEmail(email)
    if (!providerUser) {
      return {
        success: false,
        email,
        rolePath,
        alreadyHadRole: false,
        error: PROVIDER_USER_NOT_FOUND_ERROR,
      } satisfies GrantRoleOutcome
    }

    const role = yield* queries.queryRoleByPath(rolePath)
    if (!role) {
      return {
        success: false,
        email,
        rolePath,
        alreadyHadRole: false,
        error: ROLE_NOT_FOUND_ERROR,
      } satisfies GrantRoleOutcome
    }

    const grantResult = yield* queries.grantProviderUserRole(
      providerUser.id,
      role.id,
      input.grantedBy,
    )

    return {
      success: true,
      email,
      rolePath,
      alreadyHadRole: grantResult.alreadyHadRole,
      error: null,
    } satisfies GrantRoleOutcome
  })
