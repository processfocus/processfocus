export {
  AuthenticationConfig,
  type AuthenticationConfigProps,
  type IdentityProvidersConfig,
  type SecretClientsConfig,
  isAuthenticationConfig,
} from "../../auth-config/src/lib/authentication-config.js"
export {
  CustomEntitiesConfig,
  type CustomEntitiesConfigProps,
  isCustomEntitiesConfig,
} from "../../auth-config/src/lib/custom-entities-config.js"
export {
  PoliciesConfig,
  type PoliciesConfigProps,
  isPoliciesConfig,
} from "../../auth-config/src/lib/policies-config.js"
export {
  type AppleOAuthProviderConfig,
  AppleOAuthProviderConfigSchema,
  type CognitoOAuthProviderConfig,
  CognitoOAuthProviderConfigSchema,
  DEFAULT_OAUTH_PROVIDER_SCOPES,
  type GoogleOAuthProviderConfig,
  GoogleOAuthProviderConfigSchema,
  type KeycloakOAuthProviderConfig,
  KeycloakOAuthProviderConfigSchema,
  type MicrosoftOAuthProviderConfig,
  MicrosoftOAuthProviderConfigSchema,
  OAUTH_PROVIDER_NAMES,
  type OAuthProviderConfig,
  OAuthProviderConfigSchema,
  type OAuthProviderName,
  OAuthProviderNameSchema,
  type PasskeyProviderConfig,
  PasskeyProviderConfigSchema,
  type SecretClientConfig,
  SecretClientConfigSchema,
  type SlackOAuthProviderConfig,
  SlackOAuthProviderConfigSchema,
} from "../../auth-config/src/lib/provider-types.js"
