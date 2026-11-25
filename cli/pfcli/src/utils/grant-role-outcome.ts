import {
  type GrantRoleOutcome,
  PROVIDER_USER_NOT_FOUND_ERROR,
  ROLE_NOT_FOUND_ERROR,
} from "@pf/identity-management"

export interface GrantRoleGraphqlOutcome {
  readonly success: boolean
  readonly email: string
  readonly rolePath: string
  readonly alreadyHadRole: boolean
  readonly error: "PROVIDER_USER_NOT_FOUND" | "ROLE_NOT_FOUND" | null
}

export const fromGrantRoleGraphqlOutcome = (
  outcome: GrantRoleGraphqlOutcome,
): GrantRoleOutcome => ({
  ...outcome,
  error:
    outcome.error === "PROVIDER_USER_NOT_FOUND"
      ? PROVIDER_USER_NOT_FOUND_ERROR
      : outcome.error === "ROLE_NOT_FOUND"
        ? ROLE_NOT_FOUND_ERROR
        : null,
})
