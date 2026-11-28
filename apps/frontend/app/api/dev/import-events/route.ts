import { mkdirSync, readFileSync, watch } from "node:fs"
import { join, resolve } from "node:path"
import { Schema } from "effect"
import { connection } from "next/server"
import { addImportCompletedSubscriber } from "@/lib/dev/import-completed-events"

const encoder = new TextEncoder()
const decodeReady = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      revision: Schema.String,
      processPaths: Schema.Array(Schema.String),
    }),
  ),
)

// Register before reading: a save between subscribing and the initial read
// cannot be missed. EventSource supplies the last delivered revision on reconnect.
function subscribeToGraphqlReady(
  directory: string,
  lastRevision: string | null,
  controller: ReadableStreamDefaultController<Uint8Array>,
) {
  let revision = lastRevision
  mkdirSync(directory, { recursive: true })
  const watcher = watch(directory, (_, name) => {
    if (!name || name === "ready.json") publish()
  })
  function fail(error: unknown) {
    watcher.close()
    controller.error(error)
  }
  function publish() {
    try {
      const ready = decodeReady(
        readFileSync(join(directory, "ready.json"), "utf8"),
      )
      if (ready.revision === revision) return
      // The initial read refreshes list discovery without restarting replication.
      const payload = {
        processPaths: revision === null ? [] : ready.processPaths,
      }
      revision = ready.revision
      controller.enqueue(
        encoder.encode(`id: ${revision}\ndata: ${JSON.stringify(payload)}\n\n`),
      )
    } catch (error) {
      // The Dashboard can start before the first GraphQL listener.
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return
      fail(error)
    }
  }
  watcher.on("error", fail)
  publish()
  return () => watcher.close()
}

export async function GET(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return new Response("Not found", { status: 404 })
  }

  await connection()

  let unsubscribe: (() => void) | undefined
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"))

      const org = process.env["PF_ORG"]
      if (process.env["PF_LOCAL_GRAPHQL_IMPORT"] === "1" && org) {
        const directory = resolve(
          process.env["NX_WORKSPACE_ROOT"] ?? process.cwd(),
          org,
          ".processfocus/local-graphql",
        )
        unsubscribe = subscribeToGraphqlReady(
          directory,
          request.headers.get("last-event-id"),
          controller,
        )
        return
      }

      unsubscribe = addImportCompletedSubscriber({
        send: (payload) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
          )
        },
      })
    },
    cancel() {
      unsubscribe?.()
    },
  })

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    },
  })
}
