import { randomUUID } from "node:crypto"
import { readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Console, Effect } from "effect"
import { CliError } from "../errors"
import { prepareDeploymentArtifact } from "../prepare-deployment-artifact"
import {
  GRAPHQL_AUDIENCE,
  parseAccessTokenAudience,
  parseAccessTokenUserId,
} from "../utils/access-token"
import {
  DEPLOY_PROGRESS_CONNECTION_LOST_MESSAGE,
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
  readCredentialsOrFail,
  resolveGraphqlEndpoint,
} from "../utils/graphql-client"
import { ensureKnownEnvironmentName } from "../utils/remote-name-validation"
import { formatStructuredLogLine } from "../utils/structured-log"
import {
  SUBSCRIPTION_TRANSPORT_QUERY,
  type SubscriptionTransportResponse,
} from "../utils/subscription-transport"
import { runBuild } from "./build"

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

const START_DEPLOY_MUTATION = `
  mutation StartDeploy($projectId: String!, $environmentId: String!, $fileId: String!) {
    startOperationsDeploy(input: { projectId: $projectId, environmentId: $environmentId, fileId: $fileId }) {
      executionId
      processPath
    }
  }
`

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
}

interface RunDeployDependencies {
  createExecutionEventSource?: typeof createExecutionEventSource
  createDeployProgressEventSource?: typeof createDeployProgressEventSource
  buildOrg?: (orgPath: string) => ReturnType<typeof runBuild>
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

const buildDeployProgressChannel = (userId: string, executionId: string) =>
  `/cloud/deploy/${userId}/${executionId}`

const DEPLOY_PROGRESS_STREAM_ENDED_MESSAGE =
  "Deployment progress stream ended before deployment finished"

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
  const message = error.message
  const causeMessage =
    error.cause instanceof Error
      ? error.cause.message
      : String(error.cause ?? "")
  const combinedMessage = `${message}\n${causeMessage}`

  return (
    combinedMessage.includes(DEPLOY_PROGRESS_CONNECTION_LOST_MESSAGE) ||
    combinedMessage.includes(DEPLOY_PROGRESS_STREAM_ENDED_MESSAGE)
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

const waitForDeployToFinish = (
  deployProgressEventSource: DeployProgressEventSource,
  executionId: string,
  hasPendingInitialLine: boolean,
): Effect.Effect<DeployProgressEvent, CliError> =>
  Effect.tryPromise({
    try: async (signal) => {
      let lastEventTime = Date.now()
      let hasPendingLine = hasPendingInitialLine
      let lastPrintedKey: string | undefined
      const iterator = deployProgressEventSource[Symbol.asyncIterator]()
      const heartbeat = setInterval(() => {
        process.stdout.write(".")
        hasPendingLine = true
      }, DEPLOY_WAIT_HEARTBEAT_MS)

      try {
        while (true) {
          const nextResult = await nextUpdateWithTimeout(
            iterator,
            DEPLOY_WAIT_TIMEOUT_MS,
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
            if (now - lastEventTime > DEPLOY_WAIT_TIMEOUT_MS) {
              throw new Error(
                formatDeploymentWaitTimeoutMessage(
                  DEPLOY_WAIT_TIMEOUT_MS,
                  executionId,
                ),
              )
            }
            continue
          }

          lastEventTime = now

          if (event.status === "progress") {
            const eventKey = `${event.phase}:${event.message}`
            if (eventKey !== lastPrintedKey) {
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
  const buildOrg =
    dependencies.buildOrg ?? ((orgPath: string) => runBuild(orgPath))
  const prepareArtifact =
    dependencies.prepareArtifact ?? prepareDeploymentArtifact
  const waitForCompletion = options.waitForCompletion ?? true

  return Effect.gen(function* () {
    yield* ensureKnownEnvironmentName(projectId, environmentId)

    const credentials = yield* readCredentialsOrFail()

    const accessTokenAudience = parseAccessTokenAudience(
      credentials.accessToken,
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

    const endpoint = resolveGraphqlEndpoint(credentials.baseUrl)

    yield* Console.log(`Creating artifact from ${distPath}`)
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
      credentials.accessToken,
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
        const deployResult = yield* graphqlRequest<StartDeployResponse>(
          endpoint,
          credentials.accessToken,
          START_DEPLOY_MUTATION,
          {
            projectId,
            environmentId,
            fileId: uploadInfo.requestUploadUrl.fileId,
          },
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
        credentials.accessToken,
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
        Effect.catchAll(() => Effect.void),
      )

    const waitForExecutionResult = (
      executionEventSource: ExecutionEventSource,
      executionId: string,
      readSnapshot = false,
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
            timeoutMs: DEPLOY_WAIT_TIMEOUT_MS,
            heartbeatMs: DEPLOY_WAIT_HEARTBEAT_MS,
            hasPendingInitialLine: !readSnapshot,
            quiet: readSnapshot,
            formatLogMessage: formatExecutionLogMessage,
            includeExecutionIdInTimeout: true,
          },
        )

        // Only terminal snapshots participate in the race: an older running
        // snapshot must never replace an event received while the query ran.
        const terminalExecution = yield* readSnapshot
          ? Effect.raceFirst(
              updates,
              fetchExecutionSnapshot(
                endpoint,
                credentials.accessToken,
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
    }) =>
      Effect.gen(function* () {
        const baseUrlHost = credentials.baseUrl.replace(/^https?:\/\//, "")
        const deployProgressEventSource =
          yield* createDeployProgressEventSourceImpl({
            realtimeUrl: `wss://${baseUrlHost}/event/realtime`,
            appSyncEventsHttpHost: params.appSyncEventsHttpHost,
            accessToken: credentials.accessToken,
            channel: buildDeployProgressChannel(
              params.userId,
              params.executionId,
            ),
          })

        const closeDeployProgressEventSource = Effect.tryPromise({
          try: () => deployProgressEventSource.close(),
          catch: (cause) =>
            new CliError({
              message: "Failed to close deployment progress subscription.",
              cause,
            }),
        }).pipe(Effect.catchAll(() => Effect.void))

        return yield* Effect.gen(function* () {
          const waitStartedAt = Date.now()
          yield* Effect.sync(() =>
            process.stdout.write(
              formatExecutionLogMessage(
                "Waiting for deployment updates...",
                waitStartedAt,
              ),
            ),
          )
          yield* waitForDeployToFinish(
            deployProgressEventSource,
            params.executionId,
            true,
          )
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
        credentials.accessToken,
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
              Effect.timeoutFail({
                duration: "30 seconds",
                onTimeout: () =>
                  new CliError({
                    message:
                      "Timed out subscribing to deployment execution updates.",
                  }),
              }),
              Effect.interruptible,
            ),
            (source) =>
              closeExecutionEventSource(
                source,
                "Failed to close execution subscription.",
              ),
          )
          return yield* Effect.raceFirst(
            waitForExecutionResult(
              executionEventSource,
              deployStart.executionId,
              true,
            ),
            waitForDeployProgressResult({
              executionId: deployStart.executionId,
              userId,
              appSyncEventsHttpHost,
            }).pipe(
              Effect.catchAll((error) =>
                isRecoverableDeployProgressError(error)
                  ? Console.log(
                      formatExecutionLogMessage(
                        "Deploy progress connection closed; waiting for deployment result...",
                      ),
                    ).pipe(Effect.zipRight(Effect.never))
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
