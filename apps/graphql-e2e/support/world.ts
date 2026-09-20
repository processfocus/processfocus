import { World, setWorldConstructor } from "@cucumber/cucumber"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform"
import { Data, Effect, Schedule } from "effect"
import {
  type Client as WsClient,
  createClient as createWsClient,
} from "graphql-ws"
import { decodeJwt } from "jose"
import WebSocket from "ws"

/** Tagged error for retryable GraphQL failures */
class GraphQLRetryableError extends Data.TaggedError(
  "@pf/GraphQLRetryableError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** Tagged error for non-retryable GraphQL failures */
class GraphQLError extends Data.TaggedError("@pf/GraphQLError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Check if an error message indicates a retryable SQLite database error.
 * These errors occur during concurrent access and should be retried.
 */
export const isSqliteRetryableError = (message: string): boolean =>
  message.includes("Database operation failed") ||
  message.includes("SQLITE_BUSY") ||
  message.includes("database is locked")

import {
  getAppSyncEventsHttpHost,
  getAppSyncEventsRealtimeUrl,
  usesAppSyncEvents,
} from "@pf/frontend-endpoints"
import {
  getEffectiveGraphqlEndpoint,
  getEffectiveWsEndpoint,
} from "@pf/frontend-endpoints/port-files"
import { type Client, createClient } from "../generated"
import { AppSyncEventsClient } from "./appsync-events-client"
import { isGraphqlMutation, withPausedLocalWorker } from "./local-worker-pause"
import { getAppSyncRecipientId } from "./realtime-recipient"
import { websocketEventWaitMs } from "./subscription-timeouts"

/** Generic subscription event received from WebSocket */
interface SubscriptionEvent<T = unknown> {
  data: T
}

/** State for a single subscription type */
interface SubscriptionState {
  wsClient: WsClient | null
  appSyncClient: AppSyncEventsClient | null
  cleanup: (() => void) | null
  events: SubscriptionEvent[]
  error: Error | null
  eventNotifier: (() => void) | null
}

/** Stored session state for multi-user websocket testing */
interface StoredUserSession {
  accessToken: string
  subscriptions: {
    todo?: SubscriptionState
    process?: SubscriptionState
    execution?: SubscriptionState
  }
}

interface TodoSummaryItem {
  label: string
  value: string
}

interface TodoResult {
  id: string
  description: string
  dueAt: number | null
  formComplexity: string
  processName: string
  role: string | null // null for system-executed steps
  status: string
  stepName: string
  stepPath: string
  summary: TodoSummaryItem[]
}

interface TodoListItemResult {
  id: string
  processExecutionId: string
  processName: string
  stepName: string
  stepPath: string
  role: string
  status: string
  priority: string
  assignedAt: string
  dueAt: string | null
  description: string
  summary: TodoSummaryItem[]
}

export interface TodoListPageResult {
  nodes: TodoListItemResult[]
  page: number
  limit: number
  hasNextPage: boolean
}

interface ProcessListItemResult {
  id: string
  path: string
  name: string
  category: string
  purpose: string
  startStepPath: string
  activeInstances: number
}

export interface ProcessListPageResult {
  nodes: ProcessListItemResult[]
  page: number
  limit: number
  hasNextPage: boolean
}

interface ExecutionListItemResult {
  id: string
  processPath: string
  processName: string
  status: string
  startedAt: string
  finishedAt: string | null
  completedSteps: number
  totalSteps: number
  failureReason: string | null
}

export interface ExecutionListPageResult {
  nodes: ExecutionListItemResult[]
  page: number
  limit: number
  hasNextPage: boolean
}

interface ProcessResult {
  id: string
}

interface AuthError {
  error: string
  error_description?: string | undefined
}

interface StartProcessResult {
  executionId: string
  processId: string
  processPath: string
  timestamp: string
}

interface CompleteStepResult {
  executionId: string
  stepPath: string
  timestamp: string
}

interface OrgResult {
  name: string
  acronym: string | null
}

interface OrgLevelResult {
  level: string
  maxDepth: number
}

interface WorkflowPhase {
  name: string
}

interface WorkflowStep {
  column: number
  name: string
  phase: WorkflowPhase | null
}

interface WorkflowResponsibility {
  responsibility: string
  roleName: string
}

interface WorkflowResult {
  processId: string
  processName: string
  processPurpose: string
  responsibilities: WorkflowResponsibility[]
  steps: WorkflowStep[]
}

interface DraftProcessExecutionDocument {
  id: string
  name: string | null
  state: unknown
  deleted: boolean
}

interface DraftProcessExecutionResult {
  documents: DraftProcessExecutionDocument[]
  checkpoint: {
    id: string
    updatedAt: number
  } | null
}

interface CedarPoliciesResult {
  policies: string[]
  schema: string
}

interface NotificationPreferencesResult {
  notifications: {
    todoAssignment: {
      email: boolean
    }
  }
}

export class TestWorld extends World {
  accessToken: string | null = null
  todoDocuments: TodoResult[] | undefined = undefined
  todoListPages: TodoListPageResult[] = []
  processListPages: ProcessListPageResult[] = []
  executionListPages: ExecutionListPageResult[] = []
  processDocuments: ProcessResult[] | undefined = undefined
  authError: AuthError | undefined = undefined
  startProcessResult: StartProcessResult | undefined = undefined
  completeStepResult: CompleteStepResult | undefined = undefined
  orgResult: OrgResult | undefined = undefined
  orgLevelsResult: OrgLevelResult[] | undefined = undefined
  workflowResult: WorkflowResult | undefined = undefined
  draftProcessExecutionResult: DraftProcessExecutionResult | undefined =
    undefined
  graphqlError: Error | undefined = undefined
  cedarPoliciesResult: CedarPoliciesResult | undefined = undefined
  selectedUserId: string | undefined = undefined
  notificationPreferencesResult: NotificationPreferencesResult | undefined =
    undefined

  // Subscription state
  private wsClient: WsClient | null = null
  private appSyncClient: AppSyncEventsClient | null = null
  private subscriptionCleanup: (() => void) | null = null
  subscriptionEvents: SubscriptionEvent[] = []
  subscriptionError: Error | null = null
  private eventNotifier: (() => void) | null = null
  private errorNotifier: (() => void) | null = null

  // Draft process execution test state
  pushedDraftId: string | null = null
  pushedProcessName: string | null = null

  // Multi-user session state for websocket testing
  userSessions: Map<string, StoredUserSession> = new Map()

  // Cross-user subscription error state
  crossUserSubscriptionError: Error | null = null

  // Purchase order list test state
  purchaseOrderListCount: number | undefined = undefined

  // File permissions test state
  uploadedFileId: string | undefined = undefined
  downloadUrlResult: { downloadUrl: string; expiresAt: string } | undefined =
    undefined
  downloadedFileContent: string | undefined = undefined
  deleteResult: { success: boolean } | undefined = undefined

  getClient(): Client {
    return createClient({
      url: getEffectiveGraphqlEndpoint(),
      headers: this.accessToken
        ? { Authorization: `Bearer ${this.accessToken}` }
        : {},
    })
  }

  /**
   * Execute a raw GraphQL query/mutation against the server.
   * Uses Effect HttpClient with retry and exponential backoff.
   * Retries on transient errors like "Database operation failed".
   */
  async executeGraphQL<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const accessToken = this.accessToken

    const effect = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      let request = HttpClientRequest.post(getEffectiveGraphqlEndpoint())
      request = HttpClientRequest.setHeader(
        request,
        "Content-Type",
        "application/json",
      )
      if (accessToken) {
        request = HttpClientRequest.setHeader(
          request,
          "Authorization",
          `Bearer ${accessToken}`,
        )
      }
      request = HttpClientRequest.bodyUnsafeJson(request, { query, variables })

      const response = yield* client.execute(request).pipe(Effect.scoped)
      const body = yield* response.json

      const result = body as {
        data?: T
        errors?: Array<{ message: string }>
      }

      if (result.errors?.length) {
        const errorMessage = result.errors.map((e) => e.message).join(", ")
        if (isSqliteRetryableError(errorMessage)) {
          return yield* new GraphQLRetryableError({
            message: `GraphQL error: ${errorMessage}`,
          })
        }
        return yield* new GraphQLError({
          message: `GraphQL error: ${errorMessage}`,
        })
      }

      if (!result.data) {
        return yield* new GraphQLError({
          message: "No data returned from GraphQL",
        })
      }

      return result.data
    })

    // Retry schedule: 100ms initial delay, exponential backoff, max 3 retries
    const retrySchedule = Schedule.exponential("100 millis").pipe(
      Schedule.intersect(Schedule.recurs(3)),
    )

    const effectWithRetry = effect.pipe(
      Effect.retry({
        schedule: retrySchedule,
        while: (error) => error instanceof GraphQLRetryableError,
      }),
      Effect.provide(FetchHttpClient.layer),
    )

    const runRequest = () => Effect.runPromise(effectWithRetry)
    const resultPromise = isGraphqlMutation(query)
      ? withPausedLocalWorker(runRequest)
      : runRequest()

    // Run the effect and convert tagged errors to plain errors for the test framework
    return resultPromise.catch((error: unknown) => {
      if (
        error instanceof GraphQLRetryableError ||
        error instanceof GraphQLError
      ) {
        throw new Error(error.message)
      }
      throw error
    })
  }

  /**
   * Create a WebSocket client for GraphQL subscriptions.
   * Uses graphql-ws protocol.
   */
  private getWsClient(): WsClient {
    if (!this.wsClient) {
      this.wsClient = createWsClient({
        url: getEffectiveWsEndpoint(),
        webSocketImpl: WebSocket,
        // Server expects 'token' in connectionParams (see graphql-api's extractFromConnectionParams)
        connectionParams: this.accessToken
          ? { token: this.accessToken }
          : undefined,
        // Disable retries for tests - we want immediate failure
        retryAttempts: 0,
        // Handle connection errors gracefully
        on: {
          error: (err) => {
            // Convert various error types to Error with proper message
            const error = TestWorld.toError(err)
            console.log("[subscription] Error:", error.message)
            // Only set error if we haven't already cleaned up
            if (this.wsClient && !this.subscriptionError) {
              this.subscriptionError = error
            }
          },
        },
      })
    }
    return this.wsClient
  }

  /**
   * Map GraphQL subscription name to AppSync Events collection name
   */
  private getCollectionFromQuery(query: string): string | null {
    // Extract subscription name from query
    // e.g. "subscription StreamDraftProcessExecution { streamDraftProcessExecution { ... } }"
    // Maps to collection "draftProcessExecution"
    const match = query.match(/stream(\w+)/i)
    if (match?.[1]) {
      // Convert to camelCase (first char lowercase)
      const name = match[1]
      return name.charAt(0).toLowerCase() + name.slice(1)
    }
    return null
  }

  /**
   * Extract userId from a JWT access token.
   * userId can be in properties.userId or sub claim.
   */
  private static getUserIdFromAccessToken(token: string): string | null {
    try {
      const payload = decodeJwt(token)
      const properties = payload["properties"] as
        | { userId?: string }
        | undefined
      return properties?.userId || (payload.sub as string) || null
    } catch {
      return null
    }
  }

  getAuthenticatedUserId(): string | null {
    return this.accessToken
      ? TestWorld.getUserIdFromAccessToken(this.accessToken)
      : null
  }

  /**
   * Subscribe to a GraphQL subscription and collect events.
   * Events are stored in subscriptionEvents array.
   * Uses AppSync Events when running against AWS, graphql-ws otherwise.
   * @param query GraphQL subscription query
   * @param variables Optional variables
   */
  async subscribe<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<void> {
    // Clean up any existing subscription
    this.unsubscribe()
    this.subscriptionEvents = []
    this.subscriptionError = null

    if (usesAppSyncEvents()) {
      try {
        await this.subscribeAppSync<T>(query)
      } catch (error) {
        this.setSubscriptionError(
          error instanceof Error
            ? error
            : new Error("AppSync subscription setup failed"),
        )
        this.eventNotifier?.()
      }
    } else {
      this.subscribeGraphqlWs<T>(query, variables)
    }
  }

  /**
   * Subscribe using AppSync Events (AWS mode)
   */
  private async subscribeAppSync<T>(query: string): Promise<void> {
    const collection = this.getCollectionFromQuery(query)
    const accessToken = this.accessToken

    if (!collection || !accessToken) {
      throw new Error(
        "AppSync subscription requires a supported collection and access token",
      )
    }

    const realtimeUrl = getAppSyncEventsRealtimeUrl()
    const httpHost = getAppSyncEventsHttpHost()

    if (!realtimeUrl || !httpHost) {
      this.subscriptionError = new Error("AppSync configuration not available")
      return
    }

    const recipientId = await getAppSyncRecipientId(accessToken)
    const channel = `/rxdb/collection/${collection}/user/${recipientId}`

    this.appSyncClient = new AppSyncEventsClient({
      realtimeUrl,
      httpHost,
      channel,
      accessToken,
      onEvent: (event) => {
        // Wrap in the same structure as graphql-ws
        // AppSync sends the raw data, we need to wrap it with the subscription field name
        const subscriptionField = `stream${collection.charAt(0).toUpperCase() + collection.slice(1)}`
        this.subscriptionEvents.push({
          data: { [subscriptionField]: event } as T,
        })
        this.eventNotifier?.()
      },
      onError: (err) => {
        this.setSubscriptionError(err)
        this.eventNotifier?.()
      },
    })

    // Start connection (async but we don't wait)
    this.appSyncClient.connect().catch((err) => {
      this.setSubscriptionError(err)
      this.eventNotifier?.()
    })
  }

  /**
   * Subscribe using graphql-ws (local mode)
   */
  private subscribeGraphqlWs<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): void {
    const client = this.getWsClient()

    this.subscriptionCleanup = client.subscribe<T>(
      { query, variables },
      {
        next: (value) => {
          this.subscriptionEvents.push({ data: value.data as T })
          // Notify any waiting promises
          this.eventNotifier?.()
        },
        error: (err) => {
          this.setSubscriptionError(err)
          // Notify any waiting promises about the error
          this.eventNotifier?.()
        },
        complete: () => {
          // Subscription completed normally
        },
      },
    )
  }

  /**
   * Unsubscribe from current subscription and close WebSocket client.
   */
  unsubscribe(): void {
    if (this.subscriptionCleanup) {
      this.subscriptionCleanup()
      this.subscriptionCleanup = null
    }
    if (this.wsClient) {
      this.wsClient.dispose()
      this.wsClient = null
    }
    if (this.appSyncClient) {
      this.appSyncClient.disconnect()
      this.appSyncClient = null
    }
  }

  /**
   * Wait for a specific number of subscription events or timeout.
   * Uses Promise-based event notification instead of polling.
   * @param count Number of events to wait for
   * @param timeoutMs Timeout in milliseconds (default 5000)
   */
  async waitForEvents(count: number, timeoutMs = 5000): Promise<void> {
    // Already have enough events
    if (this.subscriptionEvents.length >= count) return
    if (this.subscriptionError) throw this.subscriptionError

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.eventNotifier = null
        reject(
          new Error(
            `Timeout waiting for ${count} events, received ${this.subscriptionEvents.length}`,
          ),
        )
      }, timeoutMs)

      const checkEvents = () => {
        if (this.subscriptionError) {
          clearTimeout(timeout)
          this.eventNotifier = null
          reject(this.subscriptionError)
          return
        }
        if (this.subscriptionEvents.length >= count) {
          clearTimeout(timeout)
          this.eventNotifier = null
          resolve()
        }
        // Otherwise keep waiting for next notification
      }

      this.eventNotifier = checkEvents
      // Check immediately in case events arrived between subscribe and wait
      checkEvents()
    })
  }

  /**
   * Try to subscribe to a GraphQL subscription.
   * Unlike subscribe(), this method handles connection errors gracefully
   * and stores them in subscriptionError for later assertion.
   * @param query GraphQL subscription query
   * @param variables Optional variables
   */
  trySubscribe<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
  ): void {
    // Clean up any existing subscription
    this.unsubscribe()
    this.subscriptionEvents = []
    this.subscriptionError = null

    try {
      const client = this.getWsClient()

      this.subscriptionCleanup = client.subscribe<T>(
        { query, variables },
        {
          next: (value: { data?: T }) => {
            this.subscriptionEvents.push({ data: value.data as T })
            this.eventNotifier?.()
          },
          error: (err: unknown) => {
            this.setSubscriptionError(err)
            // Notify error waiters
            this.errorNotifier?.()
            this.eventNotifier?.()
          },
          complete: () => {
            // Subscription completed normally
          },
        },
      )
    } catch (err) {
      // Handle synchronous connection errors
      this.setSubscriptionError(err)
      this.errorNotifier?.()
    }
  }

  /**
   * Convert various error types to an Error object.
   * Handles Error instances, GraphQL error arrays, CloseEvent objects, etc.
   */
  private static toError(err: unknown): Error {
    if (err instanceof Error) {
      return err
    } else if (Array.isArray(err)) {
      const messages = err
        .map((e) =>
          typeof e === "object" && e?.["message"] ? e["message"] : String(e),
        )
        .join(", ")
      return new Error(`GraphQL errors: ${messages}`)
    } else if (typeof err === "object" && err !== null) {
      const errObj = err as Record<string, unknown>
      const message =
        typeof errObj["message"] === "string"
          ? errObj["message"]
          : typeof errObj["reason"] === "string"
            ? errObj["reason"]
            : JSON.stringify(err)
      return new Error(message)
    } else {
      return new Error(String(err))
    }
  }

  /**
   * Helper to set subscription error from various error types
   */
  private setSubscriptionError(err: unknown): void {
    const error = TestWorld.toError(err)
    this.subscriptionError = error
  }

  /**
   * Wait for a subscription error to occur.
   * Used for testing authentication failures on WebSocket connections.
   * @param timeoutMs Timeout in milliseconds (default 5000)
   */
  async waitForSubscriptionError(timeoutMs = 5000): Promise<void> {
    // Already have an error
    if (this.subscriptionError) return

    return new Promise((resolve, _reject) => {
      const timeout = setTimeout(() => {
        this.errorNotifier = null
        // If no error occurred, that's also useful info for the test
        resolve()
      }, timeoutMs)

      const checkError = () => {
        if (this.subscriptionError) {
          clearTimeout(timeout)
          this.errorNotifier = null
          resolve()
        }
        // Otherwise keep waiting for next notification
      }

      this.errorNotifier = checkError
      // Check immediately in case error arrived between subscribe and wait
      checkError()
    })
  }

  // ============ Multi-User Session Methods ============

  /**
   * Store an authenticated token for a named user session.
   * @param name User identifier (e.g., "provider_user", "finance_manager")
   * @param token JWT access token
   */
  setUserSession(name: string, token: string): void {
    this.userSessions.set(name, {
      accessToken: token,
      subscriptions: {},
    })
  }

  /**
   * Get a user session by name.
   * @param name User identifier
   * @throws Error if session doesn't exist
   */
  private getUserSession(name: string): StoredUserSession {
    const session = this.userSessions.get(name)
    if (!session) {
      throw new Error(`User session "${name}" not found`)
    }
    return session
  }

  /**
   * Switch the current authentication context to a named user.
   * Does not create a new token, uses the stored token.
   * @param name User identifier
   */
  switchToUser(name: string): void {
    const session = this.getUserSession(name)
    this.accessToken = session.accessToken
  }

  /**
   * Create a new subscription state for a user.
   */
  private createSubscriptionState(): SubscriptionState {
    return {
      wsClient: null,
      appSyncClient: null,
      cleanup: null,
      events: [],
      error: null,
      eventNotifier: null,
    }
  }

  /**
   * Create a WebSocket client for a subscription state.
   */
  private getWsClientForSubscription(
    session: StoredUserSession,
    state: SubscriptionState,
  ): WsClient {
    if (!state.wsClient) {
      state.wsClient = createWsClient({
        url: getEffectiveWsEndpoint(),
        webSocketImpl: WebSocket,
        connectionParams: session.accessToken
          ? { token: session.accessToken }
          : undefined,
        // Handle connection errors gracefully (consistent with getWsClient)
        on: {
          error: (err) => {
            // Only set error if we haven't already cleaned up
            if (state.wsClient && !state.error) {
              state.error = err instanceof Error ? err : new Error(String(err))
            }
          },
        },
      })
    }
    return state.wsClient
  }

  /**
   * Map subscription type to AppSync Events collection name
   */
  private getCollectionForType(type: "todo" | "process" | "execution"): string {
    const mapping: Record<typeof type, string> = {
      todo: "todo",
      process: "process",
      execution: "execution",
    }
    return mapping[type]
  }

  /**
   * Subscribe a named user to a specific subscription type.
   * Waits for the WebSocket connection to be established before resolving.
   */
  private async subscribeUserToStream(
    name: string,
    type: "todo" | "process" | "execution",
    query: string,
  ): Promise<void> {
    const session = this.getUserSession(name)

    // Clean up any existing subscription of this type
    this.unsubscribeUserFromType(name, type)

    // Create fresh subscription state
    const state = this.createSubscriptionState()
    session.subscriptions[type] = state

    if (usesAppSyncEvents()) {
      await this.subscribeUserToStreamAppSync(name, session, state, type)
    } else {
      await this.subscribeUserToStreamGraphqlWs(name, session, state, query)
    }
  }

  /**
   * Subscribe user using AppSync Events
   */
  private async subscribeUserToStreamAppSync(
    name: string,
    session: StoredUserSession,
    state: SubscriptionState,
    type: "todo" | "process" | "execution",
  ): Promise<void> {
    const collection = this.getCollectionForType(type)
    const accessToken = session.accessToken
    const recipientId = await getAppSyncRecipientId(accessToken)

    const realtimeUrl = getAppSyncEventsRealtimeUrl()
    const httpHost = getAppSyncEventsHttpHost()

    if (!realtimeUrl || !httpHost) {
      throw new Error("AppSync configuration not available")
    }

    const channel = `/rxdb/collection/${collection}/user/${recipientId}`

    console.log(`[AppSync] User "${name}" subscribing to channel: ${channel}`)

    state.appSyncClient = new AppSyncEventsClient({
      realtimeUrl,
      httpHost,
      channel,
      accessToken,
      onEvent: (event) => {
        // Wrap in the same structure as graphql-ws
        const subscriptionField = `stream${collection.charAt(0).toUpperCase() + collection.slice(1)}`
        console.log(
          `[AppSync] User "${name}" received event on ${channel}:`,
          JSON.stringify(event).substring(0, 200),
        )
        state.events.push({
          data: { [subscriptionField]: event },
        })
        state.eventNotifier?.()
      },
      onError: (err) => {
        state.error = err
        console.error("[subscription] User error:", err.message)
        state.eventNotifier?.()
      },
    })

    await state.appSyncClient.connect()
    console.log(`[AppSync] User "${name}" connected to ${channel}`)
  }

  /**
   * Subscribe user using graphql-ws
   */
  private async subscribeUserToStreamGraphqlWs(
    name: string,
    session: StoredUserSession,
    state: SubscriptionState,
    query: string,
  ): Promise<void> {
    const client = this.getWsClientForSubscription(session, state)

    // Wait for connection to be established before returning
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error(`Subscription connection timeout for user "${name}"`))
      }, 3000)

      let removeConnectedListener: (() => void) | undefined
      let removeErrorListener: (() => void) | undefined

      const cleanup = () => {
        clearTimeout(timeout)
        removeConnectedListener?.()
        removeErrorListener?.()
      }

      removeConnectedListener = client.on("connected", () => {
        cleanup()
        resolve()
      })

      removeErrorListener = client.on("error", (err: unknown) => {
        cleanup()
        reject(err instanceof Error ? err : new Error(String(err)))
      })

      state.cleanup = client.subscribe(
        { query },
        {
          next: (value: { data?: unknown }) => {
            state.events.push({ data: value.data })
            state.eventNotifier?.()
          },
          error: (err: unknown) => {
            state.error = TestWorld.toError(err)
            console.error("[subscription] User error:", state.error.message)
            state.eventNotifier?.()
          },
          complete: () => {
            // Subscription completed normally
          },
        },
      )
    })
  }

  /**
   * Subscribe a named user to todo updates.
   * Waits for the WebSocket connection to be established before resolving.
   * @param name User identifier
   */
  async subscribeUserToTodos(name: string): Promise<void> {
    const query = `
      subscription StreamTodo {
        streamTodo {
          documents {
            id
            stepPath
            stepName
            deleted
            description
            summary {
              label
              value
            }
          }
          checkpoint {
            id
            updatedAt
          }
        }
      }
    `
    await this.subscribeUserToStream(name, "todo", query)
  }

  /**
   * Subscribe a named user to process updates.
   * Waits for the WebSocket connection to be established before resolving.
   * @param name User identifier
   */
  async subscribeUserToProcesses(name: string): Promise<void> {
    const query = `
      subscription StreamProcess {
        streamProcess {
          documents {
            id
            name
            activeInstances
            deleted
          }
          checkpoint {
            id
            updatedAt
          }
        }
      }
    `
    await this.subscribeUserToStream(name, "process", query)
  }

  /**
   * Subscribe a named user to execution updates.
   * Waits for the WebSocket connection to be established before resolving.
   * @param name User identifier
   */
  async subscribeUserToExecutions(name: string): Promise<void> {
    const query = `
      subscription StreamExecution {
        streamExecution {
          documents {
            id
            processName
            status
            deleted
          }
          checkpoint {
            id
            updatedAt
          }
        }
      }
    `
    await this.subscribeUserToStream(name, "execution", query)
  }

  /**
   * Extract todo documents from a user's subscription events.
   * Only returns active (non-deleted) todos.
   */
  private getUserTodoDocuments(name: string): Array<{
    stepName: string
    stepPath: string
    deleted: boolean
    summary: Array<{ label: string; value: string }>
  }> {
    const session = this.getUserSession(name)
    const state = session.subscriptions.todo
    if (!state) return []

    const todos: Array<{
      stepName: string
      stepPath: string
      deleted: boolean
      summary: Array<{ label: string; value: string }>
    }> = []

    for (const event of state.events) {
      const data = event.data as {
        streamTodo?: {
          documents?: Array<{
            stepName: string
            stepPath: string
            deleted: boolean
            summary: Array<{ label: string; value: string }>
          }>
        }
      }
      if (data?.streamTodo?.documents) {
        // Only include non-deleted todos (deleted: false means active)
        const activeTodos = data.streamTodo.documents.filter(
          (todo) => !todo.deleted,
        )
        todos.push(...activeTodos)
      }
    }
    return todos
  }

  /**
   * Extract process documents from a user's subscription events.
   * Returns all process documents (including updates).
   */
  private getUserProcessDocuments(name: string): Array<{
    id: string
    name: string
    activeInstances: number
    deleted: boolean
  }> {
    const session = this.getUserSession(name)
    const state = session.subscriptions.process
    if (!state) return []

    const processes: Array<{
      id: string
      name: string
      activeInstances: number
      deleted: boolean
    }> = []

    for (const event of state.events) {
      const data = event.data as {
        streamProcess?: {
          documents?: Array<{
            id: string
            name: string
            activeInstances: number
            deleted: boolean
          }>
        }
      }
      if (data?.streamProcess?.documents) {
        processes.push(...data.streamProcess.documents)
      }
    }
    return processes
  }

  /**
   * Extract execution documents from a user's subscription events.
   * Returns all execution documents.
   */
  private getUserExecutionDocuments(name: string): Array<{
    id: string
    processName: string
    status: string
    deleted: boolean
  }> {
    const session = this.getUserSession(name)
    const state = session.subscriptions.execution
    if (!state) return []

    const executions: Array<{
      id: string
      processName: string
      status: string
      deleted: boolean
    }> = []

    for (const event of state.events) {
      const data = event.data as {
        streamExecution?: {
          documents?: Array<{
            id: string
            processName: string
            status: string
            deleted: boolean
          }>
        }
      }
      if (data?.streamExecution?.documents) {
        executions.push(...data.streamExecution.documents)
      }
    }
    return executions
  }

  /**
   * Wait for a named user to see a todo with specific step name.
   * Uses event notification (no polling) - resolves when websocket event arrives.
   * @param name User identifier
   * @param stepName Expected step name (exact match)
   * @param timeoutMs Timeout in milliseconds (60s deployed, 10s local)
   */
  async waitForUserTodoStep(
    name: string,
    stepName: string,
    timeoutMs = websocketEventWaitMs(),
  ): Promise<void> {
    const session = this.getUserSession(name)
    const state = session.subscriptions.todo
    if (!state) {
      throw new Error(`User "${name}" is not subscribed to todo updates`)
    }
    let resolved = false

    // Check if todo already exists
    const checkForTodo = (): boolean => {
      if (!this.userSessions.has(name)) return false
      const todos = this.getUserTodoDocuments(name)
      return todos.some((todo) => todo.stepName === stepName)
    }

    // Already have the todo
    if (checkForTodo()) return

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (resolved) return
        resolved = true
        state.eventNotifier = null
        if (!this.userSessions.has(name)) {
          reject(new Error(`Session "${name}" was cleaned up during wait`))
          return
        }
        const todos = this.getUserTodoDocuments(name)
        reject(
          new Error(
            `Timeout waiting for "${name}" to see todo for step "${stepName}". ` +
              `Received todos: ${JSON.stringify(todos.map((t) => ({ stepName: t.stepName, summary: t.summary })))}`,
          ),
        )
      }, timeoutMs)

      // Called when websocket event arrives
      const onEvent = () => {
        if (resolved) return
        if (!this.userSessions.has(name)) {
          resolved = true
          clearTimeout(timeout)
          state.eventNotifier = null
          return
        }
        if (state.error) {
          resolved = true
          clearTimeout(timeout)
          state.eventNotifier = null
          reject(state.error)
          return
        }
        if (checkForTodo()) {
          resolved = true
          clearTimeout(timeout)
          state.eventNotifier = null
          resolve()
        }
        // If todo not found yet, keep waiting for next event
      }

      state.eventNotifier = onEvent
    })
  }

  /**
   * Wait for a named user to see a todo with specific step name and summary.
   * Uses event notification (no polling) - resolves when websocket event arrives.
   * @param name User identifier
   * @param stepName Expected step name (exact match)
   * @param label Summary label to check
   * @param expectedValue Expected value for the summary label
   * @param timeoutMs Timeout in milliseconds (60s deployed, 10s local)
   */
  async waitForUserTodoWithSummary(
    name: string,
    stepName: string,
    label: string,
    expectedValue: string,
    timeoutMs = websocketEventWaitMs(),
  ): Promise<void> {
    const session = this.getUserSession(name)
    const state = session.subscriptions.todo
    if (!state) {
      throw new Error(`User "${name}" is not subscribed to todo updates`)
    }
    let resolved = false

    // Check if todo already exists with expected summary
    const checkForTodo = (): boolean => {
      if (!this.userSessions.has(name)) return false
      const todos = this.getUserTodoDocuments(name)
      return todos.some(
        (todo) =>
          todo.stepName === stepName &&
          todo.summary?.some(
            (s) => s.label === label && s.value === expectedValue,
          ),
      )
    }

    // Already have the todo
    if (checkForTodo()) return

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (resolved) return
        resolved = true
        state.eventNotifier = null
        if (!this.userSessions.has(name)) {
          reject(new Error(`Session "${name}" was cleaned up during wait`))
          return
        }
        const todos = this.getUserTodoDocuments(name)
        reject(
          new Error(
            `Timeout waiting for "${name}" to see todo for step "${stepName}" with summary "${label}": "${expectedValue}". ` +
              `Received todos: ${JSON.stringify(todos.map((t) => ({ stepName: t.stepName, summary: t.summary })))}`,
          ),
        )
      }, timeoutMs)

      // Called when websocket event arrives
      const onEvent = () => {
        if (resolved) return
        if (!this.userSessions.has(name)) {
          resolved = true
          clearTimeout(timeout)
          state.eventNotifier = null
          return
        }
        if (state.error) {
          resolved = true
          clearTimeout(timeout)
          state.eventNotifier = null
          reject(state.error)
          return
        }
        if (checkForTodo()) {
          resolved = true
          clearTimeout(timeout)
          state.eventNotifier = null
          resolve()
        }
        // If todo not found yet, keep waiting for next event
      }

      state.eventNotifier = onEvent
    })
  }

  /**
   * Wait for a named user to see a todo with a specific step name and summary label present (pattern match).
   * Uses event notification (no polling) - resolves when websocket event arrives.
   * @param name User identifier
   * @param stepName Expected step name
   * @param label Summary label to check (value just needs to exist, not match a specific value)
   * @param timeoutMs Timeout in milliseconds (60s deployed, 25s local)
   */
  async waitForUserTodoWithSummaryPattern(
    name: string,
    stepName: string,
    label: string,
    timeoutMs = websocketEventWaitMs(25_000),
  ): Promise<void> {
    const session = this.getUserSession(name)
    const state = session.subscriptions.todo
    if (!state) {
      throw new Error(`User "${name}" is not subscribed to todo updates`)
    }
    let resolved = false

    // Check if todo already exists with the summary label present
    const checkForTodo = (): boolean => {
      if (!this.userSessions.has(name)) return false
      const todos = this.getUserTodoDocuments(name)
      return todos.some(
        (todo) =>
          todo.stepName === stepName &&
          todo.summary?.some((s) => s.label === label && s.value),
      )
    }

    // Already have the todo
    if (checkForTodo()) return

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (resolved) return
        resolved = true
        state.eventNotifier = null
        if (!this.userSessions.has(name)) {
          reject(new Error(`Session "${name}" was cleaned up during wait`))
          return
        }
        const todos = this.getUserTodoDocuments(name)
        reject(
          new Error(
            `Timeout waiting for "${name}" to see todo for step "${stepName}" with summary "${label}" present. ` +
              `Received todos: ${JSON.stringify(todos.map((t) => ({ stepName: t.stepName, summary: t.summary })))}`,
          ),
        )
      }, timeoutMs)

      // Called when websocket event arrives
      const onEvent = () => {
        if (resolved) return
        if (!this.userSessions.has(name)) {
          resolved = true
          clearTimeout(timeout)
          state.eventNotifier = null
          return
        }
        if (state.error) {
          resolved = true
          clearTimeout(timeout)
          state.eventNotifier = null
          reject(state.error)
          return
        }
        if (checkForTodo()) {
          resolved = true
          clearTimeout(timeout)
          state.eventNotifier = null
          resolve()
        }
        // If todo not found yet, keep waiting for next event
      }

      state.eventNotifier = onEvent
    })
  }

  /**
   * Wait for a named user to see a process update with specific name and active instances.
   * Uses event notification (no polling) - resolves when websocket event arrives.
   * @param name User identifier
   * @param processName Expected process name
   * @param expectedActiveInstances Expected number of active instances
   * @param timeoutMs Timeout in milliseconds (60s deployed, 25s local)
   */
  async waitForUserProcessUpdate(
    name: string,
    processName: string,
    expectedActiveInstances: number,
    timeoutMs = websocketEventWaitMs(25_000),
  ): Promise<void> {
    const session = this.getUserSession(name)
    const state = session.subscriptions.process
    if (!state) {
      throw new Error(`User "${name}" is not subscribed to process updates`)
    }
    let resolved = false

    // Check if process update already exists with expected activeInstances
    const checkForProcess = (): boolean => {
      if (!this.userSessions.has(name)) return false
      const processes = this.getUserProcessDocuments(name)
      return processes.some(
        (p) =>
          p.name === processName &&
          p.activeInstances === expectedActiveInstances &&
          !p.deleted,
      )
    }

    // Already have the process update
    if (checkForProcess()) return

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (resolved) return
        resolved = true
        state.eventNotifier = null
        if (!this.userSessions.has(name)) {
          reject(new Error(`Session "${name}" was cleaned up during wait`))
          return
        }
        const processes = this.getUserProcessDocuments(name)
        reject(
          new Error(
            `Timeout waiting for "${name}" to see process update for "${processName}" with ${expectedActiveInstances} active instance(s). ` +
              `Received processes: ${JSON.stringify(processes.map((p) => ({ name: p.name, activeInstances: p.activeInstances })))}`,
          ),
        )
      }, timeoutMs)

      // Called when websocket event arrives
      const onEvent = () => {
        if (resolved) return
        if (!this.userSessions.has(name)) {
          resolved = true
          clearTimeout(timeout)
          state.eventNotifier = null
          return
        }
        if (state.error) {
          resolved = true
          clearTimeout(timeout)
          state.eventNotifier = null
          reject(state.error)
          return
        }
        if (checkForProcess()) {
          resolved = true
          clearTimeout(timeout)
          state.eventNotifier = null
          resolve()
        }
        // If process not found yet, keep waiting for next event
      }

      state.eventNotifier = onEvent
    })
  }

  /**
   * Wait for a named user to see a new execution for a process.
   * Uses event notification (no polling) - resolves when websocket event arrives.
   * @param name User identifier
   * @param processName Expected process name
   * @param timeoutMs Timeout in milliseconds (60s deployed, 10s local)
   */
  async waitForUserNewExecution(
    name: string,
    processName: string,
    timeoutMs = websocketEventWaitMs(),
  ): Promise<void> {
    const session = this.getUserSession(name)
    const state = session.subscriptions.execution
    if (!state) {
      throw new Error(`User "${name}" is not subscribed to execution updates`)
    }
    let resolved = false

    // Check if execution already exists with status "Running"
    const checkForExecution = (): boolean => {
      if (!this.userSessions.has(name)) return false
      const executions = this.getUserExecutionDocuments(name)
      return executions.some(
        (e) =>
          e.processName === processName && e.status === "Running" && !e.deleted,
      )
    }

    // Already have the execution
    if (checkForExecution()) return

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (resolved) return
        resolved = true
        state.eventNotifier = null
        if (!this.userSessions.has(name)) {
          reject(new Error(`Session "${name}" was cleaned up during wait`))
          return
        }
        const executions = this.getUserExecutionDocuments(name)
        reject(
          new Error(
            `Timeout waiting for "${name}" to see new execution for "${processName}". ` +
              `Received executions: ${JSON.stringify(executions.map((e) => ({ processName: e.processName, status: e.status })))}`,
          ),
        )
      }, timeoutMs)

      // Called when websocket event arrives
      const onEvent = () => {
        if (resolved) return
        if (!this.userSessions.has(name)) {
          resolved = true
          clearTimeout(timeout)
          state.eventNotifier = null
          return
        }
        if (state.error) {
          resolved = true
          clearTimeout(timeout)
          state.eventNotifier = null
          reject(state.error)
          return
        }
        if (checkForExecution()) {
          resolved = true
          clearTimeout(timeout)
          state.eventNotifier = null
          resolve()
        }
        // If execution not found yet, keep waiting for next event
      }

      state.eventNotifier = onEvent
    })
  }

  /**
   * Assert that a named user has not received any todo notifications.
   * Waits to ensure no late-arriving events (accounts for job worker polling).
   * @param name User identifier
   * @param waitMs Wait time in milliseconds (default 4000)
   */
  async assertNoUserTodos(name: string, waitMs = 4000): Promise<void> {
    // Wait the minimum time
    await new Promise((resolve) => setTimeout(resolve, waitMs))

    const todos = this.getUserTodoDocuments(name)
    if (todos.length > 0) {
      throw new Error(
        `Expected "${name}" to have no todos, but received: ${JSON.stringify(todos.map((t) => t.stepName))}`,
      )
    }
  }

  /**
   * Assert that a named user has not received any process update notifications.
   * Waits to ensure no late-arriving events (accounts for job worker polling).
   * @param name User identifier
   * @param waitMs Wait time in milliseconds (default 4000)
   */
  async assertNoUserProcessUpdates(name: string, waitMs = 4000): Promise<void> {
    // Wait the minimum time
    await new Promise((resolve) => setTimeout(resolve, waitMs))

    const processes = this.getUserProcessDocuments(name)
    if (processes.length > 0) {
      throw new Error(
        `Expected "${name}" to have no process updates, but received: ${JSON.stringify(processes.map((p) => ({ name: p.name, activeInstances: p.activeInstances })))}`,
      )
    }
  }

  /**
   * Clear subscription events for a named user.
   * Used to reset state between test phases.
   * @param name User identifier
   */
  clearUserEvents(name: string): void {
    const session = this.userSessions.get(name)
    if (session) {
      for (const state of Object.values(session.subscriptions)) {
        if (state) {
          state.events = []
        }
      }
    }
  }

  /**
   * Clear subscription events for all named users.
   */
  clearAllUserEvents(): void {
    for (const session of this.userSessions.values()) {
      for (const state of Object.values(session.subscriptions)) {
        if (state) {
          state.events = []
        }
      }
    }
  }

  /**
   * Unsubscribe a named user from a specific subscription type.
   * @param name User identifier
   * @param type Subscription type
   */
  unsubscribeUserFromType(
    name: string,
    type: "todo" | "process" | "execution",
  ): void {
    const session = this.userSessions.get(name)
    if (!session) return

    const state = session.subscriptions[type]
    if (!state) return

    if (state.cleanup) {
      state.cleanup()
      state.cleanup = null
    }
    if (state.wsClient) {
      state.wsClient.dispose()
      state.wsClient = null
    }
    if (state.appSyncClient) {
      state.appSyncClient.disconnect()
      state.appSyncClient = null
    }
    delete session.subscriptions[type]
  }

  /**
   * Unsubscribe a named user and close all their WebSocket clients.
   * @param name User identifier
   */
  unsubscribeUser(name: string): void {
    const session = this.userSessions.get(name)
    if (!session) return

    for (const type of ["todo", "process", "execution"] as const) {
      this.unsubscribeUserFromType(name, type)
    }
  }

  /**
   * Unsubscribe all named users and close their WebSocket clients.
   */
  unsubscribeAllUsers(): void {
    for (const name of this.userSessions.keys()) {
      this.unsubscribeUser(name)
    }
    this.userSessions.clear()
  }

  /**
   * Attempt to subscribe to another user's subscription channel.
   * Used for testing cross-user authorization.
   * Only works with AppSync Events (AWS mode).
   * @param subscriberName The name of the user attempting to subscribe
   * @param collection The subscription collection (e.g., "todo", "process")
   * @param targetName The stored session whose actual recipient is targeted
   * @returns Error if subscription was rejected, null if succeeded
   */
  async trySubscribeToOtherUserChannel(
    subscriberName: string,
    collection: string,
    targetName: string,
  ): Promise<Error | null> {
    const session = this.getUserSession(subscriberName)
    const accessToken = session.accessToken
    const targetSession = this.getUserSession(targetName)
    const recipientId = await getAppSyncRecipientId(targetSession.accessToken)
    if (recipientId === (await getAppSyncRecipientId(accessToken))) {
      throw new Error(
        "Cross-user subscription test requires distinct realtime recipients",
      )
    }

    const realtimeUrl = getAppSyncEventsRealtimeUrl()
    const httpHost = getAppSyncEventsHttpHost()

    if (!realtimeUrl || !httpHost) {
      return new Error("AppSync configuration not available")
    }

    // Use the target's full authority/expiry, but authenticate as the subscriber.
    const channel = `/rxdb/collection/${collection}/user/${recipientId}`

    console.log(
      `[AppSync] User "${subscriberName}" attempting to subscribe to other user's channel: ${channel}`,
    )

    return new Promise((resolve) => {
      let resolved = false

      const client = new AppSyncEventsClient({
        realtimeUrl,
        httpHost,
        channel,
        accessToken,
        onEvent: () => {
          // If we receive events, subscription succeeded (unexpected security issue)
          if (resolved) return
          resolved = true
          console.log(
            `[AppSync] User "${subscriberName}" unexpectedly received event on ${channel}`,
          )
          client.disconnect()
          resolve(null)
        },
        onError: (err) => {
          // Guard against double resolution (connect().catch may also fire)
          if (resolved) return
          resolved = true
          console.log(
            `[AppSync] User "${subscriberName}" received error on ${channel}: ${err.message}`,
          )
          // Error during subscription - this is expected for authorization failure
          client.disconnect()
          resolve(err)
        },
      })

      client
        .connect()
        .then(() => {
          // Connection succeeded - subscription was not rejected
          if (resolved) return
          resolved = true
          console.log(
            `[AppSync] User "${subscriberName}" unexpectedly connected to ${channel}`,
          )
          client.disconnect()
          resolve(null)
        })
        .catch((err: unknown) => {
          // Connection rejected - this is the expected authorization failure
          if (resolved) return
          resolved = true
          console.log(
            `[AppSync] User "${subscriberName}" connection rejected for ${channel}: ${err instanceof Error ? err.message : String(err)}`,
          )
          client.disconnect()
          resolve(err instanceof Error ? err : new Error(String(err)))
        })
    })
  }
}

setWorldConstructor(TestWorld)
