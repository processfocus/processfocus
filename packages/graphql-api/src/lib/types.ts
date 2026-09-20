import type { DateTime, Tracer } from "effect"
import type { GraphQLSchema } from "graphql"
import type { createSchema } from "graphql-yoga"
import type { Session } from "@pf/auth-session"
import type { UserDetailsValue } from "@pf/graphql-db-operations"
import type { ResolverFn, Resolvers } from "@pf/graphql-schema"

export type YogaSchema = ReturnType<typeof createSchema<UserContext>>

export interface JWTPayload {
  mode: "access"
  type: "user" | "providerUser"
  properties: Session
  aud: string
  iss: string
  sub: string
  exp: number
  iat?: number | undefined
}

// biome-ignore lint/suspicious/noExplicitAny: legacy code
export type ServerContext = Record<string, any>

/**
 * The user context contains a lot of things, and there's no good definition.
 * With this interface we try to type what we use.
 */
export interface UserContext extends Record<string, unknown> {
  _effectParentSpan?: Tracer.Span
  _realtimeAbortSignal?: AbortSignal
  _requestTime: DateTime.Utc
  _userDetails: UserDetailsValue
  jwt: JWTPayload | undefined
  userId: string | undefined
}

// Effect-based resolver function: can return anything
export type EffectFieldResolver<
  TResult = unknown,
  TParent = Record<PropertyKey, never>,
  TContext = Record<PropertyKey, never>,
  // biome-ignore lint/suspicious/noExplicitAny: graphql resolver generic default
  TArgs = any,
> = ResolverFn<TResult, TParent, TContext, TArgs>

// Allow manually specified graphql schemas and resolvers, perhaps a
// bit too fancy for now. All resolvers are functions that return an Effect.
export type ResolverMap =
  | Resolvers
  | Record<string, Record<string, EffectFieldResolver>>

export interface SchemaDefinition {
  typeDefs?: string | GraphQLSchema
  resolvers?: ResolverMap
}

export interface MergedSchemaDefinition {
  typeDefs: import("graphql").DocumentNode
  resolvers: ResolverMap
}
