import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import {
  CedarPoliciesProvider,
  OrgCedarPoliciesProvider,
} from "@pf/auth-config"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfigHotReload,
  LocalCedarConfigStatic,
} from "@pf/auth-local-cedar"
import { OrganisationProviderFromEnv } from "@pf/process"

// Auth must not boot with an empty organisation when policy loading fails.
export const AuthenticationAuthorizationLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const { policyPaths, schemaPaths } = yield* CedarPoliciesProvider
    const config =
      policyPaths.length > 0
        ? LocalCedarConfigHotReload("/", policyPaths, schemaPaths)
        : LocalCedarConfigStatic(undefined, schemaPaths)
    return LocalCedarAuthorizationLive.pipe(Layer.provide(config))
  }),
).pipe(
  Layer.provide(
    OrgCedarPoliciesProvider.pipe(
      Layer.provide(OrganisationProviderFromEnv),
      Layer.provide(NodeFileSystem.layer),
    ),
  ),
)
