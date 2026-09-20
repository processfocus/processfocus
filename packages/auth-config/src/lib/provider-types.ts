import { Schema } from "effect"

/**
 * Passkey (WebAuthn) provider configuration.
 */
export interface PasskeyProviderConfig {
  /**
   * The Relying Party name displayed to users during registration.
   * @example "Process Focus"
   */
  readonly rpName: string
  /**
   * The Relying Party ID (domain without protocol).
   * @example "localhost" or "example.com"
   */
  readonly rpID: string
  /**
   * The allowed origin(s) for WebAuthn requests.
   * @example "http://localhost:3000" or ["https://example.com", "https://app.example.com"]
   */
  readonly origin: string | readonly string[]
}

/**
 * Effect Schema for PasskeyProviderConfig validation.
 */
export const PasskeyProviderConfigSchema = Schema.Struct({
  rpName: Schema.String,
  rpID: Schema.String,
  origin: Schema.Union(Schema.String, Schema.Array(Schema.String)),
})

/**
 * Supported OAuth provider names.
 */
export const OAUTH_PROVIDER_NAMES = [
  "google",
  "github",
  "microsoft",
  "apple",
  "discord",
  "spotify",
  "slack",
  "linkedin",
  "twitch",
  "yahoo",
  "x",
  "keycloak",
  "cognito",
  "jumpcloud",
  "facebook",
] as const

export type OAuthProviderName = (typeof OAUTH_PROVIDER_NAMES)[number]

export const DEFAULT_OAUTH_PROVIDER_SCOPES: Record<
  OAuthProviderName,
  readonly string[]
> = {
  google: ["openid", "email", "profile"],
  github: ["read:user", "user:email"],
  microsoft: ["openid", "email", "profile"],
  apple: ["name", "email"],
  discord: ["identify", "email"],
  spotify: ["user-read-email"],
  slack: ["openid", "email", "profile"],
  linkedin: ["openid", "email", "profile"],
  twitch: ["openid", "user:read:email"],
  yahoo: ["openid", "email", "profile"],
  x: ["users.read", "tweet.read", "offline.access"],
  keycloak: ["openid", "email", "profile"],
  cognito: ["openid", "email", "profile"],
  jumpcloud: ["openid", "email", "profile"],
  facebook: ["email", "public_profile"],
}

/**
 * OAuth provider configuration matching OpenAuth's Oauth2WrappedConfig.
 */
export interface OAuthProviderConfig {
  readonly clientID: string
  readonly clientSecret: string
  readonly scopes: string[]
  readonly pkce?: boolean
  readonly query?: Record<string, string>
}

export interface AppleOAuthProviderConfig extends OAuthProviderConfig {
  readonly responseMode?: "query" | "form_post"
}

export interface MicrosoftOAuthProviderConfig extends OAuthProviderConfig {
  readonly tenant: string
}

export interface SlackOAuthProviderConfig extends OAuthProviderConfig {
  readonly team: string
}

export interface KeycloakOAuthProviderConfig extends OAuthProviderConfig {
  readonly baseUrl: string
  readonly realm: string
}

export interface CognitoOAuthProviderConfig extends OAuthProviderConfig {
  readonly domain: string
  readonly region: string
  /** Required for OIDC issuer and signing-key verification. */
  readonly userPoolId: string
}

/**
 * Effect Schema for OAuthProviderConfig validation.
 */
export const OAuthProviderConfigSchema = Schema.Struct({
  clientID: Schema.String,
  clientSecret: Schema.String,
  scopes: Schema.Array(Schema.String),
  pkce: Schema.optional(Schema.Boolean),
  query: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.String }),
  ),
})

export const AppleOAuthProviderConfigSchema = OAuthProviderConfigSchema.pipe(
  Schema.extend(
    Schema.Struct({
      responseMode: Schema.optional(Schema.Literal("query", "form_post")),
    }),
  ),
)

export const MicrosoftOAuthProviderConfigSchema =
  OAuthProviderConfigSchema.pipe(
    Schema.extend(Schema.Struct({ tenant: Schema.String })),
  )

export const SlackOAuthProviderConfigSchema = OAuthProviderConfigSchema.pipe(
  Schema.extend(Schema.Struct({ team: Schema.String })),
)

export const KeycloakOAuthProviderConfigSchema = OAuthProviderConfigSchema.pipe(
  Schema.extend(
    Schema.Struct({ baseUrl: Schema.String, realm: Schema.String }),
  ),
)

export const CognitoOAuthProviderConfigSchema = OAuthProviderConfigSchema.pipe(
  Schema.extend(
    Schema.Struct({
      domain: Schema.String,
      region: Schema.String,
      userPoolId: Schema.String,
    }),
  ),
)

/**
 * Effect Schema for OAuthProviderName validation.
 */
export const OAuthProviderNameSchema = Schema.Literal(...OAUTH_PROVIDER_NAMES)

/**
 * Google OAuth provider configuration extending the base OAuth config
 * with Google Workspace organizational unit (OU) invitation support.
 */
export interface GoogleOAuthProviderConfig extends OAuthProviderConfig {
  /**
   * Google Workspace organizational unit paths that are automatically invited.
   * Users authenticating via Google whose OU matches one of these paths
   * will be auto-assigned roles.
   * @example ["/Staff", "/Board members"]
   */
  readonly invitedOrgUnits?: string[]
  /**
   * When true, map the user's Google OU path to a role with the same path.
   * The org model must define roles whose paths mirror the Google OU structure.
   */
  readonly orgUnitAsRole?: boolean
  /**
   * Base64-encoded JSON service account key for Google Directory API access.
   * Required for OU lookups via domain-wide delegation.
   */
  readonly serviceAccountKey?: string
  /**
   * Workspace admin email for domain-wide delegation.
   * The service account impersonates this admin to call the Directory API.
   */
  readonly adminEmail?: string
}

/**
 * Effect Schema for GoogleOAuthProviderConfig validation.
 * Extends the base OAuthProviderConfigSchema with Google-specific fields.
 */
export const GoogleOAuthProviderConfigSchema = OAuthProviderConfigSchema.pipe(
  Schema.extend(
    Schema.Struct({
      invitedOrgUnits: Schema.optional(Schema.Array(Schema.String)),
      orgUnitAsRole: Schema.optional(Schema.Boolean),
      serviceAccountKey: Schema.optional(Schema.String),
      adminEmail: Schema.optional(Schema.String),
    }),
  ),
)

/**
 * Secret client configuration for M2M (machine-to-machine) authentication
 * via OAuth2 client_credentials grant.
 */
export interface SecretClientConfig {
  /**
   * The client secret for authentication.
   * This should be a secure, randomly generated string.
   */
  readonly secret: string
  /**
   * The audience claim for tokens issued to this client.
   * This identifies the intended recipient of the token (e.g., "ci" for CI/CD pipelines).
   * The GraphQL server must be configured to accept this audience.
   */
  readonly audience: string
}

/**
 * Effect Schema for SecretClientConfig validation.
 */
export const SecretClientConfigSchema = Schema.Struct({
  secret: Schema.String,
  audience: Schema.String,
})
