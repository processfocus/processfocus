/**
 * Implements the schema.cedarschema entity schema as typescript.
 */

/**
 * Entity reference in Cedar format
 * Example: { type: "PF::ProviderUser", id: "alice" }
 */
export interface EntityRef {
  readonly type: string
  readonly id: string
}

/**
 * Role entity reference
 * Uses the role path as the id for Cedar policies
 * Example: { type: "PF::Role", id: "HR/Manager" }
 */
export interface RoleEntity {
  readonly type: "PF::Role"
  readonly id: string
}

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]]

/**
 * OrgUnit entity reference
 * Example: { type: "PF::OrgUnit", id: "finance" }
 */
export interface OrgUnitEntity {
  readonly type: "PF::OrgUnit"
  readonly id: string
}

/**
 * Principal for login authorization check
 * Represents a provider user with their assigned roles and org unit
 */
export interface ProviderUserPrincipalType {
  readonly uid: EntityRef // type: "PF::ProviderUser", id is email
  readonly roles: RoleEntity[]
  readonly orgUnit: OrgUnitEntity
}

export interface DelegationPrincipalType extends ProviderUserPrincipalType {
  readonly uid: { readonly type: "PF::Delegation"; readonly id: string }
  readonly owner: { readonly type: "PF::ProviderUser"; readonly id: string }
  readonly name: string
}

export type UserPrincipal = ProviderUserPrincipalType | DelegationPrincipalType

/** Trusted owner facts must be resolved by the accepting authentication boundary.
 * The immutable id identifies the Delegation, never its mutable display name.
 */
export class DelegationPrincipal implements DelegationPrincipalType {
  readonly uid: DelegationPrincipalType["uid"]
  readonly owner: DelegationPrincipalType["owner"]
  readonly name: string
  readonly roles: RoleEntity[]
  readonly orgUnit: OrgUnitEntity

  constructor(
    id: string,
    attrs: {
      owner: string
      name: string
      roles: readonly string[]
      orgUnitId: string
    },
  ) {
    this.uid = { type: "PF::Delegation", id }
    this.owner = { type: "PF::ProviderUser", id: attrs.owner }
    this.name = attrs.name
    this.roles = attrs.roles.map((id) => ({ type: "PF::Role", id }))
    this.orgUnit = { type: "PF::OrgUnit", id: attrs.orgUnitId }
  }
}

/**
 * Resource for login authorization check
 * Represents the application being accessed
 */
export interface Resource {
  readonly uid: EntityRef // type: "PF::Application"
  readonly parents?: readonly EntityRef[]
}

/** Trusted issuance facts from the verified session and database-resolved owner.
 * Never populate provenance or authentication evidence from request input,
 * an owner's configured provider, or JWT issuance time.
 */
export interface DelegationIssuanceContext {
  readonly ownerProviderUserId: string
  readonly humanSession?: boolean | undefined
  readonly humanAuthentication?:
    | {
        readonly providerUserId: string
        readonly authenticatedAt: number
        readonly method: "passkey"
      }
    | undefined
}

/**
 * Provider user principal for authorization checks
 * Provides a convenient constructor for creating UserPrincipal instances
 *
 * The id must be the stable login email used in invitations and custom Cedar
 * policies, not the generated database provider_user.id.
 */
export class ProviderUserPrincipal implements ProviderUserPrincipalType {
  readonly uid: EntityRef
  readonly roles: RoleEntity[]
  readonly orgUnit: OrgUnitEntity

  constructor(
    id: string,
    attrs: { roles: string | readonly string[]; orgUnitId: string },
  ) {
    this.uid = { type: "PF::ProviderUser", id }
    const roleArray =
      typeof attrs.roles === "string" ? [attrs.roles] : attrs.roles
    this.roles = roleArray.map((rolePath) => ({
      type: "PF::Role",
      id: rolePath,
    }))
    this.orgUnit = { type: "PF::OrgUnit", id: attrs.orgUnitId }
  }
}

/**
 * Application resource for authorization checks
 * Provides a convenient constructor for creating LoginResource instances
 */
export class Application implements Resource {
  readonly uid: EntityRef

  constructor(id: string) {
    this.uid = { type: "PF::Application", id }
  }
}

/**
 * Process entity reference for Step parent hierarchy
 * Example: { type: "PF::Process", id: "finance/purchase-request" }
 */
export interface ProcessEntity {
  readonly type: "PF::Process"
  readonly id: string
}

/**
 * Step resource for authorization checks (complete step action)
 * Contains the role that can complete this step
 * and the parent process for hierarchy-based policies
 */
export interface StepResource extends Resource {
  readonly uid: EntityRef // type: "PF::Step"
  readonly role?: RoleEntity
  readonly process: ProcessEntity
  readonly orgUnit: OrgUnitEntity
  readonly startsProcess: boolean
  readonly embedded: boolean
  // Application-layer field, not used by Cedar policies.
  // Multi-role step authorization is implemented by iterating over
  // individual AuthStep instances — one per role — so supportingRolePaths
  // is intentionally omitted from StepResource (Cedar sees single-role
  // checks only).
  readonly supportingRolePaths: readonly string[] | undefined
}

export interface FormFieldResource extends Resource {
  readonly uid: EntityRef // type: "PF::FormField"
  readonly step: EntityRef // type: "PF::Step"
  readonly process: ProcessEntity
  readonly orgUnit: OrgUnitEntity
  readonly fieldName: string
  readonly role?: RoleEntity
  readonly stepRole?: RoleEntity
  readonly stepStartsProcess: boolean
  readonly stepEmbedded: boolean
}

export interface FormFieldProps {
  readonly stepPath: string
  readonly fieldName: string
  readonly rolePath?: string | null | undefined
  readonly stepRolePath?: string | null | undefined
  readonly processPath: string
  readonly orgUnitId?: string
  readonly stepStartsProcess?: boolean
  readonly stepEmbedded?: boolean
}

export class FormField implements FormFieldResource {
  readonly uid: EntityRef
  readonly step: EntityRef
  readonly process: ProcessEntity
  readonly orgUnit: OrgUnitEntity
  readonly fieldName: string
  readonly role?: RoleEntity
  readonly stepRole?: RoleEntity
  readonly stepStartsProcess: boolean
  readonly stepEmbedded: boolean

  constructor(props: FormFieldProps) {
    if (props.fieldName.includes("/")) {
      throw new Error("FormField fieldName must not contain '/'")
    }
    this.uid = {
      type: "PF::FormField",
      id: `${props.stepPath}/${props.fieldName}`,
    }
    this.step = { type: "PF::Step", id: props.stepPath }
    this.process = { type: "PF::Process", id: props.processPath }
    // Match Step's default org-unit derivation while handling absolute paths.
    const processPathSegments = props.processPath.split("/").filter(Boolean)
    let resolvedOrgUnitId = props.orgUnitId
    if (resolvedOrgUnitId === undefined) {
      if (processPathSegments.length < 2) {
        throw new Error(
          "FormField requires orgUnitId when processPath has no org-unit segment",
        )
      }
      const derivedOrgUnitId = processPathSegments[0] ?? ""
      resolvedOrgUnitId = derivedOrgUnitId
    }
    this.orgUnit = { type: "PF::OrgUnit", id: resolvedOrgUnitId }
    this.fieldName = props.fieldName
    this.stepStartsProcess = props.stepStartsProcess ?? false
    this.stepEmbedded = props.stepEmbedded ?? false
    if (props.rolePath) {
      this.role = { type: "PF::Role", id: props.rolePath }
    }
    if (props.stepRolePath) {
      this.stepRole = { type: "PF::Role", id: props.stepRolePath }
    }
  }
}

export interface StepProps {
  readonly stepPath: string
  readonly rolePath?: string | null | undefined
  // Application-layer field, not used by Cedar policies.
  // See StepResource.supportingRolePaths for rationale.
  readonly supportingRolePaths?: readonly string[]
  readonly processPath: string
  readonly startsProcess?: boolean
  readonly orgUnitId?: string
  readonly embedded?: boolean
}

/**
 * Step resource for authorization checks
 * Provides a convenient constructor for creating StepResource instances
 * The id should be the step path (e.g., "finance/expense-approval/submit")
 * The processPath enables policies like: resource in PF::Process::"finance/purchase-request"
 * The startsProcess flag indicates if this step is the start step of a process
 * The orgUnitId enables policies like: resource in PF::OrgUnit::"finance"
 *
 * If orgUnitId is not provided, it defaults to extracting the first path segment from processPath
 * (e.g., "finance/expense-approval" -> "finance")
 */
export class Step implements StepResource {
  readonly uid: EntityRef
  readonly role?: RoleEntity
  readonly process: ProcessEntity
  readonly orgUnit: OrgUnitEntity
  readonly startsProcess: boolean
  readonly embedded: boolean
  readonly supportingRolePaths: readonly string[] | undefined

  constructor(props: StepProps) {
    this.uid = { type: "PF::Step", id: props.stepPath }
    if (props.rolePath) {
      this.role = { type: "PF::Role", id: props.rolePath }
    }
    this.supportingRolePaths = props.supportingRolePaths
    this.process = { type: "PF::Process", id: props.processPath }
    // Default to first path segment if orgUnitId not provided
    const resolvedOrgUnitId =
      props.orgUnitId ?? props.processPath.split("/")[0] ?? ""
    this.orgUnit = { type: "PF::OrgUnit", id: resolvedOrgUnitId }
    this.startsProcess = props.startsProcess ?? false
    this.embedded = props.embedded ?? false
  }
}

export interface PublicLinkPrincipalType {
  readonly uid: EntityRef // type: "PF::PublicLink"
  readonly todo: EntityRef // type: "PF::Todo"
}

export class PublicLinkPrincipal implements PublicLinkPrincipalType {
  readonly uid: EntityRef
  readonly todo: EntityRef

  constructor(todoId: string) {
    this.uid = { type: "PF::PublicLink", id: todoId }
    this.todo = { type: "PF::Todo", id: todoId }
  }
}

export interface TodoResource extends Resource {
  readonly uid: EntityRef // type: "PF::Todo"
  readonly step?: EntityRef // type: "PF::Step"
  readonly role?: RoleEntity
  readonly process?: ProcessEntity
  readonly orgUnit?: OrgUnitEntity
  readonly assignedTo?: EntityRef // type: "PF::ProviderUser"
}

export class TodoRef implements TodoResource {
  readonly uid: EntityRef
  readonly step?: EntityRef
  readonly role?: RoleEntity
  readonly process?: ProcessEntity
  readonly orgUnit?: OrgUnitEntity
  readonly assignedTo?: EntityRef

  constructor(
    todoId: string,
    props?: {
      readonly stepPath: string
      readonly rolePath?: string | null | undefined
      readonly processPath: string
      readonly orgUnitId?: string | null | undefined
      readonly assignedToProviderUserEmail?: string | null | undefined
    },
  ) {
    this.uid = { type: "PF::Todo", id: todoId }
    if (props) {
      this.step = { type: "PF::Step", id: props.stepPath }
      if (props.rolePath) {
        this.role = { type: "PF::Role", id: props.rolePath }
      }
      this.process = { type: "PF::Process", id: props.processPath }
      const processPathSegments = props.processPath.split("/").filter(Boolean)
      this.orgUnit = {
        type: "PF::OrgUnit",
        id: props.orgUnitId ?? processPathSegments[0] ?? "",
      }
      if (props.assignedToProviderUserEmail) {
        this.assignedTo = {
          type: "PF::ProviderUser",
          id: props.assignedToProviderUserEmail,
        }
      }
    }
  }
}

/**
 * Execution resource for authorization checks (view action)
 * Contains the provider user who started the execution, the process,
 * and the org units from completed steps for hierarchy-based policies
 */
export interface ExecutionResource extends Resource {
  readonly uid: EntityRef // type: "PF::Execution"
  readonly startedBy?: EntityRef // ProviderUser who started
  readonly startedByRole?: RoleEntity // Role used to start the execution
  readonly process: ProcessEntity
  readonly orgUnits: OrgUnitEntity[] // Org units from completed steps
}

/**
 * Execution resource for authorization checks
 * Provides a convenient constructor for creating ExecutionResource instances
 * The id should be the execution id (e.g., "pex-123")
 * The startedByProviderUserId is the stable login email for the user who started
 * the execution, not the generated database provider_user.id.
 * The processPath enables policies like: resource in PF::Process::"finance/purchase-request"
 * The orgUnitPaths are the org unit paths from completed and active steps, enabling policies like:
 *   resource in PF::OrgUnit::"/Finance/"
 *
 * An execution may span multiple org units if steps belong to different departments.
 * Includes both completed steps and current waiting todos.
 */
export class Execution implements ExecutionResource {
  readonly uid: EntityRef
  readonly startedBy?: EntityRef
  readonly startedByRole?: RoleEntity
  readonly process: ProcessEntity
  readonly orgUnits: OrgUnitEntity[]

  constructor(
    id: string,
    startedByProviderUserId: string | null | undefined,
    processPath: string,
    orgUnitPaths: readonly string[],
    startedByRolePath?: string | null | undefined,
  ) {
    this.uid = { type: "PF::Execution", id }
    if (startedByProviderUserId) {
      this.startedBy = { type: "PF::ProviderUser", id: startedByProviderUserId }
    }
    if (startedByRolePath) {
      this.startedByRole = { type: "PF::Role", id: startedByRolePath }
    }
    this.process = { type: "PF::Process", id: processPath }
    // Deduplicate org unit paths
    const uniquePaths = [...new Set(orgUnitPaths)]
    this.orgUnits = uniquePaths.map((path) => ({
      type: "PF::OrgUnit",
      id: path,
    }))
  }
}

/**
 * Role resource for authorization checks (requestRole action)
 * Used to check if a principal can request a specific role
 */
export interface RoleResource extends Resource {
  readonly uid: RoleEntity
}

/**
 * Role resource reference for requestRole authorization checks
 * The id is the role path (e.g., "HR/Manager")
 */
export class RoleRef implements RoleResource {
  readonly uid: RoleEntity

  constructor(rolePath: string) {
    this.uid = { type: "PF::Role", id: rolePath }
  }
}

/**
 * ServiceAccount principal for authorization checks
 * Used for machine-to-machine authentication (e.g., CI systems)
 * Unlike ProviderUserPrincipal, ServiceAccount has no email or orgUnit
 */
export interface ServiceAccountPrincipalType {
  readonly uid: EntityRef // type: "PF::ServiceAccount"
  readonly roles: RoleEntity[]
}

/**
 * ServiceAccount principal for authorization checks
 * Provides a convenient constructor for creating ServiceAccountPrincipal instances
 */
export class ServiceAccountPrincipal implements ServiceAccountPrincipalType {
  readonly uid: EntityRef
  readonly roles: RoleEntity[]

  constructor(id: string, roles: readonly string[] = []) {
    this.uid = { type: "PF::ServiceAccount", id }
    this.roles = roles.map((rolePath) => ({
      type: "PF::Role",
      id: rolePath,
    }))
  }
}

/**
 * GraphQL field resource for authorization checks
 * Used to check if a principal can access a specific GraphQL field
 */
export interface GraphQLFieldResource extends Resource {
  readonly uid: EntityRef // type: "PF::GraphQLField"
  readonly tag: string | undefined
}

/**
 * GraphQL field resource for authorization checks
 * The id is the field name (e.g., "Query.currentProviderUser")
 * The tag enables policies like: resource.tag == "providerUser"
 */
export class GraphQLField implements GraphQLFieldResource {
  readonly uid: EntityRef
  readonly tag: string | undefined

  constructor(fieldName: string, tag?: string) {
    this.uid = { type: "PF::GraphQLField", id: fieldName }
    this.tag = tag
  }
}

/**
 * Feature actions for coarse-grained authorization.
 * These map to Cedar actions defined in schema.cedarschema that target Application.
 */
export type FeatureAction =
  | "administerUsers"
  | "administerOAuthProviders"
  | "administerProjectStageConfig"
  | "recoverProviderUser"
  | "databaseShell"
  | "databaseTransfer"
  | "showProcessState"
  | "viewAuthorization"

/**
 * List resource for authorization checks (query action)
 * Contains the roles that can access this list
 * and the org unit for hierarchy-based policies
 */
export interface ListResource extends Resource {
  readonly uid: EntityRef // type: "PF::List"
  readonly roles: readonly [RoleEntity, ...RoleEntity[]]
  readonly orgUnit: OrgUnitEntity
}

/**
 * List resource for authorization checks
 * Provides a convenient constructor for creating ListResource instances
 * The id should be the list path (e.g., "school/employees")
 * The rolePaths are the roles allowed to access the list
 * The orgUnitId enables policies based on org unit hierarchy
 *
 * If orgUnitId is not provided, it defaults to extracting the first path segment
 * (e.g., "school/employees" -> "school")
 */
export class ListRef implements ListResource {
  readonly uid: EntityRef
  readonly roles: readonly [RoleEntity, ...RoleEntity[]]
  readonly orgUnit: OrgUnitEntity

  constructor(
    id: string,
    rolePaths: NonEmptyReadonlyArray<string>,
    orgUnitId?: string,
  ) {
    this.uid = { type: "PF::List", id }
    const [firstRolePath, ...otherRolePaths] = rolePaths
    this.roles = [
      { type: "PF::Role" as const, id: firstRolePath },
      ...otherRolePaths.map((rolePath) => ({
        type: "PF::Role" as const,
        id: rolePath,
      })),
    ]
    // Default to first path segment if orgUnitId not provided
    const resolvedOrgUnitId = orgUnitId ?? id.split("/")[0] ?? ""
    this.orgUnit = { type: "PF::OrgUnit", id: resolvedOrgUnitId }
  }
}

/**
 * File resource for authorization checks (download action)
 * Contains the provider user who owns the file, the org unit
 * the file belongs to for hierarchy-based policies, and the
 * document store path for store-based policies.
 */
export interface FileResource extends Resource {
  readonly uid: EntityRef // type: "PF::File"
  readonly owner: EntityRef // ProviderUser who uploaded
  readonly orgUnit: OrgUnitEntity
  readonly documentStore: string // Document store path (e.g., "/document-store")
}

/**
 * File resource for authorization checks
 * Provides a convenient constructor for creating FileResource instances
 * The id should be the file ID
 * The ownerId is the provider user who uploaded the file
 * The orgUnitId is the org unit the document store belongs to
 * The documentStore is the document store path for store-based policies
 */
export class FileRef implements FileResource {
  readonly uid: EntityRef
  readonly owner: EntityRef
  readonly orgUnit: OrgUnitEntity
  readonly documentStore: string

  constructor(
    fileId: string,
    ownerId: string,
    orgUnitId: string,
    documentStore: string,
  ) {
    this.uid = { type: "PF::File", id: fileId }
    this.owner = { type: "PF::ProviderUser", id: ownerId }
    this.orgUnit = { type: "PF::OrgUnit", id: orgUnitId }
    this.documentStore = documentStore
  }
}

/** Process model identity with every enclosing organisation path. */
export class ProcessRef implements Resource {
  readonly uid: EntityRef
  readonly parents: readonly OrgUnitEntity[]

  constructor(processPath: string) {
    this.uid = { type: "PF::Process", id: processPath }
    const parts = processPath.split("/").filter(Boolean)
    this.parents = parts.map((_, index) => ({
      type: "PF::OrgUnit",
      id: index === 0 ? "/" : `/${parts.slice(0, index).join("/")}`,
    }))
  }
}
