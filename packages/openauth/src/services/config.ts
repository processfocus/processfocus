/**
 * Configuration services for issuer settings.
 * These are simple context values without behavior.
 * @packageDocumentation
 */
import { Context, Layer } from "effect"
import type { TokenTtl } from "../endpoints/types"
import type { SubjectSchema } from "../subject"

/**
 * Token TTL configuration context.
 * Provides access to configured token lifetimes.
 */
export class TokenTtlConfig extends Context.Tag("@pf/openauth/TokenTtlConfig")<
  TokenTtlConfig,
  TokenTtl
>() {}

/**
 * Create a TokenTtlConfig layer with the given TTL values.
 */
export const makeTokenTtlConfig = (ttl: TokenTtl): Layer.Layer<TokenTtlConfig> =>
  Layer.succeed(TokenTtlConfig, ttl)

/**
 * Default token TTL values.
 */
export const defaultTokenTtl: TokenTtl = {
  access: 60 * 60, // 1 hour
  refresh: 60 * 60 * 24 * 365, // 1 year
  refreshReuse: 60, // 1 minute
  refreshRetention: 0,
}

/**
 * Subject schema configuration context.
 * Provides access to the configured subject types for token validation.
 */
export class SubjectsConfig extends Context.Tag("@pf/openauth/SubjectsConfig")<
  SubjectsConfig,
  SubjectSchema
>() {}

/**
 * Create a SubjectsConfig layer with the given subject schema.
 */
export const makeSubjectsConfig = (
  subjects: SubjectSchema,
): Layer.Layer<SubjectsConfig> => Layer.succeed(SubjectsConfig, subjects)
