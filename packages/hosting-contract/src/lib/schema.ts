import { Schema } from "effect"

/**
 * Typed `effect/Schema` operation documents and response schemas for the hosted
 * protocol. These are the machine-readable "operation documents" the CLI and the
 * private Backend use to validate one another's payloads against the contract.
 */

// --- Shared primitives ------------------------------------------------------

/** A stable execution identifier returned when starting a hosted operation. */
export const ExecutionStart = Schema.Struct({
  executionId: Schema.String,
  processPath: Schema.String,
})

export const SubscriptionTransportKind = Schema.Literal(
  "GRAPHQL_WS",
  "APPSYNC_EVENTS",
)

export const SubscriptionTransport = Schema.Struct({
  kind: SubscriptionTransportKind,
  /** Null when kind is "GRAPHQL_WS". */
  appSyncEventsHttpHost: Schema.NullOr(Schema.String),
})

// --- auth -------------------------------------------------------------------

export const RequestProviderUserPermissions = Schema.Struct({
  requestProviderUserPermissions: Schema.Struct({
    success: Schema.Boolean,
    error: Schema.optionalWith(Schema.NullOr(Schema.String), { exact: true }),
  }),
})

// --- projects ---------------------------------------------------------------

export const ProjectItem = Schema.Struct({
  projectNumber: Schema.String,
  projectName: Schema.String,
})

export const ListProjects = Schema.Struct({
  listProjects: Schema.Struct({
    items: Schema.Array(ProjectItem),
    totalCount: Schema.Number,
  }),
})

// --- deploy -----------------------------------------------------------------

export const RequestUploadUrl = Schema.Struct({
  requestUploadUrl: Schema.Struct({
    fileId: Schema.String,
    uploadUrl: Schema.String,
    expiresAt: Schema.optional(Schema.String),
  }),
})

export const StartDeploy = Schema.Struct({
  startOperationsDeploy: ExecutionStart,
})

export const DnsRecord = Schema.Struct({
  type: Schema.String,
  name: Schema.String,
  value: Schema.String,
  purpose: Schema.String,
})

export const DnsRecords = Schema.Struct({
  getDnsRecords: Schema.Struct({
    defaultDomain: Schema.optional(Schema.String),
    frontendUrl: Schema.String,
    frontendUrlNote: Schema.Union(Schema.Null, Schema.String),
    customDomain: Schema.Union(Schema.Null, Schema.String),
    certificateStatus: Schema.Union(Schema.Null, Schema.String),
    warnings: Schema.Array(Schema.String),
    validationRecords: Schema.Array(DnsRecord),
    validationNote: Schema.Union(Schema.Null, Schema.String),
    siteAccessRecord: Schema.Union(Schema.Null, DnsRecord),
    siteAccessNote: Schema.Union(Schema.Null, Schema.String),
    postscriptNotes: Schema.Array(Schema.String),
  }),
})

export const SubscriptionTransportResponse = Schema.Struct({
  subscriptionTransport: SubscriptionTransport,
})

export const DeployProgressStatus = Schema.Literal(
  "progress",
  "completed",
  "failed",
)

export const DeployProgressEvent = Schema.Struct({
  version: Schema.Literal(1),
  executionId: Schema.String,
  phase: Schema.String,
  status: DeployProgressStatus,
  message: Schema.String,
  timestamp: Schema.String,
})

// --- logs -------------------------------------------------------------------

export const RuntimeLogEvent = Schema.Struct({
  timestamp: Schema.String,
  message: Schema.String,
})

export const RuntimeLogTarget = Schema.Literal("PRIMARY", "CANARY")

export const GetRuntimeLogs = Schema.Struct({
  getRuntimeLogs: Schema.Struct({
    events: Schema.Array(RuntimeLogEvent),
  }),
})

// --- database operations ----------------------------------------------------

export const DATABASE_UPLOAD_MODES = ["data-copy", "exact-restore"] as const
export const DatabaseUploadMode = Schema.Literal(...DATABASE_UPLOAD_MODES)
export type DatabaseUploadMode = typeof DatabaseUploadMode.Type

export const DatabaseDownloadSession = Schema.Struct({
  createDatabaseDownloadSession: Schema.Struct({
    databaseUrl: Schema.String,
    authToken: Schema.String,
    databaseName: Schema.String,
    engine: Schema.Literal("libsql", "tursodb"),
    target: Schema.Struct({ stageName: Schema.String }),
  }),
})

export const RequestDatabaseUploadUrl = Schema.Struct({
  requestDatabaseUploadUrl: Schema.Struct({
    operationId: Schema.String,
    fileId: Schema.String,
    documentStore: Schema.String,
    uploadUrl: Schema.String,
    expiresAt: Schema.optional(Schema.String),
    status: Schema.String,
    target: Schema.Struct({
      project: Schema.String,
      env: Schema.String,
    }),
  }),
})

export const StartUploadDb = Schema.Struct({
  startOperationsUploadDb: ExecutionStart,
})

export const StartRollbackDb = Schema.Struct({
  startOperationsRollbackDb: ExecutionStart,
})

export const DeleteFile = Schema.Struct({
  deleteFile: Schema.Struct({ success: Schema.Boolean }),
})

export const DatabaseShellSession = Schema.Struct({
  createDatabaseShellSession: Schema.Struct({
    databaseUrl: Schema.String,
    authToken: Schema.String,
    expiresAt: Schema.String,
    databaseName: Schema.String,
  }),
})

// --- config -----------------------------------------------------------------

export const ConfigParameter = Schema.Struct({
  name: Schema.String,
  value: Schema.Union(Schema.Null, Schema.String),
  isSecret: Schema.Boolean,
})

export const GetConfigParameter = Schema.Struct({
  getConfigParameter: Schema.Union(Schema.Null, ConfigParameter),
})

export const ListConfigParameters = Schema.Struct({
  listConfigParameters: Schema.Struct({
    items: Schema.Array(ConfigParameter),
  }),
})

export const SetConfigParameter = Schema.Struct({
  setConfigParameter: Schema.Boolean,
})

export const DeleteConfigParameter = Schema.Struct({
  deleteConfigParameter: Schema.Boolean,
})

export const CopyNewConfigParameters = Schema.Struct({
  copyNewConfigParameters: Schema.Struct({
    copiedCount: Schema.Number,
    copiedKeys: Schema.Array(Schema.String),
    sameStage: Schema.Boolean,
    skippedCount: Schema.Number,
  }),
})

// --- stages -----------------------------------------------------------------

export const StageItem = Schema.Struct({
  stageName: Schema.String,
})

export const ListProjectStages = Schema.Struct({
  listProjectStages: Schema.Struct({
    items: Schema.Array(StageItem),
  }),
})

export const StartAddStage = Schema.Struct({
  startOperationsAddStage: ExecutionStart,
})

// --- environments -----------------------------------------------------------

export const EnvironmentItem = Schema.Struct({
  environmentName: Schema.String,
  stageName: Schema.String,
})

export const ListProjectEnvironments = Schema.Struct({
  listProjectEnvironments: Schema.Struct({
    items: Schema.Array(EnvironmentItem),
  }),
})

export const StartAddEnvironment = Schema.Struct({
  startOperationsAddEnvironment: ExecutionStart,
})

export const StartDestroyEnvironment = Schema.Struct({
  startOperationsDestroyEnvironment: ExecutionStart,
})

// --- role grants ------------------------------------------------------------

export const GrantProjectUserRole = Schema.Struct({
  grantProjectUserRole: Schema.Struct({
    success: Schema.Boolean,
    email: Schema.String,
    rolePath: Schema.String,
    alreadyHadRole: Schema.Boolean,
    error: Schema.optionalWith(Schema.NullOr(Schema.String), { exact: true }),
  }),
})

export const GenerateProjectRegistrationLink = Schema.Struct({
  generateProjectRegistrationLink: Schema.Union(
    Schema.Struct({
      __typename: Schema.Literal("ProjectRegistrationLinkSuccess"),
      email: Schema.String,
      registrationLinkUrl: Schema.String,
      expiresAt: Schema.String,
    }),
    Schema.Struct({
      __typename: Schema.Literal("ProjectRegistrationLinkFailure"),
      error: Schema.String,
    }),
  ),
})
