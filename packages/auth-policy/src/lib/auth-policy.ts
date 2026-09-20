import { Context, type Effect } from "effect"
import type { RequestTime } from "@pf/request-time"
import type { AuthorizationError } from "./errors"
import type {
  DelegationIssuanceContext,
  DelegationPrincipalType,
  ExecutionResource,
  FeatureAction,
  FileResource,
  FormFieldResource,
  GraphQLFieldResource,
  ListResource,
  ProviderUserPrincipal,
  PublicLinkPrincipalType,
  Resource,
  RoleResource,
  ServiceAccountPrincipal,
  ServiceAccountPrincipalType,
  StepResource,
  TodoResource,
  UserPrincipal,
} from "./types"

/**
 * Abstract authorization service
 * Provides policy-based access control using Cedar policies.
 * All methods require RequestTime context for audit and time-based policies.
 */
export class AuthorizationService extends Context.Tag(
  "@pf/auth-policy/AuthorizationService",
)<
  AuthorizationService,
  {
    readonly canManageDelegation: (
      principal: UserPrincipal | ServiceAccountPrincipalType,
      delegation: DelegationPrincipalType,
      operation: "rename" | "replace" | "revoke",
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    readonly canIssueDelegationSecret: (
      principal: UserPrincipal | ServiceAccountPrincipalType,
      owner: ProviderUserPrincipal,
      context: DelegationIssuanceContext,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    readonly canListDelegationTokens: (
      principal: UserPrincipal | ServiceAccountPrincipalType,
      owner: ProviderUserPrincipal,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    readonly canLogin: (
      principal: UserPrincipal,
      resource: Resource,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Check if the principal can complete a step.
     * Uses Cedar policy: principal.roles.containsAny(resource.allowedRoles)
     * For start steps (startsProcess=true), custom policies can use resource.startsProcess
     */
    readonly canCompleteStep: (
      principal: UserPrincipal | ServiceAccountPrincipal,
      resource: StepResource,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Check if the principal can complete an existing todo. Todo resources carry
     * step role and direct-assignee context so Cedar owns active-work visibility.
     */
    readonly canCompleteTodo: (
      principal: UserPrincipal | ServiceAccountPrincipal,
      resource: TodoResource,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Check if the principal can correct a Public Completion delivery failure.
     * This is intentionally distinct from normal Todo/PublicLink completion.
     */
    readonly canCorrectPublicCompletionTodo: (
      principal: UserPrincipal,
      resource: TodoResource,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Public todo capability tokens bind one public-link principal to the same
     * todo resource. The default Cedar check is intentionally a policy-owned
     * hook for future revocation/scoping rather than an extra token gate.
     */
    readonly canCompletePublicTodo: (
      principal: PublicLinkPrincipalType,
      resource: TodoResource,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Check if the principal can request a specific role.
     * Uses Cedar policy: principal.roles.contains(resource)
     * Custom policies can grant provider users or service accounts access to roles they don't already have.
     */
    readonly canRequestRole: (
      principal: UserPrincipal | ServiceAccountPrincipalType,
      resource: RoleResource,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Check if the principal can request permission to impersonate a provider user.
     * Uses Cedar policy: principal == ServiceAccount::"..." and resource is PF::ProviderUser
     * There is no default permit; organisations may explicitly grant access.
     */
    readonly canRequestProviderUserPermissions: (
      principal: ServiceAccountPrincipalType | DelegationPrincipalType,
      resource: ProviderUserPrincipal,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Check if the principal can act on behalf of a provider user.
     * Custom policies grant this to selected users or service accounts.
     */
    readonly canActOnBehalfOf: (
      principal: UserPrincipal | ServiceAccountPrincipalType,
      resource: ProviderUserPrincipal,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Check if the principal can view an execution.
     * Uses Cedar policies:
     * - Provider users can view executions they started (principal == resource.startedBy)
     * - Provider users can view executions in their org unit (resource in principal.orgUnit)
     */
    readonly canViewExecution: (
      principal: UserPrincipal | ServiceAccountPrincipalType,
      resource: ExecutionResource,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Check if the principal can restart a failed execution.
     * Uses Cedar policy. There is no default permit; custom deployment
     * policies may grant restart.
     */
    readonly canRestartExecution: (
      principal: UserPrincipal | ServiceAccountPrincipalType,
      resource: ExecutionResource,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Check if the principal can abandon a running execution.
     * Uses Cedar policy checked against the active step resources.
     */
    readonly canAbandonStep: (
      principal: UserPrincipal | ServiceAccountPrincipalType,
      resource: StepResource,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Check if the principal can draft (view/edit) a draft process execution.
     * Uses Cedar policy: principal.roles.contains(resource.role)
     * This is used for filtering draft process executions in pull and subscription queries.
     */
    readonly canDraftStep: (
      principal: UserPrincipal,
      resource: StepResource,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Check if the principal can modify a submitted form field.
     * Uses Cedar policy: resource has role && principal.roles.contains(resource.role)
     */
    readonly canModifyField: (
      principal: UserPrincipal,
      resource: FormFieldResource,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Check if the principal can access a GraphQL field.
     * Uses Cedar policies based on the field's tag attribute:
     * - Provider users can access "providerUser" tagged fields if they have roles
     * - ServiceAccounts can access "ci" tagged fields
     */
    readonly canAccessField: (
      principal: UserPrincipal | ServiceAccountPrincipalType,
      resource: GraphQLFieldResource,
      action: "query" | "mutation" | "subscription",
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Check if the principal can access a feature (semantic action).
     * Uses Cedar policies for feature-level authorization:
     * - Action is a semantic action like "administerUsers" or "administerOAuthProviders"
     * - Resource is the Application entity
     * Provides coarse-grained feature authorization alternative to field-level tags.
     */
    readonly canAccessFeature: (
      principal: UserPrincipal | ServiceAccountPrincipalType,
      resource: Resource,
      action: FeatureAction,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Check if the principal can access a list.
     * Uses Cedar policy: principal.roles.containsAny(resource.roles)
     * This is used for filtering lists the user can access.
     */
    readonly canAccessList: (
      principal: UserPrincipal,
      resource: ListResource,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /** Independent opt-in Cedar create permission; no default List role grant. */
    readonly canCreateList: (
      principal: UserPrincipal,
      resource: ListResource,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /** Check the Cedar update permission for a List item. */
    readonly canUpdateList: (
      principal: UserPrincipal,
      resource: ListResource,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Check if the principal can delete a list item.
     * Uses Cedar policy: principal.roles.containsAny(resource.roles)
     * This is used for authorizing list item delete mutations.
     */
    readonly canDeleteList: (
      principal: UserPrincipal,
      resource: ListResource,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Check if the principal can download a file.
     * Uses Cedar policy: principal == resource.owner
     * File owners can always download their own files. Custom policies can
     * add additional permits for org-unit sharing or role-based access.
     */
    readonly canDownloadFile: (
      principal: UserPrincipal,
      resource: FileResource,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Check if the principal can delete a file.
     * Uses Cedar policy: principal == resource.owner
     * File owners can always delete their own files.
     */
    readonly canDeleteFile: (
      principal: UserPrincipal,
      resource: FileResource,
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>

    /**
     * Check if the principal can perform a named action on a resource.
     * Used for custom org-level authorization checks with custom Cedar schemas.
     * The action specifies both the Cedar namespace type (e.g. "Org::Action") and
     * the action id (e.g. "viewAllProjects"), allowing actions from any namespace.
     * The resource is passed as-is to Cedar (use a singleton resource if not applicable).
     */
    readonly canPerformAction: (
      principal: UserPrincipal | ServiceAccountPrincipalType,
      resource: Resource,
      action: { type: string; id: string },
    ) => Effect.Effect<boolean, AuthorizationError, RequestTime>
  }
>() {}
