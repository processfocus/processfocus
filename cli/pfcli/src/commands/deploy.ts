import { randomUUID } from "node:crypto"
import { readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Console, Effect, Result, Schema } from "effect"
import { CliError } from "../errors"
import { prepareDeploymentArtifact } from "../prepare-deployment-artifact"
import {
  GRAPHQL_AUDIENCE,
  parseAccessTokenAudience,
  parseAccessTokenUserId,
} from "../utils/access-token"
import {
  acquireAccessToken,
  isWorkloadAuthenticationFailure,
} from "../utils/credentials"
import {
  DEPLOY_PROGRESS_CONNECTION_LOST_MESSAGE,
  DeployProgressTransportError,
  createDeployProgressEventSource,
} from "../utils/deploy-progress-subscription"
import type {
  DeployProgressEvent,
  DeployProgressEventSource,
} from "../utils/deploy-progress-subscription.types"
import {
  buildExecutionEventSource,
  closeExecutionEventSource,
} from "../utils/execution-event-source"
import { formatExecutionLogMessage } from "../utils/execution-log-format"
import { fetchExecutionSnapshot } from "../utils/execution-snapshot"
import {
  type ExecutionEventSource,
  type ExecutionSnapshot,
  createExecutionEventSource,
} from "../utils/execution-subscription"
import {
  extractExecutionFailureMessage,
  waitForExecutionToFinish,
} from "../utils/execution-wait"
import {
  graphqlRequest,
  graphqlRequestWithCredentials,
  readCredentialsOrFail,
  resolveGraphqlEndpoint,
} from "../utils/graphql-client"
import { ensureKnownEnvironmentName } from "../utils/remote-name-validation"
import { writeStartReceipt } from "../utils/start-receipt"
import { formatStructuredLogLine } from "../utils/structured-log"
import {
  SUBSCRIPTION_TRANSPORT_QUERY,
  type SubscriptionTransportResponse,
} from "../utils/subscription-transport"

declare const PFCLI_DISTRIBUTION_BUILD: boolean

export { prepareDeploymentArtifact } from "../prepare-deployment-artifact"

const REQUEST_UPLOAD_URL_MUTATION = `
  mutation RequestUploadUrl($stepPath: String!, $documentStore: String!, $contentType: String, $filename: String) {
    requestUploadUrl(stepPath: $stepPath, documentStore: $documentStore, contentType: $contentType, filename: $filename) {
      fileId
      uploadUrl
      expiresAt
    }
  }
`

// Omit the new input field entirely against Backends with the older schema.
const startDeployMutation = (selectSource: boolean) => `
  mutation StartDeploy($projectId: String!, $environmentId: String!, $fileId: String!, $platformRef: String!, $executionId: ID${selectSource ? ", $platformSource: String!" : ""}) {
    startOperationsDeploy(input: { projectId: $projectId, environmentId: $environmentId, fileId: $fileId, platformRef: $platformRef${selectSource ? ", platformSource: $platformSource" : ""} }, executionId: $executionId) {
      executionId
      processPath
    }
  }
`

const ACTIVE_DEPLOY_QUERY = `
  query ActiveDeploy($projectId: String!, $environmentId: String!) {
    activeDeploy(projectId: $projectId, environmentId: $environmentId) {
      executionId
      status
    }
  }
`

const ActiveDeployResponse = Schema.Struct({
  activeDeploy: Schema.NullOr(
    Schema.Struct({ executionId: Schema.String, status: Schema.String }),
  ),
})

const DEPLOY_RECEIPT_QUERY = `
  query DeployReceipt($projectId: String!, $environmentId: String!, $executionId: ID!) {
    deployReceipt(projectId: $projectId, environmentId: $environmentId, executionId: $executionId)
  }
`

const DeployReceiptResponse = Schema.Struct({
  deployReceipt: Schema.NullOr(
    Schema.Literals(["NOT_STARTED", "ABANDONED", "FAILED", "SUCCEEDED"]),
  ),
})

const decodeActiveDeploy = (response: unknown) =>
  Schema.decodeUnknownEffect(ActiveDeployResponse)(response).pipe(
    Effect.map(({ activeDeploy }) => activeDeploy),
    Effect.mapError(
      (cause) =>
        new CliError({
          message: "Invalid deployment status from Backend",
          cause,
        }),
    ),
  )

const showDeployTarget = (projectId: string, environmentId: string) =>
  `project ${projectId}, environment ${environmentId}`

export const runDeployStatus = (
  projectId: string,
  environmentId: string,
): Effect.Effect<void, CliError> =>
  graphqlRequestWithCredentials<unknown>(ACTIVE_DEPLOY_QUERY, {
    projectId,
    environmentId,
  }).pipe(
    Effect.flatMap(decodeActiveDeploy),
    Effect.flatMap((active) => {
      const target = showDeployTarget(projectId, environmentId)
      return Console.log(
        active
          ? `Active deployment for ${target}: ${active.executionId} (${active.status}).`
          : `No deployment is active for ${target}.`,
      )
    }),
  )

const DEPLOY_FRONTEND_URL_QUERY = `
  query DeployFrontendUrl($projectId: String!, $environmentId: String!) {
    getDnsRecords(projectId: $projectId, environmentId: $environmentId) {
      customDomain
      frontendUrl
      frontendUrlNote
    }
  }
`

interface RequestUploadUrlResponse {
  requestUploadUrl: {
    fileId: string
    uploadUrl: string
  }
}

interface StartDeployResponse {
  startOperationsDeploy: {
    executionId: string
    processPath: string
  }
}

interface DeployFrontendUrlResponse {
  getDnsRecords: {
    customDomain: string | null
    frontendUrl: string
    frontendUrlNote: string | null
  }
}

interface RunDeployOptions {
  waitForCompletion?: boolean
  waitTimeoutMs?: number | undefined
  executionId?: string | undefined
}

interface RunDeployDependencies {
  createExecutionEventSource?: typeof createExecutionEventSource
  createDeployProgressEventSource?: typeof createDeployProgressEventSource
  buildOrg?: (orgPath: string) => Effect.Effect<void, unknown>
  prepareArtifact?:
    | ((orgPath: string, artifactPath: string) => Effect.Effect<void, CliError>)
    | undefined
}

const STANDARD_BACKEND_BASE_URL = "https://backend.processfocus.com"
const STANDARD_CONSOLE_BASE_URL = "https://console.processfocus.com"

const buildUploadLogMessage = (baseUrl: string): string => {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "")

  if (
    normalizedBaseUrl === STANDARD_BACKEND_BASE_URL ||
    normalizedBaseUrl === STANDARD_CONSOLE_BASE_URL
  ) {
    return "Uploading artifact..."
  }

  return `Uploading artifact to ${normalizedBaseUrl}...`
}

const DEPLOY_WAIT_TIMEOUT_MS = 15 * 60 * 1000 // 15 minutes
const DEPLOY_WAIT_HEARTBEAT_MS = 10 * 1000 // 10 seconds
// A silent deploy can still be making progress: promotion may wait on a slow
// CloudFront invalidation (up to ~30 minutes) without emitting an update, so
// the persisted execution state gets until here before the wait gives up.
const DEPLOY_MAX_WAIT_TIMEOUTS = 3

const DEPLOY_WAIT_TIMEOUT_MS_ENV = "PFCLI_DEPLOY_WAIT_TIMEOUT_MS"

const resolveDeployWaitTimeoutMs = (): number => {
  const override = process.env[DEPLOY_WAIT_TIMEOUT_MS_ENV]
  if (override === undefined || override === "") {
    return DEPLOY_WAIT_TIMEOUT_MS
  }
  const parsed = Number.parseInt(override, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(
      `${DEPLOY_WAIT_TIMEOUT_MS_ENV} must be a positive number of milliseconds`,
    )
  }
  return parsed
}

const buildDeployProgressChannel = (userId: string, executionId: string) =>
  `/cloud/deploy/${userId}/${executionId}`

const DEPLOY_PROGRESS_STREAM_ENDED_MESSAGE =
  "Deployment progress stream ended before deployment finished"

// The live deploy-progress channel is for output only; once it goes quiet the
// persisted execution state still decides the outcome.
const DEPLOY_PROGRESS_TIMEOUT_PREFIX = "Timeout: No deployment update received"

const formatDeploymentWaitTimeoutMessage = (
  timeoutMs: number,
  executionId?: string,
): string => {
  const minutes = Math.round(timeoutMs / 60_000)
  const minuteLabel = minutes === 1 ? "minute" : "minutes"
  const deploymentSuffix = executionId ? ` for deployment ${executionId}` : ""
  return `Timeout: No deployment update received in the last ${minutes} ${minuteLabel}${deploymentSuffix}`
}

const isRecoverableDeployProgressError = (error: CliError): boolean => {
  let cause: unknown = error
  while (cause instanceof CliError) {
    cause = cause.cause
    if (cause instanceof DeployProgressTransportError) return true
  }
  const message = error.message
  const causeMessage =
    error.cause instanceof Error
      ? error.cause.message
      : String(error.cause ?? "")
  const combinedMessage = `${message}\n${causeMessage}`

  return (
    combinedMessage.includes(DEPLOY_PROGRESS_CONNECTION_LOST_MESSAGE) ||
    combinedMessage.includes(DEPLOY_PROGRESS_STREAM_ENDED_MESSAGE) ||
    combinedMessage.includes(DEPLOY_PROGRESS_TIMEOUT_PREFIX)
  )
}

const nextUpdateWithTimeout = async <T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<IteratorResult<T>> =>
  await new Promise<IteratorResult<T>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(formatDeploymentWaitTimeoutMessage(timeoutMs)))
    }, timeoutMs)

    const abort = () => {
      clearTimeout(timeout)
      reject(new Error("Deployment wait cancelled"))
    }
    signal.addEventListener("abort", abort, { once: true })
    iterator
      .next()
      .then((result) => {
        clearTimeout(timeout)
        signal.removeEventListener("abort", abort)
        resolve(result)
      })
      .catch((error) => {
        clearTimeout(timeout)
        signal.removeEventListener("abort", abort)
        reject(error)
      })
  })

const waitForDeployToFinish = ({
  deployProgressEventSource,
  executionId,
  hasPendingInitialLine,
  timeoutMs,
  onActivity,
}: {
  deployProgressEventSource: DeployProgressEventSource
  executionId: string
  hasPendingInitialLine: boolean
  timeoutMs: number
  onActivity: (now: number) => void
}): Effect.Effect<DeployProgressEvent, CliError> =>
  Effect.tryPromise({
    try: async (signal) => {
      let lastEventTime = Date.now()
      let hasPendingLine = hasPendingInitialLine
      let lastPrintedKey: string | undefined = "setup:Setting up deployment..."
      const iterator = deployProgressEventSource[Symbol.asyncIterator]()
      const heartbeat = setInterval(() => {
        process.stdout.write(".")
        hasPendingLine = true
      }, DEPLOY_WAIT_HEARTBEAT_MS)

      try {
        while (true) {
          const nextResult = await nextUpdateWithTimeout(
            iterator,
            timeoutMs,
            signal,
          )

          if (nextResult.done) {
            throw new Error(
              `${DEPLOY_PROGRESS_STREAM_ENDED_MESSAGE}: ${executionId}. The deployment may still be running; check the Backend or deployment logs.`,
            )
          }

          const event = nextResult.value
          const now = Date.now()

          if (event.executionId !== executionId) {
            if (now - lastEventTime > timeoutMs) {
              throw new Error(
                formatDeploymentWaitTimeoutMessage(timeoutMs, executionId),
              )
            }
            continue
          }

          lastEventTime = now
          onActivity(now)

          if (event.status === "progress") {
            const eventKey = `${event.phase}:${event.message}`
            if (
              eventKey !== lastPrintedKey ||
              event.phase === "setup-heartbeat"
            ) {
              if (hasPendingLine) {
                process.stdout.write("\n")
                hasPendingLine = false
              }
              process.stdout.write(
                formatExecutionLogMessage(event.message, now),
              )
              hasPendingLine = true
              lastPrintedKey = eventKey
            }
          }

          if (event.status === "completed" || event.status === "failed") {
            if (hasPendingLine) {
              process.stdout.write("\n")
            }
            return event
          }
        }
      } finally {
        clearInterval(heartbeat)
      }
    },
    catch: (cause) =>
      new CliError({
        message: `Failed while waiting for deployment progress: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  })

export const runDeploy = (
  orgPath: string,
  projectId: string,
  environmentId: string,
  options: RunDeployOptions = {},
  dependencies: RunDeployDependencies = {},
) => {
  const zipPath = path.join(tmpdir(), `pfcli-deploy-${randomUUID()}.zip`)
  const createExecutionEventSourceImpl =
    dependencies.createExecutionEventSource ?? createExecutionEventSource
  const createDeployProgressEventSourceImpl =
    dependencies.createDeployProgressEventSource ??
    createDeployProgressEventSource
  const buildOrg: (orgPath: string) => Effect.Effect<void, unknown> =
    dependencies.buildOrg ??
    ((orgPath: string) =>
      Effect.try({
        try: () => {
          // A fresh process isolates environment-dependent model construction
          // and module caches from other builds in this CLI process.
          const entrypoint = fileURLToPath(
            typeof PFCLI_DISTRIBUTION_BUILD === "undefined"
              ? new URL("../main.ts", import.meta.url)
              : new URL("./main.mjs", import.meta.url),
          )
          const result = Bun.spawnSync(
            [process.execPath, entrypoint, "build", orgPath],
            {
              env: { ...process.env, PF_ENV: environmentId },
              stdout: "inherit",
              stderr: "inherit",
            },
          )
          if (result.exitCode !== 0) {
            throw new Error(
              `Organisation build exited with code ${result.exitCode}. See build diagnostics above.`,
            )
          }
        },
        catch: (cause) =>
          new CliError({ message: "Organisation build failed", cause }),
      }))
  const prepareArtifact =
    dependencies.prepareArtifact ?? prepareDeploymentArtifact
  const waitForCompletion = options.waitForCompletion ?? true

  return Effect.gen(function* () {
    if (
      options.waitTimeoutMs !== undefined &&
      (!waitForCompletion ||
        !Number.isSafeInteger(options.waitTimeoutMs) ||
        options.waitTimeoutMs < 1)
    ) {
      return yield* new CliError({
        message:
          "--wait-timeout-ms must be a positive integer and cannot be used with --no-wait.",
      })
    }
    const waitTimeoutMs = yield* Effect.try({
      try: () => options.waitTimeoutMs ?? resolveDeployWaitTimeoutMs(),
      catch: (cause) =>
        new CliError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    })
    const maxWaitMs = DEPLOY_MAX_WAIT_TIMEOUTS * waitTimeoutMs

    yield* ensureKnownEnvironmentName(projectId, environmentId)

    const credentials = yield* readCredentialsOrFail("deploy")

    const accessTokenAudience = parseAccessTokenAudience(
      yield* acquireAccessToken(credentials),
    )
    const audienceMatches =
      typeof accessTokenAudience === "string"
        ? accessTokenAudience === GRAPHQL_AUDIENCE
        : Array.isArray(accessTokenAudience)
          ? accessTokenAudience.includes(GRAPHQL_AUDIENCE)
          : true

    if (!audienceMatches) {
      const shownAudience =
        typeof accessTokenAudience === "string"
          ? accessTokenAudience
          : Array.isArray(accessTokenAudience)
            ? accessTokenAudience.join(",")
            : "unknown"
      return yield* new CliError({
        message: `CLI token audience is ${shownAudience}, expected ${GRAPHQL_AUDIENCE}. Run "pfcli auth login" after restarting local auth/runtime services.`,
      })
    }

    const endpoint = resolveGraphqlEndpoint(credentials.baseUrl)
    const active = yield* graphqlRequest<unknown>(
      endpoint,
      acquireAccessToken(credentials),
      ACTIVE_DEPLOY_QUERY,
      { projectId, environmentId },
    ).pipe(Effect.flatMap(decodeActiveDeploy))
    // A caller retrying the same receipt must reach the Backend's idempotent
    // start path, which can recover a pending queue handoff.
    if (active && active.executionId !== options.executionId) {
      const { executionId } = options
      if (executionId !== undefined) {
        const { deployReceipt } = yield* graphqlRequest<unknown>(
          endpoint,
          acquireAccessToken(credentials),
          DEPLOY_RECEIPT_QUERY,
          { projectId, environmentId, executionId },
        ).pipe(
          Effect.flatMap((response) =>
            Schema.decodeUnknownEffect(DeployReceiptResponse)(response).pipe(
              Effect.mapError(
                (cause) =>
                  new CliError({
                    message: "Invalid deployment receipt from Backend",
                    cause,
                  }),
              ),
            ),
          ),
        )
        if (deployReceipt !== null) {
          yield* Console.log(
            formatStructuredLogLine("Deployment receipt reconciled", {
              executionId,
              status: deployReceipt,
            }),
          )
          if (waitForCompletion && deployReceipt !== "SUCCEEDED")
            return yield* new CliError({
              message: `Deployment ${executionId} ${deployReceipt.toLowerCase().replace("_", " ")}.`,
            })
          return
        }
      }
      return yield* new CliError({
        message: `Deployment already active for ${showDeployTarget(projectId, environmentId)}: ${active.executionId}. Check status before retrying.`,
      })
    }

    const absoluteOrgPath = path.resolve(process.cwd(), orgPath)

    yield* Effect.try({
      try: () => statSync(absoluteOrgPath).isDirectory(),
      catch: () =>
        new CliError({
          message: `Org directory not found at ${absoluteOrgPath}.`,
        }),
    })

    yield* buildOrg(orgPath).pipe(
      Effect.mapError(
        (cause) =>
          new CliError({
            message: `Failed to build organisation before deploy: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            cause,
          }),
      ),
    )

    const distPath = path.join(absoluteOrgPath, "dist")

    yield* Effect.try({
      try: () => statSync(distPath).isDirectory(),
      catch: () =>
        new CliError({
          message: `Build completed but dist directory not found at ${distPath}. This may indicate a build configuration issue.`,
        }),
    })

    yield* Console.log(`Creating artifact from ${distPath}`)
    const { platformRef, platformSource } = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(
          Schema.Struct({
            platformRef: Schema.Trim.check(Schema.isMinLength(1)),
            platformSource: Schema.optional(
              Schema.Literals(["private", "public"]),
            ),
          }),
        )(
          JSON.parse(
            readFileSync(path.join(distPath, "deploy-manifest.json"), "utf8"),
          ),
        ),
      catch: (cause) =>
        new CliError({
          message:
            'Set Organisation.platformRef to a branch or exact commit and, if set, Organisation.platformSource to "private" or "public".',
          cause,
        }),
    })
    yield* prepareArtifact(absoluteOrgPath, zipPath)

    yield* Effect.try({
      try: () => statSync(zipPath),
      catch: (cause) =>
        new CliError({
          message: `Failed to create artifact zip at ${zipPath}`,
          cause,
        }),
    })

    const uploadInfo = yield* graphqlRequest<RequestUploadUrlResponse>(
      endpoint,
      acquireAccessToken(credentials),
      REQUEST_UPLOAD_URL_MUTATION,
      {
        stepPath: "/operations/deploy/Upload artifact",
        documentStore: "/org-upload",
        contentType: "application/zip",
        filename: "org-dist.zip",
      },
    )

    yield* Console.log(buildUploadLogMessage(credentials.baseUrl))

    const zipBytes = yield* Effect.try({
      try: () => readFileSync(zipPath),
      catch: (cause) =>
        new CliError({
          message: "Failed to read artifact zip",
          cause,
        }),
    })

    const uploadResponse = yield* Effect.tryPromise({
      try: () =>
        fetch(uploadInfo.requestUploadUrl.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/zip" },
          body: zipBytes,
        }),
      catch: (cause) =>
        new CliError({
          message: "Failed to upload deployment artifact",
          cause,
        }),
    })

    if (!uploadResponse.ok) {
      const text = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await uploadResponse.text()
          } catch {
            return ""
          }
        },
        catch: (cause) =>
          new CliError({
            message: "Failed to read upload error response body",
            cause,
          }),
      })
      return yield* new CliError({
        message: `Artifact upload failed with ${uploadResponse.status}: ${text}`,
      })
    }

    const startDeployment = () =>
      Effect.gen(function* () {
        yield* writeStartReceipt(options.executionId)
        const deployResult = yield* graphqlRequest<StartDeployResponse>(
          endpoint,
          acquireAccessToken(credentials),
          startDeployMutation(platformSource === "public"),
          {
            projectId,
            environmentId,
            fileId: uploadInfo.requestUploadUrl.fileId,
            platformRef,
            ...(platformSource === "public" && { platformSource }),
            executionId: options.executionId,
          },
        ).pipe(
          Effect.mapError((error) =>
            error.graphqlErrorCode === "ProcessActivationConflict" &&
            error.graphqlErrorMessage
              ? new CliError({
                  message: error.graphqlErrorMessage,
                  cause: error,
                })
              : error,
          ),
        )

        yield* Console.log(
          formatStructuredLogLine("Deployment started", {
            executionId: deployResult.startOperationsDeploy.executionId,
          }),
        )

        return deployResult.startOperationsDeploy
      })

    const logDeployFrontendUrl = () =>
      graphqlRequest<DeployFrontendUrlResponse>(
        endpoint,
        acquireAccessToken(credentials),
        DEPLOY_FRONTEND_URL_QUERY,
        {
          projectId,
          environmentId,
        },
      ).pipe(
        Effect.flatMap(({ getDnsRecords }) =>
          Effect.gen(function* () {
            yield* Console.log(`Frontend URL: ${getDnsRecords.frontendUrl}`)

            if (
              getDnsRecords.customDomain &&
              getDnsRecords.frontendUrl !==
                `https://${getDnsRecords.customDomain}`
            ) {
              yield* Console.log(
                `Configured custom domain: https://${getDnsRecords.customDomain}`,
              )
            }

            if (getDnsRecords.frontendUrlNote) {
              yield* Console.log(`Note: ${getDnsRecords.frontendUrlNote}`)
            }
          }),
        ),
        // Older Backend deployments will not expose these fields yet.
        Effect.catch((error) =>
          isWorkloadAuthenticationFailure(error)
            ? Effect.fail(error)
            : Effect.void,
        ),
      )

    const waitForExecutionResult = (
      executionEventSource: ExecutionEventSource,
      executionId: string,
      readSnapshot = false,
      getLastProgressAt?: () => number,
    ) =>
      Effect.gen(function* () {
        if (!readSnapshot) {
          yield* Effect.sync(() =>
            process.stdout.write(
              formatExecutionLogMessage("Waiting for deployment to start..."),
            ),
          )
        }
        const updates = waitForExecutionToFinish(
          executionEventSource,
          executionId,
          {
            executionLabel: "deployment",
            timeoutMs: waitTimeoutMs,
            heartbeatMs: DEPLOY_WAIT_HEARTBEAT_MS,
            hasPendingInitialLine: !readSnapshot,
            quiet: readSnapshot && !credentials.workload,
            ...(getLastProgressAt ? { getLastProgressAt } : {}),
            formatLogMessage: formatExecutionLogMessage,
            includeExecutionIdInTimeout: true,
            fetchSnapshot: async (signal) => {
              const result = await Effect.runPromise(
                Effect.result(
                  fetchExecutionSnapshot(
                    endpoint,
                    acquireAccessToken(credentials),
                    executionId,
                  ),
                ),
                { signal },
              )
              // Preserve the typed CLI error across the Promise iterator boundary.
              if (Result.isFailure(result)) {
                throw result.failure
              }
              return result.success
            },
            maxWaitMs,
          },
        )

        // Only terminal snapshots participate in the race: an older running
        // snapshot must never replace an event received while the query ran.
        const terminalExecution = yield* readSnapshot
          ? Effect.raceFirst(
              updates,
              fetchExecutionSnapshot(
                endpoint,
                acquireAccessToken(credentials),
                executionId,
              ).pipe(
                Effect.flatMap((snapshot) =>
                  snapshot.status === "Completed" ||
                  snapshot.status === "Failed" ||
                  snapshot.status === "Abandoned"
                    ? Effect.succeed(snapshot)
                    : Effect.never,
                ),
              ),
            )
          : updates

        return terminalExecution
      })

    const reportExecutionResult = (terminalExecution: ExecutionSnapshot) =>
      Effect.gen(function* () {
        if (terminalExecution.status === "Completed") {
          yield* Console.log(formatExecutionLogMessage("Deployment completed."))
          yield* logDeployFrontendUrl()
          return
        }
        return yield* new CliError({
          message:
            extractExecutionFailureMessage(terminalExecution) ??
            `Deployment ${terminalExecution.status.toLowerCase()}.`,
        })
      })

    const waitForDeployProgressResult = (params: {
      readonly executionId: string
      readonly userId: string
      readonly appSyncEventsHttpHost: string
      readonly onActivity: (now: number) => void
    }) =>
      Effect.gen(function* () {
        const baseUrlHost = credentials.baseUrl.replace(/^https?:\/\//, "")
        const openProgress = (accessToken: string) =>
          createDeployProgressEventSourceImpl({
            realtimeUrl: `wss://${baseUrlHost}/event/realtime`,
            appSyncEventsHttpHost: params.appSyncEventsHttpHost,
            accessToken,
            channel: buildDeployProgressChannel(
              params.userId,
              params.executionId,
            ),
          })
        const deployProgressEventSource = yield* openProgress(
          credentials.accessToken,
        )

        const closeDeployProgressEventSource = Effect.tryPromise({
          try: () => deployProgressEventSource.close(),
          catch: (cause) =>
            new CliError({
              message: "Failed to close deployment progress subscription.",
              cause,
            }),
        }).pipe(Effect.catch(() => Effect.void))

        return yield* Effect.gen(function* () {
          yield* waitForDeployToFinish({
            deployProgressEventSource,
            executionId: params.executionId,
            hasPendingInitialLine: true,
            timeoutMs: waitTimeoutMs,
            onActivity: params.onActivity,
          })
          // Progress is for live output; only persisted execution state decides
          // the outcome, including pre-build failures with no progress events.
          return yield* Effect.never
        }).pipe(Effect.ensuring(closeDeployProgressEventSource))
      })

    if (!waitForCompletion) {
      yield* startDeployment()
      return
    }

    const subscriptionTransport =
      yield* graphqlRequest<SubscriptionTransportResponse>(
        endpoint,
        acquireAccessToken(credentials),
        SUBSCRIPTION_TRANSPORT_QUERY,
        {},
      )

    if (subscriptionTransport.subscriptionTransport.kind === "APPSYNC_EVENTS") {
      const appSyncEventsHttpHost =
        subscriptionTransport.subscriptionTransport.appSyncEventsHttpHost
      if (!appSyncEventsHttpHost) {
        return yield* new CliError({
          message:
            "GraphQL reported AppSync Events subscriptions but did not provide an AppSync host.",
        })
      }

      const userId = parseAccessTokenUserId(credentials.accessToken)
      if (!userId) {
        return yield* new CliError({
          message:
            "CLI access token is missing userId/sub claims required for deploy progress subscriptions.",
        })
      }

      // The executionId determines the deploy-progress channel, so the deploy
      // has to be started before the CLI can subscribe.
      const deployStart = yield* startDeployment()
      // Setup can already be running before either subscription is established.
      yield* Effect.sync(() =>
        process.stdout.write(
          formatExecutionLogMessage("Setting up deployment..."),
        ),
      )
      const terminalExecution = yield* Effect.scoped(
        Effect.gen(function* () {
          const executionEventSource = yield* Effect.acquireRelease(
            buildExecutionEventSource({
              credentials,
              subscriptionTransport:
                subscriptionTransport.subscriptionTransport,
              missingUserIdMessage:
                "CLI access token is missing userId/sub claims required for execution subscriptions.",
              createExecutionEventSourceImpl,
            }).pipe(
              Effect.timeoutOrElse({
                duration: "30 seconds",
                orElse: () =>
                  Effect.fail(
                    new CliError({
                      message:
                        "Timed out subscribing to deployment execution updates.",
                    }),
                  ),
              }),
              Effect.interruptible,
            ),
            (source) =>
              closeExecutionEventSource(
                source,
                "Failed to close execution subscription.",
              ),
          )
          // Machine progress comes from project-authorized execution steps.
          if (credentials.workload)
            return yield* waitForExecutionResult(
              executionEventSource,
              deployStart.executionId,
              true,
            )
          let lastProgressAt = Date.now()
          return yield* Effect.raceFirst(
            waitForExecutionResult(
              executionEventSource,
              deployStart.executionId,
              true,
              () => lastProgressAt,
            ),
            waitForDeployProgressResult({
              executionId: deployStart.executionId,
              userId,
              appSyncEventsHttpHost,
              onActivity: (now) => {
                lastProgressAt = now
              },
            }).pipe(
              Effect.catch((error) =>
                isRecoverableDeployProgressError(error)
                  ? Console.log(
                      formatExecutionLogMessage(
                        "Deploy progress stream closed or quiet; waiting for the persisted deployment result...",
                      ),
                    ).pipe(Effect.andThen(Effect.never))
                  : Effect.fail(error),
              ),
            ),
          )
        }),
      )
      yield* Effect.sync(() => process.stdout.write("\n"))
      return yield* reportExecutionResult(terminalExecution)
    }

    const executionEventSource = yield* buildExecutionEventSource({
      credentials,
      subscriptionTransport: subscriptionTransport.subscriptionTransport,
      missingUserIdMessage:
        "CLI access token is missing userId/sub claims required for execution subscriptions.",
      createExecutionEventSourceImpl,
    })

    const closeEventSource = closeExecutionEventSource(
      executionEventSource,
      "Failed to close execution subscription.",
    )

    return yield* Effect.gen(function* () {
      const deployStart = yield* startDeployment()
      yield* waitForExecutionResult(
        executionEventSource,
        deployStart.executionId,
      ).pipe(Effect.flatMap(reportExecutionResult))
    }).pipe(Effect.ensuring(closeEventSource))
  }).pipe(Effect.ensuring(Effect.sync(() => rmSync(zipPath, { force: true }))))
}
