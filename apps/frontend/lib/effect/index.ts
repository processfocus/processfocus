/**
 * Effect runtime and utilities for the frontend application.
 *
 * This module provides the complete Effect integration for Next.js,
 * including runtime setup, services, and utilities.
 *
 * Note: Effect is used server-side only. Client components should not
 * import from this module.
 */

// Error boundaries
export { DefaultErrorFallback, EffectErrorBoundary } from "./error-boundary"
// Route parameter validation
export {
  ExecutionIdParams,
  FilterSearchParams,
  PaginationSearchParams,
  ProcessIdParams,
  ProcessPathParams,
  decodeParamsUnknown,
  decodeSearchParamsUnknown,
} from "./params"
// Runtime and page builders
export { AppLive, BaseLayout, BasePage } from "./runtime"
// Services
export {
  FormValidationService,
  FormValidationServiceLive,
  GraphQLService,
  GraphQLServiceLive,
} from "./services"
