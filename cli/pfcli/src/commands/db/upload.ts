import { readFileSync, statSync } from "node:fs"
import { basename, resolve } from "node:path"
import type { DatabaseUploadMode } from "@processfocus/hosting-contract"
import { Console, Effect } from "effect"
import { CliError } from "../../errors"
import {
  buildExecutionEventSource,
  closeExecutionEventSource,
} from "../../utils/execution-event-source"
import { createExecutionEventSource } from "../../utils/execution-subscription"
import {
  extractExecutionFailureMessage,
  waitForExecutionToFinish,
} from "../../utils/execution-wait"
import {
  graphqlRequest,
  readCredentialsOrFail,
  resolveGraphqlEndpoint,
} from "../../utils/graphql-client"
import { ensureKnownEnvironmentName } from "../../utils/remote-name-validation"
import { formatStructuredLogLine } from "../../utils/structured-log"
import {
  SUBSCRIPTION_TRANSPORT_QUERY,
  type SubscriptionTransportResponse,
} from "../../utils/subscription-transport"

const REQUEST_DATABASE_UPLOAD_URL_MUTATION = `
  mutation RequestDatabaseUploadUrl($project: String!, $env: String!, $contentType: String, $filename: String) {
    requestDatabaseUploadUrl(project: $project, env: $env, contentType: $contentType, filename: $filename) {
      operationId
      fileId
      documentStore
      uploadUrl
      expiresAt
      status
      target {
        project
        env
      }
    }
  }
`

const START_UPLOAD_DB_MUTATION = `
  mutation StartUploadDb($projectId: String!, $environmentId: String!, $fileId: String!, $mode: String!) {
    startOperationsUploadDb(input: { projectId: $projectId, environmentId: $environmentId, fileId: $fileId, mode: $mode }) {
      executionId
      processPath
    }
  }
`

const DELETE_FILE_MUTATION = `
  mutation DeleteDatabaseUploadArtifact($fileId: ID!) {
    deleteFile(fileId: $fileId) {
      success
    }
  }
`

const DATABASE_UPLOAD_CONTENT_TYPE = "application/vnd.sqlite3"
const SQLITE_DATABASE_HEADER = Buffer.from("SQLite format 3\u0000", "binary")
const UPLOAD_WAIT_TIMEOUT_MS = 15 * 60 * 1000
const UPLOAD_WAIT_HEARTBEAT_MS = 10 * 1000

interface RequestDatabaseUploadUrlResponse {
  readonly requestDatabaseUploadUrl: {
    readonly operationId: string
    readonly fileId: string
    readonly documentStore: string
    readonly uploadUrl: string
    readonly expiresAt: string
    readonly status: string
    readonly target: {
      readonly project: string
      readonly env: string
    }
  }
}

interface DeleteFileResponse {
  readonly deleteFile: {
    readonly success: boolean
  }
}

interface StartUploadDbResponse {
  readonly startOperationsUploadDb: {
    readonly executionId: string
    readonly processPath: string
  }
}

export interface UploadDbResult {
  readonly operationId: string
  readonly fileId: string
  readonly executionId: string
  readonly mode: DatabaseUploadMode
  readonly status: "APPLIED"
}

interface UploadFileInput {
  readonly bytes: Buffer
  readonly filename: string
  readonly inputPath: string
}

interface RunUploadDbDependencies {
  readonly createExecutionEventSource?: typeof createExecutionEventSource
  readonly fetch?: typeof fetch
  readonly mode?: DatabaseUploadMode
}

const formatLocalTimestamp = (now = Date.now()): string => {
  const date = new Date(now)
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`
}

const formatUploadLogMessage = (message: string, now = Date.now()): string =>
  `[${formatLocalTimestamp(now)}] ${message}`

const readSqliteFileForUpload = (
  inputPath: string,
): Effect.Effect<UploadFileInput, CliError> =>
  Effect.gen(function* () {
    const resolvedPath = resolve(inputPath)
    const stats = yield* Effect.try({
      try: () => statSync(resolvedPath),
      catch: (cause) =>
        new CliError({
          message: `Database upload input not found or unreadable: ${resolvedPath}`,
          cause,
        }),
    })

    if (!stats.isFile()) {
      return yield* new CliError({
        message: `Database upload input must be a regular file: ${resolvedPath}`,
      })
    }

    if (stats.size === 0) {
      return yield* new CliError({
        message: `Database upload input is empty: ${resolvedPath}`,
      })
    }

    const bytes = yield* Effect.try({
      try: () => readFileSync(resolvedPath),
      catch: (cause) =>
        new CliError({
          message: `Failed to read database upload input: ${resolvedPath}`,
          cause,
        }),
    })

    if (
      !bytes
        .subarray(0, SQLITE_DATABASE_HEADER.length)
        .equals(SQLITE_DATABASE_HEADER)
    ) {
      return yield* new CliError({
        message: `Database upload input does not look like a SQLite database: ${resolvedPath}`,
      })
    }

    return {
      bytes,
      filename: basename(resolvedPath) || "database.sqlite",
      inputPath: resolvedPath,
    }
  })

const uploadDatabaseArtifact = (
  url: string,
  bytes: Buffer,
  fetchImpl: typeof fetch,
): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImpl(url, {
          method: "PUT",
          headers: {
            "Content-Length": String(bytes.length),
            "Content-Type": DATABASE_UPLOAD_CONTENT_TYPE,
          },
          body: bytes,
        }),
      catch: (cause) =>
        new CliError({
          message: "Failed to upload database artifact",
          cause,
        }),
    })

    if (!response.ok) {
      return yield* new CliError({
        message: `Database artifact upload failed with ${response.status}`,
      })
    }
  })

const cleanupDatabaseUploadArtifact = (
  endpoint: string,
  accessToken: string,
  fileId: string,
): Effect.Effect<void> =>
  graphqlRequest<DeleteFileResponse>(
    endpoint,
    accessToken,
    DELETE_FILE_MUTATION,
    { fileId },
  ).pipe(
    Effect.asVoid,
    Effect.catchTag("CliError", () =>
      Console.error(
        `Warning: database transfer artifact cleanup failed for file ${fileId}.`,
      ),
    ),
  )

export const runUploadDb = (
  projectId: string,
  environmentId: string,
  inputPath: string,
  dependencies: RunUploadDbDependencies = {},
): Effect.Effect<UploadDbResult, CliError> => {
  const fetchImpl = dependencies.fetch ?? fetch
  const mode = dependencies.mode ?? "data-copy"
  const createExecutionEventSourceImpl =
    dependencies.createExecutionEventSource ?? createExecutionEventSource

  return Effect.gen(function* () {
    const uploadFile = yield* readSqliteFileForUpload(inputPath)
    const credentials = yield* readCredentialsOrFail()
    const endpoint = resolveGraphqlEndpoint(credentials.baseUrl)

    yield* ensureKnownEnvironmentName(projectId, environmentId)

    const uploadInfo = yield* graphqlRequest<RequestDatabaseUploadUrlResponse>(
      endpoint,
      credentials.accessToken,
      REQUEST_DATABASE_UPLOAD_URL_MUTATION,
      {
        project: projectId,
        env: environmentId,
        contentType: DATABASE_UPLOAD_CONTENT_TYPE,
        filename: uploadFile.filename,
      },
    )
    const uploadRequest = uploadInfo.requestDatabaseUploadUrl

    yield* Console.log(
      formatStructuredLogLine("Database upload transfer ready", {
        operationId: uploadRequest.operationId,
        fileId: uploadRequest.fileId,
        documentStore: uploadRequest.documentStore,
        inputPath: uploadFile.inputPath,
        byteSize: uploadFile.bytes.length,
        mode,
        status: uploadRequest.status,
      }),
    )

    yield* uploadDatabaseArtifact(
      uploadRequest.uploadUrl,
      uploadFile.bytes,
      fetchImpl,
    ).pipe(
      Effect.catchAll((error) =>
        cleanupDatabaseUploadArtifact(
          endpoint,
          credentials.accessToken,
          uploadRequest.fileId,
        ).pipe(Effect.flatMap(() => Effect.fail(error))),
      ),
    )

    let applyStarted = false

    return yield* Effect.gen(function* () {
      const subscriptionTransport =
        yield* graphqlRequest<SubscriptionTransportResponse>(
          endpoint,
          credentials.accessToken,
          SUBSCRIPTION_TRANSPORT_QUERY,
          {},
        )

      const executionEventSource = yield* buildExecutionEventSource({
        credentials,
        subscriptionTransport: subscriptionTransport.subscriptionTransport,
        missingUserIdMessage:
          "CLI access token is missing userId/sub claims required for upload subscriptions.",
        createExecutionEventSourceImpl,
      })

      const closeEventSource = closeExecutionEventSource(
        executionEventSource,
        "Failed to close upload execution subscription.",
      )

      return yield* Effect.gen(function* () {
        const startResult = yield* graphqlRequest<StartUploadDbResponse>(
          endpoint,
          credentials.accessToken,
          START_UPLOAD_DB_MUTATION,
          {
            projectId,
            environmentId,
            fileId: uploadRequest.fileId,
            mode,
          },
        )

        applyStarted = true
        const executionId = startResult.startOperationsUploadDb.executionId

        yield* Console.log(
          formatStructuredLogLine("Database upload started", {
            executionId,
            operationId: uploadRequest.operationId,
            fileId: uploadRequest.fileId,
            inputPath: uploadFile.inputPath,
            mode,
          }),
        )

        const waitStartedAt = Date.now()
        yield* Effect.sync(() =>
          process.stdout.write(
            formatUploadLogMessage(
              "Waiting for database upload to apply...",
              waitStartedAt,
            ),
          ),
        )

        const terminalExecution = yield* waitForExecutionToFinish(
          executionEventSource,
          executionId,
          {
            executionLabel: "database upload",
            timeoutMs: UPLOAD_WAIT_TIMEOUT_MS,
            heartbeatMs: UPLOAD_WAIT_HEARTBEAT_MS,
            hasPendingInitialLine: true,
            formatLogMessage: formatUploadLogMessage,
          },
        )

        if (terminalExecution.status !== "Completed") {
          return yield* new CliError({
            message:
              extractExecutionFailureMessage(terminalExecution) ??
              `Database upload ${terminalExecution.status.toLowerCase()}.`,
          })
        }

        yield* Console.log(
          formatStructuredLogLine("Database upload applied", {
            executionId,
            operationId: uploadRequest.operationId,
            fileId: uploadRequest.fileId,
            inputPath: uploadFile.inputPath,
            mode,
            status: "APPLIED",
          }),
        )

        return {
          operationId: uploadRequest.operationId,
          executionId,
          fileId: uploadRequest.fileId,
          mode,
          status: "APPLIED" as const,
        }
      }).pipe(Effect.ensuring(closeEventSource))
    }).pipe(
      Effect.catchAll((error) => {
        if (applyStarted) {
          return Effect.fail(error)
        }

        return cleanupDatabaseUploadArtifact(
          endpoint,
          credentials.accessToken,
          uploadRequest.fileId,
        ).pipe(Effect.flatMap(() => Effect.fail(error)))
      }),
    )
  })
}
