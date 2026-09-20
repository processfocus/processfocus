const dummyExistingUserRequiredPrefix =
  "Dummy login requires an existing user, but the given bypass user "
const dummyExistingUserRequiredSuffix =
  " does not exist in the database. Please set PF_BYPASS_AUTH to a valid user."

export const getLoginErrorForAuthCallback = (
  error: string | null,
): "auth_failed" | "not_authorized" =>
  error === "access_denied" ? "not_authorized" : "auth_failed"

export const getDummyBypassUserForAuthCallback = (
  error: string | null,
  errorDescription: string | null,
): string | null =>
  error === "access_denied" &&
  errorDescription?.startsWith(dummyExistingUserRequiredPrefix) &&
  errorDescription.endsWith(dummyExistingUserRequiredSuffix)
    ? // Extract only the structured email segment from the known auth-server copy.
      errorDescription.slice(
        dummyExistingUserRequiredPrefix.length,
        -dummyExistingUserRequiredSuffix.length,
      )
    : null

export const getDummyBypassUserMissingMessage = (email: string): string =>
  `${dummyExistingUserRequiredPrefix}${email}${dummyExistingUserRequiredSuffix}`
