import { Construct, type IConstruct } from "constructs"
import type {
  AppleOAuthProviderConfig,
  CognitoOAuthProviderConfig,
  GoogleOAuthProviderConfig,
  KeycloakOAuthProviderConfig,
  MicrosoftOAuthProviderConfig,
  OAuthProviderConfig,
  OAuthProviderName,
  PasskeyProviderConfig,
  SecretClientConfig,
  SlackOAuthProviderConfig,
} from "./provider-types"

interface ProviderEntry {
  readonly name: OAuthProviderName
  readonly config: OAuthProviderConfig
}

interface SecretClientEntry {
  readonly clientId: string
  readonly secret: string
  readonly audience: string
}

/**
 * Identity-provider-specific configuration types.
 * Google accepts extended config with OU invitation fields.
 */
export type IdentityProvidersConfig = {
  [K in Exclude<
    OAuthProviderName,
    "apple" | "cognito" | "google" | "keycloak" | "microsoft" | "slack"
  >]?: OAuthProviderConfig
} & {
  apple?: AppleOAuthProviderConfig
  cognito?: CognitoOAuthProviderConfig
  google?: GoogleOAuthProviderConfig
  keycloak?: KeycloakOAuthProviderConfig
  microsoft?: MicrosoftOAuthProviderConfig
  slack?: SlackOAuthProviderConfig
}

/**
 * Configuration map for M2M (machine-to-machine) secret clients.
 * Keys are client IDs, values are their configurations.
 */
export type SecretClientsConfig = Record<string, SecretClientConfig>

export interface AuthenticationConfigProps {
  /**
   * Show **Log in with a secret** on the anonymous login page.
   *
   * The login page has no identified principal whose Cedar token-management
   * permissions it can evaluate, so this is a presentation choice only. Cedar
   * independently authorizes token listing, issuance, management, redemption,
   * and delegated work. Hiding the control does not disable authentication or
   * revoke an existing credential.
   *
   * @default false
   */
  delegatedAccess?: boolean
  /**
   * Whether new human users must be invited before they can register.
   * When true, login is invite-only unless provider-specific config treats the
   * user as implicitly invited.
   *
   * @default true
   */
  inviteOnly?: boolean
  /**
   * Identity provider configurations.
   * Keys are provider names, values are their OAuth configs.
   *
   * @example
   * ```typescript
   * {
   *   google: {
   *     clientID: process.env.GOOGLE_CLIENT_ID ?? "",
   *     clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
   *     scopes: ["openid", "email", "profile"],
   *   },
   *   github: {
   *     clientID: process.env.GITHUB_CLIENT_ID ?? "",
   *     clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
   *     scopes: ["user:email"],
   *   }
   * }
   * ```
   */
  identityProviders?: IdentityProvidersConfig
  /**
   * Passkey (WebAuthn) provider configuration.
   * If provided, enables passkey authentication.
   *
   * @example
   * ```typescript
   * {
   *   rpName: "My App",
   *   rpID: "example.com",
   *   origin: "https://example.com"
   * }
   * ```
   */
  passkey?: PasskeyProviderConfig
  /**
   * M2M (machine-to-machine) secret client configurations.
   * Keys are client IDs, values contain the client secret.
   *
   * These clients can authenticate via OAuth2 client_credentials grant.
   *
   * @example
   * ```typescript
   * {
   *   "ci-pipeline": {
   *     secret: process.env.CI_CLIENT_SECRET ?? "",
   *   },
   * }
   * ```
   */
  secretClients?: SecretClientsConfig
}

/**
 * Configuration for OAuth authentication providers.
 *
 * @example
 * ```typescript
 * const authConfig = new AuthenticationConfig(org, "auth", {
 *   identityProviders: {
 *     google: {
 *       clientID: process.env.GOOGLE_CLIENT_ID ?? "",
 *       clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
 *       scopes: ["openid", "email", "profile"],
 *     }
 *   }
 * })
 * ```
 */
export class AuthenticationConfig extends Construct {
  readonly isAuthenticationConfig: true = true
  private readonly _inviteOnly: boolean
  readonly delegatedAccess: boolean
  private readonly _identityProviders: ProviderEntry[] = []
  private readonly _passkey: PasskeyProviderConfig | undefined
  private readonly _secretClients: SecretClientEntry[] = []

  constructor(
    scope: IConstruct,
    id: string,
    props?: AuthenticationConfigProps,
  ) {
    super(scope, id)

    this._inviteOnly = props?.inviteOnly ?? true
    this.delegatedAccess = props?.delegatedAccess ?? false

    if (props?.identityProviders) {
      for (const [name, config] of Object.entries(props.identityProviders)) {
        if (config) {
          this._identityProviders.push({
            name: name as OAuthProviderName,
            config,
          })
        }
      }
    }

    this._passkey = props?.passkey

    if (props?.secretClients) {
      for (const [clientId, config] of Object.entries(props.secretClients)) {
        if (config) {
          this._secretClients.push({
            clientId,
            secret: config.secret,
            audience: config.audience,
          })
        }
      }
    }
  }

  /**
   * Get all configured identity providers as a readonly array.
   */
  get identityProviders(): readonly ProviderEntry[] {
    return this._identityProviders
  }

  /**
   * Whether authentication defaults to invite-only.
   */
  get inviteOnly(): boolean {
    return this._inviteOnly
  }

  /**
   * Get the passkey configuration, if enabled.
   */
  get passkey(): PasskeyProviderConfig | undefined {
    return this._passkey
  }

  /**
   * Get all configured M2M secret clients as a readonly array.
   */
  get secretClients(): readonly SecretClientEntry[] {
    return this._secretClients
  }
}

export const isAuthenticationConfig = (
  value: unknown,
): value is AuthenticationConfig =>
  typeof value === "object" &&
  value !== null &&
  "isAuthenticationConfig" in value &&
  value.isAuthenticationConfig === true
