/**
 * Services module - focused Effect services for the OpenAuth issuer.
 * @packageDocumentation
 */

// Callbacks
export {
  IssuerCallbacks,
  type IssuerCallbacksInterface,
  OnRefreshScopeError,
  defaultResolveSubject,
  makeIssuerCallbacks,
} from "./callbacks"
// Client registry
export {
  ClientRegistryError,
  ClientRegistryService,
  type ClientRegistryServiceInterface,
  buildClientRegistry,
  makeClientRegistryService,
} from "./client-registry"
// Configuration
export {
  SubjectsConfig,
  TokenTtlConfig,
  defaultTokenTtl,
  makeSubjectsConfig,
  makeTokenTtlConfig,
} from "./config"
// Cookie authentication
export {
  CookieAuthService,
  type CookieAuthServiceInterface,
  CookieAuthServiceLive,
} from "./cookie-auth"
// Encryption
export {
  DecryptionError,
  EncryptionService,
  type EncryptionServiceInterface,
  EncryptionServiceLive,
} from "./encryption"
// Key management
export {
  KeyManagementService,
  type KeyManagementServiceInterface,
  KeyManagementServiceLive,
} from "./key-management"
// Provider registry
export {
  ProviderRegistryService,
  type ProviderRegistryServiceInterface,
  makeProviderRegistryService,
} from "./provider-registry"
