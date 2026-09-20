/**
 * Stable identity of the hosted CLI/Backend protocol.
 *
 * `HOSTING_CONTRACT_FORMAT` brands the document so an arbitrary JSON payload can
 * never be mistaken for a hosting-contract manifest. `HOSTING_CONTRACT_MAJOR` is
 * the negotiated compatibility major: a Backend and a CLI are compatible only
 * when their majors match, and the Backend may advertise additive capabilities
 * on top of a shared major without bumping it.
 */
export const HOSTING_CONTRACT_FORMAT = "processfocus/hosting-contract"

/**
 * Version of the manifest document's own serialized shape. It is independent of
 * the protocol major and changes only when the manifest's envelope changes.
 */
export const HOSTING_CONTRACT_FORMAT_VERSION = 1

/**
 * The compatibility major this package implements.
 */
export const HOSTING_CONTRACT_MAJOR = 1

/**
 * The ten hosted CLI areas covered by the contract.
 */
export const HOSTED_CAPABILITIES = [
  "auth",
  "projects",
  "deploy",
  "logs",
  "database",
  "domains",
  "config",
  "stages",
  "environments",
  "role-grants",
] as const

export type HostedCapability = (typeof HOSTED_CAPABILITIES)[number]

export type HostedOperationKind = "query" | "mutation"

export interface HostedOperationDocument {
  readonly id: string
  readonly capability: HostedCapability
  readonly kind: HostedOperationKind
  readonly graphqlField: string
  readonly description: string
}

/**
 * The canonical operation inventory. Every hosted command the CLI can issue maps
 * to exactly one operation here, which is how the private Backend proves it
 * implements the full contract (see `src/lib/conformance-fixture.ts`).
 *
 * Capability "deploy" owns both deploy start and progress; progress is a
 * subscription over the shared transport, so it is listed as a separate
 * transport operation scoped to the deploy capability.
 */
export const HOSTED_OPERATIONS = {
  "auth/request-provider-user-permissions": {
    id: "auth/request-provider-user-permissions",
    capability: "auth",
    kind: "mutation",
    graphqlField: "requestProviderUserPermissions",
    description:
      "Request a short-lived provider-user permissions code for login.",
  },
  "projects/list": {
    id: "projects/list",
    capability: "projects",
    kind: "query",
    graphqlField: "listProjects",
    description: "List hosted projects for the authenticated provider user.",
  },
  "deploy/request-upload-url": {
    id: "deploy/request-upload-url",
    capability: "deploy",
    kind: "mutation",
    graphqlField: "requestUploadUrl",
    description: "Request a presigned upload URL for a deployment artifact.",
  },
  "deploy/start": {
    id: "deploy/start",
    capability: "deploy",
    kind: "mutation",
    graphqlField: "startOperationsDeploy",
    description: "Start a hosted deployment for a project environment.",
  },
  "deploy/frontend-url": {
    id: "deploy/frontend-url",
    capability: "deploy",
    kind: "query",
    graphqlField: "getDnsRecords",
    description: "Resolve the frontend URL and DNS records for a deployment.",
  },
  "deploy/transport": {
    id: "deploy/transport",
    capability: "deploy",
    kind: "query",
    graphqlField: "subscriptionTransport",
    description:
      "Negotiate the subscription transport used for deploy progress.",
  },
  "logs/get-runtime-logs": {
    id: "logs/get-runtime-logs",
    capability: "logs",
    kind: "query",
    graphqlField: "getRuntimeLogs",
    description: "Read recent runtime logs for an environment.",
  },
  "database/create-download-session": {
    id: "database/create-download-session",
    capability: "database",
    kind: "mutation",
    graphqlField: "createDatabaseDownloadSession",
    description: "Create a database download session.",
  },
  "database/request-upload-url": {
    id: "database/request-upload-url",
    capability: "database",
    kind: "mutation",
    graphqlField: "requestDatabaseUploadUrl",
    description: "Request a presigned upload URL for a database backup.",
  },
  "database/start-upload": {
    id: "database/start-upload",
    capability: "database",
    kind: "mutation",
    graphqlField: "startOperationsUploadDb",
    description: "Start a hosted database upload.",
  },
  "database/start-rollback": {
    id: "database/start-rollback",
    capability: "database",
    kind: "mutation",
    graphqlField: "startOperationsRollbackDb",
    description: "Start a hosted database rollback.",
  },
  "database/create-shell-session": {
    id: "database/create-shell-session",
    capability: "database",
    kind: "mutation",
    graphqlField: "createDatabaseShellSession",
    description: "Create a database shell session.",
  },
  "database/delete-file": {
    id: "database/delete-file",
    capability: "database",
    kind: "mutation",
    graphqlField: "deleteFile",
    description: "Delete a previously uploaded database file.",
  },
  "domains/get-dns-records": {
    id: "domains/get-dns-records",
    capability: "domains",
    kind: "query",
    graphqlField: "getDnsRecords",
    description: "Read DNS records and certificate status for a custom domain.",
  },
  "config/get": {
    id: "config/get",
    capability: "config",
    kind: "query",
    graphqlField: "getConfigParameter",
    description: "Read one config parameter for a project stage.",
  },
  "config/set": {
    id: "config/set",
    capability: "config",
    kind: "mutation",
    graphqlField: "setConfigParameter",
    description: "Set a config parameter for a project stage.",
  },
  "config/list": {
    id: "config/list",
    capability: "config",
    kind: "query",
    graphqlField: "listConfigParameters",
    description: "List config parameters for a project stage.",
  },
  "config/delete": {
    id: "config/delete",
    capability: "config",
    kind: "mutation",
    graphqlField: "deleteConfigParameter",
    description: "Delete a config parameter for a project stage.",
  },
  "config/copy-new": {
    id: "config/copy-new",
    capability: "config",
    kind: "mutation",
    graphqlField: "copyNewConfigParameters",
    description: "Copy config parameters absent from a target stage.",
  },
  "stages/list": {
    id: "stages/list",
    capability: "stages",
    kind: "query",
    graphqlField: "listProjectStages",
    description: "List stages for a project.",
  },
  "stages/add": {
    id: "stages/add",
    capability: "stages",
    kind: "mutation",
    graphqlField: "startOperationsAddStage",
    description: "Start a hosted stage creation.",
  },
  "environments/list": {
    id: "environments/list",
    capability: "environments",
    kind: "query",
    graphqlField: "listProjectEnvironments",
    description: "List environments for a project stage.",
  },
  "environments/add": {
    id: "environments/add",
    capability: "environments",
    kind: "mutation",
    graphqlField: "startOperationsAddEnvironment",
    description: "Start a hosted environment creation.",
  },
  "environments/destroy": {
    id: "environments/destroy",
    capability: "environments",
    kind: "mutation",
    graphqlField: "startOperationsDestroyEnvironment",
    description: "Start hosted environment destruction.",
  },
  "role-grants/grant": {
    id: "role-grants/grant",
    capability: "role-grants",
    kind: "mutation",
    graphqlField: "grantProjectUserRole",
    description: "Grant a provider user a role in an environment.",
  },
  "role-grants/registration-link": {
    id: "role-grants/registration-link",
    capability: "role-grants",
    kind: "mutation",
    graphqlField: "generateProjectRegistrationLink",
    description:
      "Mint or rotate an Invitation Registration Link, or explicitly authorized account recovery link, in an environment.",
  },
} as const satisfies Readonly<Record<string, HostedOperationDocument>>

export type HostedOperationId = keyof typeof HOSTED_OPERATIONS

export const HOSTED_OPERATION_IDS = Object.keys(
  HOSTED_OPERATIONS,
) as readonly HostedOperationId[]

export interface HostingContractManifest {
  readonly format: typeof HOSTING_CONTRACT_FORMAT
  readonly version: typeof HOSTING_CONTRACT_FORMAT_VERSION
  readonly major: number
  readonly capabilities: ReadonlyArray<HostedCapability>
}

export const SUPPORTED_OPERATION_IDS_BY_CAPABILITY: Readonly<
  Record<HostedCapability, readonly HostedOperationId[]>
> = (() => {
  const grouped = Object.fromEntries(
    HOSTED_CAPABILITIES.map((capability) => [
      capability,
      [] as HostedOperationId[],
    ]),
  ) as Record<HostedCapability, HostedOperationId[]>

  for (const operationId of HOSTED_OPERATION_IDS) {
    grouped[HOSTED_OPERATIONS[operationId].capability].push(operationId)
  }

  return grouped
})()
