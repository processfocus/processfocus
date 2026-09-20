import type {
  CedarValueJson,
  EntityJson,
  StatefulAuthorizationCall,
} from "@cedar-policy/cedar-wasm/nodejs"
import {
  preparsePolicySet,
  preparseSchema,
  statefulIsAuthorized,
} from "@cedar-policy/cedar-wasm/nodejs"
import {
  DateTime,
  Effect,
  Either,
  Equal,
  Layer,
  Option,
  Ref,
  Stream,
} from "effect"
import {
  AuthorizationError,
  AuthorizationService,
  type ExecutionResource,
  type FileResource,
  type FormFieldResource,
  type GraphQLFieldResource,
  type ListResource,
  PolicyParseError,
  type PublicLinkPrincipalType,
  type Resource,
  type RoleEntity,
  type RoleResource,
  SchemaParseError,
  type ServiceAccountPrincipalType,
  type StepResource,
  type TodoResource,
  type UserPrincipal,
} from "@pf/auth-policy"
import { getRequestTime } from "@pf/request-time"
import { CedarReloadNotifierService } from "./cedar-reload-notifier"
import { LocalCedarConfig } from "./config-base"
import { PolicyWatcherService } from "./policy-watcher"

/**
 * Cedar context type for authorization requests.
 * Uses CedarValueJson for proper Cedar extension type handling.
 */
type CedarContext = Record<string, CedarValueJson>

/**
 * Get the system's current timezone (cached at module load).
 */
const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone

/**
 * Format a zoned datetime as ISO 8601 with 'Z' suffix (fake UTC).
 * Cedar doesn't support timezone offsets, so we format local time values
 * as if they were UTC. This allows policies to check local business hours
 * using: context.requestTime.toTime() >= duration("9h")
 */
const formatLocalTimeAsUtc = (zoned: DateTime.Zoned): string => {
  const parts = DateTime.toParts(zoned)
  const pad2 = (n: number) => String(n).padStart(2, "0")
  const pad3 = (n: number) => String(n).padStart(3, "0")
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hours)}:${pad2(parts.minutes)}:${pad2(parts.seconds)}.${pad3(parts.millis)}Z`
}

/**
 * Per-layer cache for Cedar context (avoids recomputation within the same request time).
 */
type RequestContextCache = {
  readonly requestTime: DateTime.Utc | null
  readonly context: CedarContext | null
}

/**
 * Build the Cedar request context from the current request time and environment.
 * The requestTime is converted to local timezone and formatted for Cedar's datetime extension.
 * Note: Cedar only accepts UTC format ('Z' suffix), so local time is formatted as fake UTC.
 * Results are cached per request time (via Ref owned by the layer) to avoid repeated computation.
 */
const buildRequestContext = (
  requestTime: DateTime.Utc,
  cacheRef: Ref.Ref<RequestContextCache>,
): Effect.Effect<CedarContext> =>
  Effect.gen(function* () {
    const cache = yield* Ref.get(cacheRef)
    if (
      cache.requestTime !== null &&
      Equal.equals(cache.requestTime, requestTime) &&
      cache.context !== null
    ) {
      return cache.context
    }
    const zoned = DateTime.unsafeMakeZoned(requestTime, {
      timeZone: systemTimezone,
    })
    const context: CedarContext = {
      requestTime: {
        __extn: { fn: "datetime", arg: formatLocalTimeAsUtc(zoned) },
      },
      nodeEnv: process.env["NODE_ENV"] ?? "development",
    }
    yield* Ref.set(cacheRef, { requestTime, context })
    return context
  })

// Base identifier for pre-parsed policies (suffixed with a process-unique UUID on each parse/reload)
const POLICY_SET_ID_BASE = "pf-policies"
const SCHEMA_NAME = "pf-schema"

/**
 * Convert UserPrincipal to Cedar entity format
 * Includes roles in parents array to enable "principal in PF::Role::..." checks
 */
const principalToEntity = (principal: UserPrincipal): EntityJson => ({
  uid: principal.uid,
  attrs: {
    ...("owner" in principal
      ? { owner: { __entity: principal.owner }, name: principal.name }
      : {}),
    // Cedar expects Set of entity references in CedarValueJson format
    roles: principal.roles.map((role) => ({ __entity: role })),
    orgUnit: { __entity: principal.orgUnit },
  },
  parents: [
    ...("owner" in principal ? [principal.owner] : []),
    principal.orgUnit,
    ...principal.roles,
  ],
})

const providerUserOrgUnitEntities = (
  principals: readonly UserPrincipal[],
): EntityJson[] => {
  const orgUnits = new Map(
    principals.map((principal) => [principal.orgUnit.id, principal.orgUnit]),
  )

  return [...orgUnits.values()].map((orgUnit) => ({
    uid: orgUnit,
    attrs: { name: orgUnit.id },
    parents: [],
  }))
}

const roleEntities = (roles: readonly RoleEntity[]): EntityJson[] => {
  const uniqueRoles = new Map(roles.map((role) => [role.id, role]))

  return [...uniqueRoles.values()].map((role) => ({
    uid: role,
    attrs: {},
    parents: [],
  }))
}

/**
 * Convert LoginResource to Cedar entity format
 */
const resourceToEntity = (resource: Resource): EntityJson => ({
  uid: resource.uid,
  attrs: {},
  parents: [...(resource.parents ?? [])],
})

/**
 * Convert RoleResource to Cedar entity format
 */
const roleResourceToEntity = (resource: RoleResource): EntityJson => ({
  uid: resource.uid,
  attrs: {},
  parents: [],
})

/**
 * Convert StepResource to Cedar entity format
 * Includes role and startsProcess attributes and Process parent for hierarchy-based policies
 * The Process parent enables: resource in PF::Process::"finance/purchase-request"
 */
const stepResourceToEntity = (resource: StepResource): EntityJson => ({
  uid: resource.uid,
  attrs: {
    ...(resource.role
      ? {
          // Cedar expects entity reference in CedarValueJson format
          role: { __entity: resource.role },
        }
      : {}),
    startsProcess: resource.startsProcess,
    embedded: resource.embedded,
  },
  parents: [resource.process],
})

/**
 * Create a Process entity for the Step's parent hierarchy
 * This enables: resource in PF::OrgUnit::"finance" to match Steps
 * The hierarchy is: Step -> Process -> OrgUnit
 */
const stepProcessEntity = (resource: StepResource): EntityJson => ({
  uid: resource.process,
  attrs: {},
  parents: [resource.orgUnit],
})

const formFieldResourceToEntity = (
  resource: FormFieldResource,
): EntityJson => ({
  uid: resource.uid,
  attrs: {
    step: { __entity: resource.step },
    process: { __entity: resource.process },
    fieldName: resource.fieldName,
    ...(resource.role ? { role: { __entity: resource.role } } : {}),
  },
  parents: [resource.step],
})

const formFieldStepEntity = (resource: FormFieldResource): EntityJson => ({
  uid: resource.step,
  attrs: {
    ...(resource.stepRole ? { role: { __entity: resource.stepRole } } : {}),
    startsProcess: resource.stepStartsProcess,
    embedded: resource.stepEmbedded,
  },
  parents: [resource.process],
})

const formFieldProcessEntity = (resource: FormFieldResource): EntityJson => ({
  uid: resource.process,
  attrs: {},
  parents: [resource.orgUnit],
})

const formFieldOrgUnitEntity = (resource: FormFieldResource): EntityJson => ({
  uid: resource.orgUnit,
  attrs: { name: resource.orgUnit.id },
  parents: [],
})

/**
 * Convert ExecutionResource to Cedar entity format
 * Includes startedBy attribute and parents for hierarchy-based policies
 * Parents include the Process and all OrgUnits from completed steps
 * This enables: resource in PF::Process::"finance/purchase-request"
 * and: resource in PF::OrgUnit::"/Finance/"
 */
const executionResourceToEntity = (
  resource: ExecutionResource,
): EntityJson => ({
  uid: resource.uid,
  attrs: {
    ...(resource.startedBy
      ? { startedBy: { __entity: resource.startedBy } }
      : {}),
    ...(resource.startedByRole
      ? { startedByRole: { __entity: resource.startedByRole } }
      : {}),
  },
  parents: [resource.process, ...resource.orgUnits],
})

/**
 * Create a Process entity for the Execution's parent hierarchy
 * Process doesn't have OrgUnit parents - the Execution has OrgUnits directly
 */
const executionProcessEntity = (resource: ExecutionResource): EntityJson => ({
  uid: resource.process,
  attrs: {},
  parents: [],
})

/**
 * Create OrgUnit entities for the Execution's hierarchy
 * These are needed for hierarchy resolution in Cedar
 */
const executionOrgUnitEntities = (resource: ExecutionResource): EntityJson[] =>
  resource.orgUnits.map((orgUnit) => ({
    uid: orgUnit,
    attrs: { name: orgUnit.id },
    parents: [],
  }))

/**
 * Convert ServiceAccountPrincipal to Cedar entity format
 * ServiceAccounts have roles attribute but no parents (per Cedar schema)
 */
const serviceAccountPrincipalToEntity = (
  principal: ServiceAccountPrincipalType,
): EntityJson => ({
  uid: principal.uid,
  attrs: {
    roles: principal.roles.map((role) => ({ __entity: role })),
  },
  parents: [],
})

const publicLinkPrincipalToEntity = (
  principal: PublicLinkPrincipalType,
): EntityJson => ({
  uid: principal.uid,
  attrs: {
    todo: { __entity: principal.todo },
  },
  parents: [],
})

const todoResourceToEntity = (resource: TodoResource): EntityJson => ({
  uid: resource.uid,
  attrs: {
    ...(resource.step ? { step: { __entity: resource.step } } : {}),
    ...(resource.role ? { role: { __entity: resource.role } } : {}),
    ...(resource.assignedTo
      ? { assignedTo: { __entity: resource.assignedTo } }
      : {}),
  },
  parents: [
    ...(resource.step ? [resource.step] : []),
    ...(resource.process ? [resource.process] : []),
  ],
})

const todoStepEntity = (resource: TodoResource): EntityJson | null =>
  resource.step && resource.process
    ? {
        uid: resource.step,
        attrs: {
          ...(resource.role ? { role: { __entity: resource.role } } : {}),
          startsProcess: false,
          embedded: false,
        },
        parents: [resource.process],
      }
    : null

const todoProcessEntity = (resource: TodoResource): EntityJson | null =>
  resource.process
    ? {
        uid: resource.process,
        attrs: {},
        parents: resource.orgUnit ? [resource.orgUnit] : [],
      }
    : null

const todoOrgUnitEntity = (resource: TodoResource): EntityJson | null =>
  resource.orgUnit
    ? {
        uid: resource.orgUnit,
        attrs: { name: resource.orgUnit.id },
        parents: [],
      }
    : null

/**
 * Convert GraphQLFieldResource to Cedar entity format.
 * Only includes tag attribute when present (Cedar schema defines tag?: String).
 */
const graphqlFieldResourceToEntity = (
  resource: GraphQLFieldResource,
): EntityJson => ({
  uid: resource.uid,
  attrs: resource.tag ? { tag: resource.tag } : {},
  parents: [],
})

/**
 * Convert ListResource to Cedar entity format
 * Includes roles attribute and OrgUnit parent for hierarchy-based policies
 */
const listResourceToEntity = (resource: ListResource): EntityJson => ({
  uid: resource.uid,
  attrs: {
    roles: resource.roles.map((role) => ({ __entity: role })),
  },
  parents: [resource.orgUnit],
})

/**
 * Convert FileResource to Cedar entity format
 * Includes owner attribute and OrgUnit parent for hierarchy-based policies
 * The owner is stored as an entity reference to enable: principal == resource.owner
 * The OrgUnit parent enables: resource in PF::OrgUnit::"..."
 * The documentStore attribute enables store-based policies like:
 *   resource.documentStore == "/finance/documents"
 */
const fileResourceToEntity = (resource: FileResource): EntityJson => ({
  uid: resource.uid,
  attrs: {
    owner: { __entity: resource.owner },
    documentStore: resource.documentStore,
  },
  parents: [resource.orgUnit],
})

/**
 * Type guard to check if principal is a ServiceAccountPrincipal
 */
const isServiceAccountPrincipal = (
  principal: UserPrincipal | ServiceAccountPrincipalType,
): principal is ServiceAccountPrincipalType =>
  principal.uid.type === "PF::ServiceAccount"

/**
 * Execute a Cedar authorization check and return the decision.
 * Handles error conversion with action context for debugging.
 */
const executeAuthorizationCheck = (
  call: StatefulAuthorizationCall,
  actionId: string,
  principal:
    | UserPrincipal
    | ServiceAccountPrincipalType
    | PublicLinkPrincipalType,
): Effect.Effect<boolean, AuthorizationError> => {
  // Include the trusted owner entity as well as the Delegation's parent edge.
  // Do not replace an owner resource already supplied by the caller.
  const owner =
    "owner" in principal
      ? {
          uid: principal.owner,
          roles: principal.roles,
          orgUnit: principal.orgUnit,
        }
      : undefined
  const result = statefulIsAuthorized(
    owner && Array.isArray(call.entities)
      ? {
          ...call,
          entities: [
            ...call.entities,
            ...(call.entities.some(
              (entity) =>
                "type" in entity.uid &&
                entity.uid.type === owner.uid.type &&
                entity.uid.id === owner.uid.id,
            )
              ? []
              : [principalToEntity(owner)]),
          ],
        }
      : call,
  )

  if (result.type === "success") {
    return Effect.succeed(result.response.decision === "allow")
  }

  return Effect.fail(
    new AuthorizationError({
      message: `Authorization check failed for action '${actionId}': ${result.errors.map((e) => e.message).join(", ")}`,
    }),
  )
}

/**
 * Parse policies and return the policy set ID, or fail with PolicyParseError.
 * Concatenates multiple policy strings into a single string for Cedar.
 *
 * IDs must be unique process-wide: cedar-wasm keys preparsed sets by string ID
 * in a process-global cache. A layer-local counter would restart at 1 per
 * layer and could clobber another instance's policies under concurrent layers.
 */
const parsePolicies = (
  policiesText: readonly string[],
): Effect.Effect<string, PolicyParseError> =>
  Effect.gen(function* () {
    const policySetId = `${POLICY_SET_ID_BASE}-${crypto.randomUUID()}`
    // Cedar expects either a single string or Policy[] with pre-parsed policies
    // We concatenate all policy strings for simplicity
    const combinedPolicies = policiesText.join("\n\n")
    const policyParseResult = preparsePolicySet(policySetId, {
      staticPolicies: combinedPolicies,
    })

    if (policyParseResult.type === "failure") {
      return yield* new PolicyParseError({
        errors: policyParseResult.errors.map((e) => e.message),
      })
    }

    return policySetId
  })

/**
 * Local Cedar authorization implementation using cedar-wasm
 * Pre-parses policy and schema files once, then uses stateful authorization.
 * Supports hot reload when PolicyWatcherService is available.
 */
export const LocalCedarAuthorizationLive = Layer.scoped(
  AuthorizationService,
  Effect.gen(function* () {
    const config = yield* LocalCedarConfig

    // Layer-scoped request-context cache (not shared across layer instances)
    const requestContextCacheRef = yield* Ref.make<RequestContextCache>({
      requestTime: null,
      context: null,
    })

    // Pre-parse and cache the policy set
    const initialPolicySetId = yield* parsePolicies(config.policiesText)

    // Pre-parse and cache the schema
    const schemaParseResult = preparseSchema(SCHEMA_NAME, config.schemaText)
    if (schemaParseResult.type === "failure") {
      return yield* new SchemaParseError({
        errors: schemaParseResult.errors.map((e) => e.message),
      })
    }

    // Store current policy set ID in a Ref for potential hot reload
    const policySetIdRef = yield* Ref.make(initialPolicySetId)

    // Check if PolicyWatcherService is available for hot reload
    const watcherOption = yield* Effect.serviceOption(PolicyWatcherService)
    const notifierOption = yield* Effect.serviceOption(
      CedarReloadNotifierService,
    )

    if (Option.isSome(watcherOption)) {
      const watcher = watcherOption.value

      // Fork a fiber to listen for policy changes and reload
      yield* Effect.forkScoped(
        watcher.changes.pipe(
          Stream.tap(() =>
            Effect.gen(function* () {
              const newPolicies = yield* watcher.currentPolicies

              // Try to parse new policies
              const parseResult = yield* Effect.either(
                parsePolicies(newPolicies),
              )

              yield* Either.match(parseResult, {
                onRight: (policySetId) =>
                  Effect.gen(function* () {
                    yield* Ref.set(policySetIdRef, policySetId)
                    yield* Effect.log("Cedar policies hot-swapped")

                    // Notify listeners of successful reload (non-blocking)
                    if (Option.isSome(notifierOption)) {
                      yield* Effect.sync(() =>
                        notifierOption.value.onCedarReloaded(),
                      ).pipe(
                        Effect.catchAllCause((cause) =>
                          Effect.logWarning(
                            "onCedarReloaded callback failed",
                          ).pipe(Effect.annotateLogs({ cause })),
                        ),
                      )
                    }
                  }),
                onLeft: (error) =>
                  Effect.logWarning(
                    `Failed to parse reloaded Cedar policies, keeping previous: ${error.errors.join(", ")}`,
                  ),
              })
            }),
          ),
          Stream.runDrain,
        ),
      )
    }

    return {
      canIssueDelegationSecret: (principal, owner, trusted) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          const evidence = trusted.humanAuthentication
          const entities = [
            principalToEntity(owner),
            ...(principal.uid.type === owner.uid.type &&
            principal.uid.id === owner.uid.id
              ? []
              : [
                  isServiceAccountPrincipal(principal)
                    ? serviceAccountPrincipalToEntity(principal)
                    : principalToEntity(principal),
                ]),
            ...providerUserOrgUnitEntities(
              isServiceAccountPrincipal(principal)
                ? [owner]
                : [principal, owner],
            ),
            ...roleEntities([...principal.roles, ...owner.roles]),
          ]
          return yield* executeAuthorizationCheck(
            {
              principal: principal.uid,
              action: { type: "PF::Action", id: "issueDelegationSecret" },
              resource: owner.uid,
              context: {
                ...context,
                ownerProviderUserId: trusted.ownerProviderUserId,
                humanSession: trusted.humanSession === true,
                ...(evidence
                  ? {
                      humanAuthentication: {
                        providerUserId: evidence.providerUserId,
                        method: evidence.method,
                        // Epoch arithmetic avoids the legacy wall-clock Cedar encoding.
                        ageMillis:
                          DateTime.toEpochMillis(requestTime) -
                          evidence.authenticatedAt,
                      },
                    }
                  : {}),
              },
              preparsedPolicySetId: policySetId,
              preparsedSchemaName: SCHEMA_NAME,
              entities,
            },
            "issueDelegationSecret",
            principal,
          )
        }),

      canManageDelegation: (principal, delegation, operation) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          const action = `${operation}Delegation`
          return yield* executeAuthorizationCheck(
            {
              principal: principal.uid,
              action: { type: "PF::Action", id: action },
              resource: delegation.uid,
              context,
              preparsedPolicySetId: policySetId,
              preparsedSchemaName: SCHEMA_NAME,
              entities: [
                principalToEntity(delegation),
                ...(principal.uid.type === delegation.uid.type &&
                principal.uid.id === delegation.uid.id
                  ? []
                  : [
                      isServiceAccountPrincipal(principal)
                        ? serviceAccountPrincipalToEntity(principal)
                        : principalToEntity(principal),
                    ]),
                ...(principal.uid.type === delegation.owner.type &&
                principal.uid.id === delegation.owner.id
                  ? []
                  : [
                      principalToEntity({
                        uid: delegation.owner,
                        roles: delegation.roles,
                        orgUnit: delegation.orgUnit,
                      }),
                    ]),
                ...providerUserOrgUnitEntities(
                  isServiceAccountPrincipal(principal)
                    ? [delegation]
                    : [principal, delegation],
                ),
                ...roleEntities([...principal.roles, ...delegation.roles]),
              ],
            },
            action,
            principal,
          )
        }),

      canListDelegationTokens: (principal, owner) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          return yield* executeAuthorizationCheck(
            {
              principal: principal.uid,
              action: { type: "PF::Action", id: "listDelegationTokens" },
              resource: owner.uid,
              context,
              preparsedPolicySetId: policySetId,
              preparsedSchemaName: SCHEMA_NAME,
              entities: [
                principalToEntity(owner),
                ...(principal.uid.type === owner.uid.type &&
                principal.uid.id === owner.uid.id
                  ? []
                  : [
                      isServiceAccountPrincipal(principal)
                        ? serviceAccountPrincipalToEntity(principal)
                        : principalToEntity(principal),
                    ]),
                ...providerUserOrgUnitEntities(
                  isServiceAccountPrincipal(principal)
                    ? [owner]
                    : [principal, owner],
                ),
                ...roleEntities([...principal.roles, ...owner.roles]),
              ],
            },
            "listDelegationTokens",
            principal,
          )
        }),

      canLogin: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          const entities: EntityJson[] = [
            principalToEntity(principal),
            resourceToEntity(resource),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: "login" },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(call, "login", principal)
        }),

      canCompleteStep: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          const principalEntity = isServiceAccountPrincipal(principal)
            ? serviceAccountPrincipalToEntity(principal)
            : principalToEntity(principal)
          const entities: EntityJson[] = [
            principalEntity,
            stepResourceToEntity(resource),
            // Include Process entity with OrgUnit parent to enable:
            // resource in PF::OrgUnit::"finance" on Steps
            stepProcessEntity(resource),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: "complete" },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(call, "complete", principal)
        }),

      canCompleteTodo: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          const principalEntity = isServiceAccountPrincipal(principal)
            ? serviceAccountPrincipalToEntity(principal)
            : principalToEntity(principal)
          const optionalEntities = [
            todoStepEntity(resource),
            todoProcessEntity(resource),
            todoOrgUnitEntity(resource),
          ].filter((entity): entity is EntityJson => entity !== null)
          const entities: EntityJson[] = [
            principalEntity,
            todoResourceToEntity(resource),
            ...optionalEntities,
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: "complete" },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(call, "complete", principal)
        }),

      canCorrectPublicCompletionTodo: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          const optionalEntities = [
            todoStepEntity(resource),
            todoProcessEntity(resource),
            todoOrgUnitEntity(resource),
          ].filter((entity): entity is EntityJson => entity !== null)
          const entities: EntityJson[] = [
            principalToEntity(principal),
            todoResourceToEntity(resource),
            ...optionalEntities,
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: "publicCompletionCorrection" },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(
            call,
            "publicCompletionCorrection",
            principal,
          )
        }),

      canCompletePublicTodo: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          const entities: EntityJson[] = [
            publicLinkPrincipalToEntity(principal),
            todoResourceToEntity(resource),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: "complete" },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(call, "complete", principal)
        }),

      canRequestRole: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )

          // Convert principal based on type (ProviderUser or ServiceAccount)
          const principalEntity = isServiceAccountPrincipal(principal)
            ? serviceAccountPrincipalToEntity(principal)
            : principalToEntity(principal)

          const entities: EntityJson[] = [
            principalEntity,
            roleResourceToEntity(resource),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: "requestRole" },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(
            call,
            "requestRole",
            principal,
          )
        }),

      canRequestProviderUserPermissions: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )

          const entities: EntityJson[] = [
            isServiceAccountPrincipal(principal)
              ? serviceAccountPrincipalToEntity(principal)
              : principalToEntity(principal),
            principalToEntity(resource),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: {
              type: "PF::Action",
              id: "requestProviderUserPermissions",
            },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(
            call,
            "requestProviderUserPermissions",
            principal,
          )
        }),

      canActOnBehalfOf: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )

          const principalEntity = isServiceAccountPrincipal(principal)
            ? serviceAccountPrincipalToEntity(principal)
            : principalToEntity(principal)
          const orgUnitEntities = isServiceAccountPrincipal(principal)
            ? providerUserOrgUnitEntities([resource])
            : providerUserOrgUnitEntities([principal, resource])
          const roles = [...principal.roles, ...resource.roles]

          const entities: EntityJson[] = [
            principalEntity,
            // The target ProviderUser already carries roles and orgUnit attrs;
            // custom target hierarchy policies need org-specific parent data.
            principalToEntity(resource),
            ...orgUnitEntities,
            ...roleEntities(roles),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: "actOnBehalfOf" },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(
            call,
            "actOnBehalfOf",
            principal,
          )
        }),

      canViewExecution: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          const entities: EntityJson[] = [
            isServiceAccountPrincipal(principal)
              ? serviceAccountPrincipalToEntity(principal)
              : principalToEntity(principal),
            executionResourceToEntity(resource),
            // Include Process and OrgUnit entities for hierarchy:
            // resource in PF::OrgUnit::"/Finance/" on Executions
            executionProcessEntity(resource),
            ...executionOrgUnitEntities(resource),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: "view" },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(call, "view", principal)
        }),

      canRestartExecution: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          const entities: EntityJson[] = [
            isServiceAccountPrincipal(principal)
              ? serviceAccountPrincipalToEntity(principal)
              : principalToEntity(principal),
            executionResourceToEntity(resource),
            // Include Process and OrgUnit entities for hierarchy
            executionProcessEntity(resource),
            ...executionOrgUnitEntities(resource),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: "restart" },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(call, "restart", principal)
        }),

      canAbandonStep: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          const entities: EntityJson[] = [
            isServiceAccountPrincipal(principal)
              ? serviceAccountPrincipalToEntity(principal)
              : principalToEntity(principal),
            stepResourceToEntity(resource),
            stepProcessEntity(resource),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: "abandon" },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(call, "abandon", principal)
        }),

      canDraftStep: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          const entities: EntityJson[] = [
            principalToEntity(principal),
            stepResourceToEntity(resource),
            // Include Process entity with OrgUnit parent for hierarchy policies
            stepProcessEntity(resource),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: "draft" },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(call, "draft", principal)
        }),

      canModifyField: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          const entities: EntityJson[] = [
            principalToEntity(principal),
            formFieldResourceToEntity(resource),
            formFieldStepEntity(resource),
            formFieldProcessEntity(resource),
            formFieldOrgUnitEntity(resource),
            ...providerUserOrgUnitEntities([principal]),
            ...roleEntities(principal.roles),
            ...roleEntities(
              [resource.role, resource.stepRole].filter(
                (role): role is RoleEntity => role !== undefined,
              ),
            ),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: "modifyField" },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(
            call,
            "modifyField",
            principal,
          )
        }),

      canAccessField: (principal, resource, action) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )

          // Convert principal based on type (ProviderUser or ServiceAccount)
          const principalEntity = isServiceAccountPrincipal(principal)
            ? serviceAccountPrincipalToEntity(principal)
            : principalToEntity(principal)

          const entities: EntityJson[] = [
            principalEntity,
            graphqlFieldResourceToEntity(resource),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: action },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(call, action, principal)
        }),

      canAccessFeature: (principal, resource, action) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )

          // Convert principal based on type (ProviderUser or ServiceAccount)
          const principalEntity = isServiceAccountPrincipal(principal)
            ? serviceAccountPrincipalToEntity(principal)
            : principalToEntity(principal)

          const entities: EntityJson[] = [
            principalEntity,
            resourceToEntity(resource),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: action },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(call, action, principal)
        }),

      canAccessList: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          const entities: EntityJson[] = [
            principalToEntity(principal),
            listResourceToEntity(resource),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: "view" },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(call, "view", principal)
        }),

      canCreateList: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          const entities: EntityJson[] = [
            principalToEntity(principal),
            listResourceToEntity(resource),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: "create" },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(call, "create", principal)
        }),

      canUpdateList: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          const entities: EntityJson[] = [
            principalToEntity(principal),
            listResourceToEntity(resource),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: "update" },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(call, "update", principal)
        }),

      canDeleteList: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          const entities: EntityJson[] = [
            principalToEntity(principal),
            listResourceToEntity(resource),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: "delete" },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(call, "delete", principal)
        }),

      canDownloadFile: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          const entities: EntityJson[] = [
            principalToEntity(principal),
            fileResourceToEntity(resource),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: "download" },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(call, "download", principal)
        }),

      canDeleteFile: (principal, resource) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )
          const entities: EntityJson[] = [
            principalToEntity(principal),
            fileResourceToEntity(resource),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action: { type: "PF::Action", id: "delete" },
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(call, "delete", principal)
        }),

      canPerformAction: (principal, resource, action) =>
        Effect.gen(function* () {
          const policySetId = yield* Ref.get(policySetIdRef)
          const requestTime = yield* getRequestTime()
          const context = yield* buildRequestContext(
            requestTime,
            requestContextCacheRef,
          )

          // Convert principal based on type (ProviderUser or ServiceAccount)
          const principalEntity = isServiceAccountPrincipal(principal)
            ? serviceAccountPrincipalToEntity(principal)
            : principalToEntity(principal)

          const entities: EntityJson[] = [
            principalEntity,
            resourceToEntity(resource),
          ]

          const call: StatefulAuthorizationCall = {
            principal: principal.uid,
            action,
            resource: resource.uid,
            context,
            preparsedPolicySetId: policySetId,
            preparsedSchemaName: SCHEMA_NAME,
            entities,
          }

          return yield* executeAuthorizationCheck(call, action.id, principal)
        }),
    }
  }),
)
