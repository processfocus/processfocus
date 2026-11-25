import { Effect } from "effect"
import { WorkloadAuthenticationError } from "@pf/openauth/github-workload"
import { createDeployProgressEventSource } from "../src/utils/deploy-progress-subscription"
import type { DeployProgressEvent } from "../src/utils/deploy-progress-subscription.types"
import { describe, expect, it } from "bun:test"

// Real sockets and production reconnect backoff make this a slow-test suite.
describe("deploy progress connection recovery", () => {
  it.each([
    {
      name: "fresh credentials",
      failedHandshakes: 0,
      disruptions: 1,
      terminate: false,
    },
    {
      name: "renewal denied",
      failedHandshakes: 0,
      disruptions: 1,
      terminate: false,
    },
    {
      name: "clean close",
      failedHandshakes: 0,
      disruptions: 1,
      terminate: false,
    },
    {
      name: "failed handshake",
      failedHandshakes: 1,
      disruptions: 1,
      terminate: false,
    },
    {
      name: "exhausted retries",
      failedHandshakes: 3,
      disruptions: 1,
      terminate: false,
    },
    {
      name: "repeated disruptions",
      failedHandshakes: 0,
      disruptions: 4,
      terminate: false,
    },
    {
      name: "transport termination",
      failedHandshakes: 0,
      disruptions: 1,
      terminate: true,
    },
    {
      name: "transport error event",
      failedHandshakes: 0,
      disruptions: 1,
      terminate: false,
    },
  ])(
    "recovers progress or reports exhausted retries: $name",
    async ({ name, failedHandshakes, disruptions, terminate }) => {
      const channels: string[] = []
      let handshakes = 0
      let acquisitions = 0
      const connectionTokens: string[] = []
      const subscriptionTokens: unknown[] = []
      const event: DeployProgressEvent = {
        version: 1,
        executionId: "execution-1",
        phase: "cdn",
        status: "progress",
        message: "CDN deployed",
        timestamp: "2026-10-12T00:25:00.000Z",
      }
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request, server) => {
          const protocol = request.headers
            .get("sec-websocket-protocol")
            ?.split(",")
            .map((value) => value.trim())
            .find((value) => value.startsWith("header-"))
          if (protocol)
            connectionTokens.push(
              JSON.parse(Buffer.from(protocol.slice(7), "base64url").toString())
                .authorization,
            )
          return server.upgrade(request)
            ? undefined
            : new Response("upgrade required", { status: 400 })
        },
        websocket: {
          message: (socket, raw) => {
            const message: unknown = JSON.parse(raw.toString())
            if (
              typeof message !== "object" ||
              message === null ||
              !("type" in message)
            )
              return
            if (message.type === "connection_init") {
              handshakes++
              if (handshakes > 1 && handshakes <= failedHandshakes + 1) {
                socket.close(1000)
                return
              }
              socket.send(
                JSON.stringify({
                  type: "connection_ack",
                  connectionTimeoutMs: 300000,
                }),
              )
            } else if (
              message.type === "subscribe" &&
              "id" in message &&
              "channel" in message &&
              typeof message.channel === "string"
            ) {
              channels.push(message.channel)
              if (
                "authorization" in message &&
                typeof message.authorization === "object" &&
                message.authorization !== null &&
                "authorization" in message.authorization
              )
                subscriptionTokens.push(message.authorization.authorization)
              socket.send(
                JSON.stringify({ type: "subscribe_success", id: message.id }),
              )
              if (channels.length <= disruptions) {
                if (name === "transport error event") return
                // Close after the subscription handshake, as in the production incident.
                setTimeout(
                  () => (terminate ? socket.terminate() : socket.close(1000)),
                  20,
                )
              } else {
                socket.send(
                  JSON.stringify({
                    type: "data",
                    id: message.id,
                    event: JSON.stringify(event),
                  }),
                )
              }
            }
          },
        },
      })
      const NativeWebSocket = globalThis.WebSocket
      let client: WebSocket | undefined
      if (name === "transport error event") {
        // Bun's server-side terminate produces close 1006, not an error event.
        // Retain the real socket/handshake and inject only that transport signal.
        globalThis.WebSocket = class extends NativeWebSocket {
          readonly capturedForTransportError = (() => {
            client = this
          })()
        }
      }
      const source = await Effect.runPromise(
        createDeployProgressEventSource({
          realtimeUrl: `ws://127.0.0.1:${server.port}`,
          appSyncEventsHttpHost: "localhost",
          accessToken: "fixture-token",
          ...(["fresh credentials", "renewal denied"].includes(name)
            ? {
                acquireAccessToken: async () => {
                  acquisitions++
                  if (name === "renewal denied" && acquisitions > 1)
                    throw new WorkloadAuthenticationError({
                      message: "Workload trust removed",
                    })
                  return `fresh-${acquisitions}`
                },
              }
            : {}),
          channel: "/cloud/deploy/user-1/execution-1",
        }),
      )
        .catch((error: unknown) => {
          server.stop(true)
          throw error
        })
        .finally(() => {
          globalThis.WebSocket = NativeWebSocket
        })
      try {
        client?.dispatchEvent(new Event("error"))
        if (name === "renewal denied") {
          await expect(source[Symbol.asyncIterator]().next()).rejects.toThrow(
            "Workload trust removed",
          )
          expect(handshakes).toBe(1)
          return
        }
        if (failedHandshakes === 3) {
          await expect(source[Symbol.asyncIterator]().next()).rejects.toThrow(
            "Reconnection attempts exhausted",
          )
          expect(handshakes).toBe(4)
          return
        }
        const next = await source[Symbol.asyncIterator]().next()
        expect(next).toEqual({ done: false, value: event })
        expect(channels).toHaveLength(disruptions + 1)
        if (name === "fresh credentials") {
          expect(connectionTokens).toEqual(["fresh-1", "fresh-2"])
          expect(subscriptionTokens).toEqual(["fresh-1", "fresh-2"])
        }
        expect(
          channels.every(
            (channel) => channel === "/cloud/deploy/user-1/execution-1",
          ),
        ).toBe(true)
      } finally {
        await source.close()
        server.stop(true)
      }
    },
    20000,
  )
})
