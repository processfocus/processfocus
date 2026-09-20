import type { SqlError } from "@effect/sql/SqlError"
import { Effect } from "effect"
import { SettingsQueries } from "./settings-queries"

export const PROVIDER_USER_NOT_FOUND_ERROR = "provider user not found" as const
export const ROLE_NOT_FOUND_ERROR = "role not found" as const

export const PROVIDER_USER_NOT_FOUND_GRAPHQL_ERROR =
  "PROVIDER_USER_NOT_FOUND" as const
export const ROLE_NOT_FOUND_GRAPHQL_ERROR = "ROLE_NOT_FOUND" as const

export type GrantRoleError =
  | typeof PROVIDER_USER_NOT_FOUND_ERROR
  | typeof ROLE_NOT_FOUND_ERROR

export type GrantRoleGraphqlError =
  | typeof PROVIDER_USER_NOT_FOUND_GRAPHQL_ERROR
  | typeof ROLE_NOT_FOUND_GRAPHQL_ERROR

export interface GrantRoleOutcome {
  readonly success: boolean
  readonly email: string
  readonly rolePath: string
  readonly alreadyHadRole: boolean
  readonly error: GrantRoleError | null
}

export interface GrantRoleGraphqlOutcome {
  readonly success: boolean
  readonly email: string
  readonly rolePath: string
  readonly alreadyHadRole: boolean
  readonly error: GrantRoleGraphqlError | null
}

const normalizeRolePath = (input: string): string =>
  input.startsWith("/") ? input : `/${input}`

const normalizeEmail = (input: string): string => input.trim().toLowerCase()

export const toGrantRoleGraphqlError = (
  error: GrantRoleError | null,
): GrantRoleGraphqlError | null => {
  if (error === PROVIDER_USER_NOT_FOUND_ERROR) {
    return PROVIDER_USER_NOT_FOUND_GRAPHQL_ERROR
  }

  if (error === ROLE_NOT_FOUND_ERROR) {
    return ROLE_NOT_FOUND_GRAPHQL_ERROR
  }

  return null
}

export const fromGrantRoleGraphqlError = (
  error: GrantRoleGraphqlError | null,
): GrantRoleError | null => {
  if (error === PROVIDER_USER_NOT_FOUND_GRAPHQL_ERROR) {
    return PROVIDER_USER_NOT_FOUND_ERROR
  }

  if (error === ROLE_NOT_FOUND_GRAPHQL_ERROR) {
    return ROLE_NOT_FOUND_ERROR
  }

  return null
}

export const toGrantRoleGraphqlOutcome = (
  outcome: GrantRoleOutcome,
): GrantRoleGraphqlOutcome => ({
  ...outcome,
  error: toGrantRoleGraphqlError(outcome.error),
})

export const fromGrantRoleGraphqlOutcome = (
  outcome: GrantRoleGraphqlOutcome,
): GrantRoleOutcome => ({
  ...outcome,
  error: fromGrantRoleGraphqlError(outcome.error),
})

export const grantRoleToProviderUser = (input: {
  readonly rolePath: string
  readonly email: string
  readonly grantedBy: string
}): Effect.Effect<GrantRoleOutcome, SqlError, SettingsQueries> =>
  Effect.gen(function* () {
    const queries = yield* SettingsQueries
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
