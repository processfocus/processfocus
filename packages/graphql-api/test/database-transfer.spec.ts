import { DocumentStoreService } from "@processfocus/runtime"
import type { Context } from "effect"
import { DateTime, Effect, Layer, Result } from "effect"
import { AuthorizationService } from "@pf/auth-policy"
import { FileOperations } from "@pf/graphql-db-operations"
import { InputValidationError, NotAuthorized } from "@pf/graphql-schema"
import { RequestTime } from "@pf/request-time"
import { requestDatabaseUploadUrl } from "../src/lib/database-transfer"
import type { UserContext } from "../src/lib/types"
import { describe, expect, it } from "bun:test"

const TEST_USER_EMAIL = "operator@example.com"
const DATABASE_TRANSFER_STORE_PATH = "/database-transfer"
const FIXED_REQUEST_TIME = DateTime.makeUnsafe("2026-04-06T10:00:00.000Z")

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
  }) satisfies Context.Service.Shape<typeof FileOperations>

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
      Effect.die("requestDownloadUrl not used in tests"),
    storeFile: () => Effect.die("storeFile not used in tests"),
    getFileContent: () => Effect.die("getFileContent not used in tests"),
    getFileMetadata: () => Effect.die("getFileMetadata not used in tests"),
    deleteFile: () => Effect.die("deleteFile not used in tests"),
  }) satisfies Context.Service.Shape<typeof DocumentStoreService>

const makeAuthorizationService = () =>
  ({
    canIssueDelegationSecret: () => Effect.succeed(false),
    canListDelegationTokens: () => Effect.succeed(false),
    canManageDelegation: () => Effect.succeed(false),
    canLogin: () => Effect.succeed(false),
    policyVersion: Effect.succeed("test-policy"),
    canCompleteStep: () => Effect.succeed(false),
    canViewEmbeddedForm: () => Effect.succeed(false),
    canCorrectPublicCompletionTodo: () => Effect.succeed(false),
    canRequestRole: () => Effect.succeed(false),
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
  }) satisfies Context.Service.Shape<typeof AuthorizationService>

const makeAuthorizationDeniedService = () =>
  ({
    ...makeAuthorizationService(),
    canAccessFeature: () => Effect.succeed(false),
  }) satisfies Context.Service.Shape<typeof AuthorizationService>

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
    Layer.succeed(RequestTime, FIXED_REQUEST_TIME),
  )

describe("database transfer GraphQL coordination", () => {
  it("passes the earlier workload/JWT deadline to storage and rejects an overlong capability", async () => {
    const context = makeContext()
    const deadline = Math.floor(Date.now() / 1000) * 1000 + 60_000
    context.jwt!.exp = deadline / 1000
    context.jwt!.properties = {
      ...context.jwt!.properties,
      workload: {
        clientId: "ci",
        machineUserId: "machine",
        bindingId: "binding",
        repositoryId: "123",
        repositoryOwnerId: "456",
        workflowRef: "workflow",
        ref: "refs/heads/trunk",
        event: "push",
        environment: "test",
        sha: "abc",
        runId: "789",
        runAttempt: "1",
        expiresAt: deadline + 60_000,
      },
    }
    for (const overlong of [false, true]) {
      const state = makeState()
      const store = {
        ...makeDocumentStoreService(state),
        requestUploadUrl: (
          opts: Parameters<
            Context.Service.Shape<
              typeof DocumentStoreService
            >["requestUploadUrl"]
          >[0],
        ) => {
          expect(opts.expiresAt).toBe(deadline)
          return Effect.succeed({
            fileId: opts.fileId,
            uploadUrl: "https://example.com/upload",
            expiresAt: new Date(deadline + (overlong ? 1000 : 0)).toISOString(),
          })
        },
      }
      const request = Effect.runPromise(
        requestDatabaseUploadUrl(
          { project: "project", env: "dev" },
          context,
        ).pipe(
          Effect.provideService(DocumentStoreService, store),
          Effect.provide(makeLayer(state)),
        ),
      )
      if (overlong)
        await expect(request).rejects.toThrow("exceeds workload deadline")
      else
        expect((await request).expiresAt).toBe(new Date(deadline).toISOString())
    }
  })

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
      Effect.result(
        requestDatabaseUploadUrl(
          { project: "0000-0000-0001", env: "dev" },
          makeContext(),
        ).pipe(Effect.provide(makeLayer(state, { canTransfer: false }))),
      ),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(NotAuthorized)
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
      Effect.result(
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

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(InputValidationError)
    }
    expect(state.createdFile).toBeNull()
    expect(state.uploadRequest).toBeNull()
  })
})
