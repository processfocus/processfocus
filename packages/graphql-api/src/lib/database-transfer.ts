import { randomUUID } from "node:crypto"
import type { SqlError } from "@effect/sql/SqlError"
import { Effect } from "effect"
import {
  Application,
  type AuthorizationError,
  AuthorizationService,
  type ProviderUserPrincipal,
  type ServiceAccountPrincipal,
} from "@pf/auth-policy"
import {
  type DocumentStoreError,
  DocumentStoreService,
} from "@pf/document-store-service"
import { FileOperations } from "@pf/graphql-db-operations"
import {
  DocumentStoreNotFoundError,
  InputValidationError,
  type NoProviderUserID,
  NotAuthorized,
} from "@pf/graphql-schema"
import type { RequestTime } from "@pf/request-time"
import { buildPrincipal } from "./authorization"
import { rejectUnsupportedDelegationHandoff } from "./session-guards"
import type { UserContext } from "./types"

const DATABASE_TRANSFER_DOCUMENT_STORE_PATH = "/database-transfer"
const DATABASE_TRANSFER_DEFAULT_CONTENT_TYPE = "application/vnd.sqlite3"
const DATABASE_TRANSFER_ACCEPTED_CONTENT_TYPES = new Set([
  "application/vnd.sqlite3",
  "application/x-sqlite3",
  "application/octet-stream",
])

type DatabaseTransferStatus = "READY_FOR_UPLOAD"

type DatabaseTransferTarget = {
  readonly project: string
  readonly env: string
}

export type DatabaseTransferUploadArgs = DatabaseTransferTarget & {
  readonly contentType?: string | null
  readonly filename?: string | null
}

export type DatabaseTransferUploadRequest = {
  readonly operationId: string
  readonly target: DatabaseTransferTarget
  readonly fileId: string
  readonly documentStore: string
  readonly uploadUrl: string
  readonly expiresAt: string
  readonly status: DatabaseTransferStatus
}

const principalId = (
  principal: ProviderUserPrincipal | ServiceAccountPrincipal,
): string => principal.uid.id

// Target metadata is echoed for CLI correlation. The later snapshot/apply
// operations must enforce project/environment access before mutating state.
const validateTarget = (target: DatabaseTransferTarget) => {
  const project = target.project.trim()
  const env = target.env.trim()
  const errors = [
    ...(project === ""
      ? [{ field: "project", message: "Project is required" }]
      : []),
    ...(env === ""
      ? [{ field: "env", message: "Environment is required" }]
      : []),
  ]

  if (errors.length > 0) {
    return Effect.fail(new InputValidationError({ errors }))
  }

  return Effect.succeed({
    project,
    env,
  })
}

const validateContentType = (contentType: string) => {
  if (DATABASE_TRANSFER_ACCEPTED_CONTENT_TYPES.has(contentType)) {
    return Effect.succeed(contentType)
  }

  return Effect.fail(
    new InputValidationError({
      errors: [
        {
          field: "contentType",
          message: `Unsupported database transfer content type: ${contentType}`,
        },
      ],
    }),
  )
}

const checkDatabaseTransferAuthorization = (
  principal: ProviderUserPrincipal | ServiceAccountPrincipal,
): Effect.Effect<
  void,
  AuthorizationError | NotAuthorized,
  AuthorizationService | RequestTime
> =>
  Effect.gen(function* () {
    const auth = yield* AuthorizationService
    const canTransfer = yield* auth.canAccessFeature(
      principal,
      new Application("default"),
      "databaseTransfer",
    )

    if (!canTransfer) {
      return yield* new NotAuthorized({
        action: "databaseTransfer",
        resource: "default",
        message: `User ${principalId(principal)} is not authorized to coordinate database transfers`,
      })
    }
  })

const databaseTransferStore = Effect.gen(function* () {
  const fileOps = yield* FileOperations
  const store = yield* fileOps.getDocumentStoreByPath(
    DATABASE_TRANSFER_DOCUMENT_STORE_PATH,
  )

  if (!store) {
    return yield* new DocumentStoreNotFoundError({
      path: DATABASE_TRANSFER_DOCUMENT_STORE_PATH,
    })
  }

  return store
})

export const requestDatabaseUploadUrl = (
  args: DatabaseTransferUploadArgs,
  context: UserContext,
): Effect.Effect<
  DatabaseTransferUploadRequest,
  | DocumentStoreError
  | DocumentStoreNotFoundError
  | InputValidationError
  | NoProviderUserID
  | NotAuthorized
  | AuthorizationError
  | SqlError,
  FileOperations | DocumentStoreService | AuthorizationService | RequestTime
> =>
  Effect.gen(function* () {
    yield* rejectUnsupportedDelegationHandoff(
      context.jwt?.properties,
      "database transfer",
    )
    const fileOps = yield* FileOperations
    const docStoreService = yield* DocumentStoreService
    const store = yield* databaseTransferStore
    const principal = yield* buildPrincipal(context)
    yield* checkDatabaseTransferAuthorization(principal)
    const target = yield* validateTarget(args)

    const contentType = yield* validateContentType(
      args.contentType ?? DATABASE_TRANSFER_DEFAULT_CONTENT_TYPE,
    )
    const fileId = yield* fileOps.createFile(
      store.id,
      contentType,
      principalId(principal),
    )

    const upload = yield* docStoreService.requestUploadUrl({
      fileId,
      storePrefix: store.name,
      contentType,
      ...(args.filename != null && { filename: args.filename }),
    })

    return {
      // Correlation-only operation ID; no durable transfer operation exists yet.
      operationId: randomUUID(),
      target,
      fileId: upload.fileId,
      documentStore: DATABASE_TRANSFER_DOCUMENT_STORE_PATH,
      uploadUrl: upload.uploadUrl,
      expiresAt: upload.expiresAt,
      status: "READY_FOR_UPLOAD",
    }
  })
