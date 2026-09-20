import { DateTime, Effect, Either, FiberRef, Layer } from "effect"
import { AuthorizationService } from "@pf/auth-policy"
import { DocumentStoreService } from "@pf/document-store-service"
import { FileOperations } from "@pf/graphql-db-operations"
import { InputValidationError, NotAuthorized } from "@pf/graphql-schema"
import { RequestTime } from "@pf/request-time"
import { requestDatabaseUploadUrl } from "../src/lib/database-transfer"
import type { UserContext } from "../src/lib/types"
import { describe, expect, it } from "bun:test"

const TEST_USER_EMAIL = "operator@example.com"
const DATABASE_TRANSFER_STORE_PATH = "/database-transfer"
const FIXED_REQUEST_TIME = DateTime.unsafeMake("2026-04-06T10:00:00.000Z")

const makeContext = (): UserContext => ({
  _requestTime: FIXED_REQUEST_TIME,
  _userDetails: {
    by: TEST_USER_EMAIL,
    id: TEST_USER_EMAIL,
  } as UserContext["_userDetails"],
  jwt: {
    mode: "access",
    type: "user",
    properties: {
      userId: TEST_USER_EMAIL,
      email: TEST_USER_EMAIL,
      roles: ["/Administrator"],
      orgUnitPath: "/",
      orgUnitId: "/",
    },
    aud: "graphql-api",
    iss: "http://localhost:4020",
    sub: TEST_USER_EMAIL,
    exp: 0,
    iat: 0,
  },
  userId: TEST_USER_EMAIL,
})

type DatabaseTransferState = {
  createdFile: {
    documentStoreId: string
    mimeType: string | undefined
    createdBy: string | undefined
  } | null
  uploadRequest: {
    fileId: string
    storePrefix: string
    contentType: string | undefined
    filename: string | undefined
  } | null
}

const makeState = (): DatabaseTransferState => ({
  createdFile: null,
  uploadRequest: null,
})

const makeFileOperations = (state: DatabaseTransferState) =>
  ({
    createFile: (documentStoreId, mimeType, createdBy) => {
      state.createdFile = { documentStoreId, mimeType, createdBy }
      return Effect.succeed("file-upload-1")
    },
    getFileWithStore: () => Effect.succeed(null),
    markFileUploaded: () => Effect.succeed(undefined),
    getDocumentStoreByPath: (path) =>
      Effect.succeed(
        path === DATABASE_TRANSFER_STORE_PATH
          ? { id: "store-db-transfer", name: "database-transfer" }
          : null,
      ),
    isStepLinkedToDocumentStore: () => Effect.succeed(false),
    getFileOwnerInfo: () => Effect.succeed(null),
    deleteFile: () => Effect.succeed(false),
  }) satisfies FileOperations["Type"]

const makeDocumentStoreService = (state: DatabaseTransferState) =>
  ({
    requestUploadUrl: (opts) => {
      state.uploadRequest = {
        fileId: opts.fileId,
        storePrefix: opts.storePrefix,
        contentType: opts.contentType,
        filename: opts.filename,
      }
      return Effect.succeed({
        fileId: opts.fileId,
        uploadUrl: "https://example.com/upload",
        expiresAt: "2026-04-06T10:15:00.000Z",
      })
    },
    requestDownloadUrl: () =>
      Effect.dieMessage("requestDownloadUrl not used in tests"),
    storeFile: () => Effect.dieMessage("storeFile not used in tests"),
    getFileContent: () => Effect.dieMessage("getFileContent not used in tests"),
    getFileMetadata: () =>
      Effect.dieMessage("getFileMetadata not used in tests"),
    deleteFile: () => Effect.dieMessage("deleteFile not used in tests"),
  }) satisfies DocumentStoreService["Type"]

const makeAuthorizationService = () =>
  ({
    canIssueDelegationSecret: () => Effect.succeed(false),
    canListDelegationTokens: () => Effect.succeed(false),
    canManageDelegation: () => Effect.succeed(false),
    canLogin: () => Effect.succeed(false),
    canCompleteStep: () => Effect.succeed(false),
    canCompleteTodo: () => Effect.succeed(false),
    canCorrectPublicCompletionTodo: () => Effect.succeed(false),
    canCompletePublicTodo: () => Effect.succeed(false),
    canRequestRole: () => Effect.succeed(false),
    canRequestProviderUserPermissions: () => Effect.succeed(false),
    canActOnBehalfOf: () => Effect.succeed(false),
    canViewExecution: () => Effect.succeed(false),
    canRestartExecution: () => Effect.succeed(false),
    canAbandonStep: () => Effect.succeed(false),
    canDraftStep: () => Effect.succeed(false),
    canModifyField: () => Effect.succeed(false),
    canAccessField: () => Effect.succeed(false),
    canAccessFeature: () => Effect.succeed(true),
    canAccessList: () => Effect.succeed(false),
    canCreateList: () => Effect.succeed(false),
    canUpdateList: () => Effect.succeed(false),
    canDeleteList: () => Effect.succeed(false),
    canDownloadFile: () => Effect.succeed(false),
    canDeleteFile: () => Effect.succeed(false),
    canPerformAction: () => Effect.succeed(false),
  }) satisfies AuthorizationService["Type"]

const makeAuthorizationDeniedService = () =>
  ({
    ...makeAuthorizationService(),
    canAccessFeature: () => Effect.succeed(false),
  }) satisfies AuthorizationService["Type"]

const makeLayer = (
  state: DatabaseTransferState,
  options?: { readonly canTransfer?: boolean },
) =>
  Layer.mergeAll(
    Layer.succeed(FileOperations, makeFileOperations(state)),
    Layer.succeed(DocumentStoreService, makeDocumentStoreService(state)),
    Layer.succeed(
      AuthorizationService,
      options?.canTransfer === false
        ? makeAuthorizationDeniedService()
        : makeAuthorizationService(),
    ),
    Layer.succeed(RequestTime, FiberRef.unsafeMake(FIXED_REQUEST_TIME)),
  )

describe("database transfer GraphQL coordination", () => {
  it("requests upload URLs from the dedicated database transfer store", async () => {
    const state = makeState()
    const result = await Effect.runPromise(
      requestDatabaseUploadUrl(
        {
          project: " 0000-0000-0001 ",
          env: " dev ",
          contentType: "application/x-sqlite3",
          filename: "backup.sqlite",
        },
        makeContext(),
      ).pipe(Effect.provide(makeLayer(state))),
    )

    expect(state.createdFile).toEqual({
      documentStoreId: "store-db-transfer",
      mimeType: "application/x-sqlite3",
      createdBy: TEST_USER_EMAIL,
    })
    expect(state.uploadRequest).toEqual({
      fileId: "file-upload-1",
      storePrefix: "database-transfer",
      contentType: "application/x-sqlite3",
      filename: "backup.sqlite",
    })
    expect(result.fileId).toBe("file-upload-1")
    expect(result.target).toEqual({ project: "0000-0000-0001", env: "dev" })
    expect(result.documentStore).toBe(DATABASE_TRANSFER_STORE_PATH)
    expect(result.status).toBe("READY_FOR_UPLOAD")
    expect(result.uploadUrl).toBe("https://example.com/upload")
    expect(result.operationId.length).toBeGreaterThan(0)
  })

  it("rejects upload URL requests without database transfer authorization", async () => {
    const state = makeState()
    const result = await Effect.runPromise(
      Effect.either(
        requestDatabaseUploadUrl(
          { project: "0000-0000-0001", env: "dev" },
          makeContext(),
        ).pipe(Effect.provide(makeLayer(state, { canTransfer: false }))),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(NotAuthorized)
    }
    expect(state.createdFile).toBeNull()
    expect(state.uploadRequest).toBeNull()
  })

  it("defaults upload content type to application/vnd.sqlite3", async () => {
    const state = makeState()
    const result = await Effect.runPromise(
      requestDatabaseUploadUrl(
        { project: "0000-0000-0001", env: "dev" },
        makeContext(),
      ).pipe(Effect.provide(makeLayer(state))),
    )

    expect(state.createdFile?.mimeType).toBe("application/vnd.sqlite3")
    expect(state.uploadRequest?.contentType).toBe("application/vnd.sqlite3")
    expect(result.status).toBe("READY_FOR_UPLOAD")
  })

  it("rejects unsupported database transfer upload content types", async () => {
    const state = makeState()
    const result = await Effect.runPromise(
      Effect.either(
        requestDatabaseUploadUrl(
          {
            project: "0000-0000-0001",
            env: "dev",
            contentType: "application/zip",
          },
          makeContext(),
        ).pipe(Effect.provide(makeLayer(state))),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(InputValidationError)
    }
    expect(state.createdFile).toBeNull()
    expect(state.uploadRequest).toBeNull()
  })
})
