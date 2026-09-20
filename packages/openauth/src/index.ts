export { authenticateClient } from "./endpoints/_internal/client-authentication"
export { generateTokens } from "./endpoints/_internal/token-generation"
export {
  type AllowCallbackInput,
  type AuthorizationState,
  type Issuer,
  type IssuerClient,
  type NormalizedClient,
  type OnRefreshScopeInput,
  type OnRefreshScopeResult,
  type OnSuccessResponder,
  ResolveIssuerClientsError,
  type TokenTtl,
  hashClientSecret,
  issuer,
  resolveIssuerClients,
} from "./issuer"
export { GoogleProvider } from "./provider/google"
export {
  type PasskeyAuthenticationProperties,
  type PasskeyConfig,
  type PasskeyCredential,
  type PasskeyExcludeCredential,
  type PasskeyProperties,
  PasskeyProvider,
  type PasskeyRegistrationProperties,
  PasskeyRegistrationResponseSchema,
  createPasskeyRegistrationOptions,
  verifyPasskeyRegistrationAttestation,
} from "./provider/passkey"
// Redirect URI helpers
export { isValidRedirectUri, normalizeRedirectUri } from "./redirect-uri"
export { getIssuerUrl } from "./request"
// Services
export {
  ClientRegistryError,
  ClientRegistryService,
  CookieAuthService,
  CookieAuthServiceLive,
  EncryptionService,
  EncryptionServiceLive,
  IssuerCallbacks,
  KeyManagementService,
  KeyManagementServiceLive,
  OnRefreshScopeError,
  ProviderRegistryService,
  SubjectsConfig,
  TokenTtlConfig,
  buildClientRegistry,
  defaultResolveSubject,
  defaultTokenTtl,
  makeClientRegistryService,
  makeIssuerCallbacks,
  makeProviderRegistryService,
  makeSubjectsConfig,
  makeTokenTtlConfig,
} from "./services"
// Storage
export {
  type DynamoStorageOptions,
  DynamoStorageServiceLive,
} from "./storage/dynamo"
export { MemoryStorageServiceLive } from "./storage/memory"
export { Storage, StorageError, StorageService } from "./storage/storage"
// Subject helpers
export { createSubjects } from "./subject"
// Test utilities
export {
  type CreateTestAppOptions,
  type TestApp,
  createTestApp,
} from "./test-utils"
