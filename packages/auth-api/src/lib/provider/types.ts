import type {
  ProviderUserSession,
  ServiceAccountSession,
} from "@pf/auth-session"

/**
 * Subject data for provider user tokens
 */
interface ProviderUserSubjectData {
  readonly type: "providerUser"
  readonly properties: ProviderUserSession
}

/**
 * Subject data for service-account (M2M) tokens
 */
interface ServiceAccountSubjectData {
  readonly type: "user"
  readonly properties: ServiceAccountSession
}

/**
 * Result type returned by success handlers.
 * Either subject data to be passed to ctx.subject(), or a Response (for errors).
 */
export type SuccessResult =
  | ProviderUserSubjectData
  | ServiceAccountSubjectData
  | Response

export const optionalProviderUserPicture = (
  picture: string | null | undefined,
) => (picture && picture.length > 0 ? picture : undefined)
