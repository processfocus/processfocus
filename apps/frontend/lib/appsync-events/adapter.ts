import type { DocumentsWithCheckpoint } from "rxdb"
import { type Observable, Subject } from "rxjs"
import { filter, map } from "rxjs/operators"
import { AppSyncEventsClient } from "./client"
import { getAppSyncEventsRealtimeUrl } from "./config"
import { registerAdapter, unregisterAdapter } from "./reconnect-registry"

interface RxDbDocument {
  id: string
  updatedAt: number
  deleted: boolean
}

interface AppSyncEventsAdapterConfig {
  /**
   * AppSync Events HTTP host. We need this for authentication.
   */
  httpHost: string

  /**
   * Channel to subscribe to.
   */
  channel: string
  isCurrent?: () => boolean
  expiresAt?: number
}

/**
 * Adapter that bridges AppSync Events WebSocket to RxDB replication stream
 */
export class AppSyncEventsAdapter<
  RxDocType extends RxDbDocument,
  CheckpointType,
> {
  private pullStream$ = new Subject<
    DocumentsWithCheckpoint<RxDocType, CheckpointType>
  >()
  private client: AppSyncEventsClient | null = null

  constructor(private config: AppSyncEventsAdapterConfig) {}

  async connect() {
    if (this.client) {
      console.warn("Already connected to AppSync Events")
      return
    }

    this.client = new AppSyncEventsClient({
      realtimeUrl: getAppSyncEventsRealtimeUrl(),
      httpHost: this.config.httpHost,
      channel: this.config.channel,
      ...(this.config.isCurrent ? { isCurrent: this.config.isCurrent } : {}),
      ...(this.config.expiresAt !== undefined
        ? { expiresAt: this.config.expiresAt }
        : {}),
      onEvent: (eventData: string) => {
        try {
          // What we possibly should do here is validate input against schema?
          // Because if the schema isn't correct, rxdb will ignore the
          // document without waring.
          const bulk = JSON.parse(eventData) as DocumentsWithCheckpoint<
            RxDocType,
            CheckpointType
          >
          this.pullStream$.next(bulk)
        } catch (error) {
          console.error("Failed to parse event:", error)
        }
      },
      onError: (error) => {
        console.error("AppSync Events error:", error)
        this.pullStream$.error(error)
      },
      onConnect: () => {
        console.log("Connected to AppSync Events channel:", this.config.channel)
      },
      onDisconnect: () => {
        console.log("Disconnected from AppSync Events")
      },
    })

    this.client.connect()

    // Register for teardown on session refresh or expiry.
    registerAdapter(this)
  }

  disconnect() {
    // Unregister from reconnection registry
    unregisterAdapter(this)

    if (this.client) {
      this.client.disconnect()
      this.client = null
    }
  }

  /**
   * Reconnect to AppSync Events with fresh credentials.
   * Used when token is refreshed to ensure WebSocket uses new auth.
   */
  reconnect() {
    if (this.client) {
      this.client.reconnect()
    }
  }

  getStream(): Observable<DocumentsWithCheckpoint<RxDocType, CheckpointType>> {
    // Transform documents to use RxDB's _deleted field convention for the stream
    // RxDB will then map _deleted to the configured deletedField ("deleted") in storage
    // Filter out events with null checkpoints (no more documents to sync)
    return this.pullStream$.pipe(
      filter(
        (bulk) => bulk.checkpoint !== null && bulk.checkpoint !== undefined,
      ),
      map((bulk) => {
        console.log("getStream")
        return {
          documents: bulk.documents.map((doc) => ({
            ...doc,
            _deleted: doc.deleted,
          })),
          checkpoint: bulk.checkpoint,
        }
      }),
    )
  }
}
