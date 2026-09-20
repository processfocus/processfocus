import { readFileSync, writeFileSync } from "node:fs"
import { Data, Effect, Schema } from "effect"
import {
  type PortFileContent,
  PortFileContentJson,
  decodePortFromFileContent,
} from "./services/port-file"

/**
 * Error thrown when no available port is found in the specified range.
 */
export class NoAvailablePortError extends Data.TaggedError(
  "NoAvailablePortError",
)<{
  readonly startPort: number
  readonly endPort: number
}> {}

/**
 * Error thrown when an exact port is requested but is already in use.
 */
export class PortInUseError extends Data.TaggedError("PortInUseError")<{
  readonly port: number
}> {}

/**
 * Error thrown when the server fails to start for reasons other than port in use.
 */
export class ServerStartError extends Data.TaggedError("ServerStartError")<{
  readonly port: number
  readonly cause: unknown
}> {}

/**
 * Checks if an error indicates the port is already in use.
 */
const isPortInUseError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "EADDRINUSE"

/**
 * Error from attempting to start a server on a specific port.
 */
class PortBindError extends Data.TaggedError("PortBindError")<{
  readonly port: number
  readonly cause: unknown
}> {}

/**
 * A Bun.Server that was started on a TCP port (not a unix socket).
 * Guarantees that `port` and `hostname` are defined.
 */
export type TcpServer<T = unknown> = Bun.Server<T> & {
  readonly port: number
  readonly hostname: string
}

/**
 * Attempts to start a server on a given port.
 */
const tryServeOnPort = <T>(
  serverOptions: Omit<Bun.Serve.Options<T>, "port">,
  port: number,
): Effect.Effect<Bun.Server<T>, PortBindError> =>
  Effect.try({
    try: () =>
      Bun.serve<T>({
        ...serverOptions,
        port,
        // Bun can default to port sharing with development:false; local orgs must not share listeners.
        reusePort: false,
      } as Bun.Serve.Options<T>),
    catch: (cause) => new PortBindError({ port, cause }),
  })

/**
 * Starts a Bun server on an exact port without fallback.
 *
 * If the port is in use, fails with PortInUseError.
 * Use this when a specific port is required (e.g., in e2e tests).
 *
 * @param port - The exact port to start on
 * @param serverOptions - Bun.serve options (without port)
 * @returns Effect that resolves to the started Bun.Server or fails with PortInUseError
 */
export const serveOnExactPort = <T>(
  port: number,
  serverOptions: Omit<Bun.Serve.Options<T>, "port">,
): Effect.Effect<TcpServer<T>, PortInUseError | ServerStartError> =>
  tryServeOnPort(serverOptions, port).pipe(
    Effect.mapError((err) => {
      if (isPortInUseError(err.cause)) {
        return new PortInUseError({ port })
      }
      return new ServerStartError({ port, cause: err.cause })
    }),
    Effect.map((server) => server as TcpServer<T>),
  )

/**
 * Attempts to start a Bun server, automatically finding an available port
 * if the requested port is in use.
 *
 * Tries ports sequentially from basePort to basePort + maxAttempts - 1.
 * Logs a warning if a fallback port is used.
 *
 * @param basePort - The preferred port to start on
 * @param serverOptions - Bun.serve options (without port)
 * @param maxAttempts - Maximum number of ports to try (default: 10)
 * @returns Effect that resolves to the started Bun.Server
 */
export const serveWithPortFallback = <T>(
  basePort: number,
  serverOptions: Omit<Bun.Serve.Options<T>, "port">,
  maxAttempts = 10,
): Effect.Effect<TcpServer<T>, NoAvailablePortError | ServerStartError> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const port = basePort + attempt

      const result = yield* tryServeOnPort(serverOptions, port).pipe(
        Effect.matchEffect({
          onSuccess: (server) =>
            Effect.succeed({ _tag: "success" as const, server }),
          onFailure: (err) => {
            if (isPortInUseError(err.cause)) {
              return Effect.succeed({ _tag: "port-in-use" as const })
            }
            return Effect.fail(new ServerStartError({ port, cause: err.cause }))
          },
        }),
      )

      if (result._tag === "success") {
        if (attempt > 0) {
          yield* Effect.logWarning(
            `Port ${basePort} was in use, using port ${port} instead`,
          )
        }
        return result.server as TcpServer<T>
      }

      // Port in use - log and continue
      if (attempt < maxAttempts - 1) {
        yield* Effect.logDebug(`Port ${port} in use, trying ${port + 1}...`)
      }
    }

    // All ports exhausted
    return yield* new NoAvailablePortError({
      startPort: basePort,
      endPort: basePort + maxAttempts - 1,
    })
  })

/**
 * Error thrown when writing the port file fails.
 */
export class PortFileWriteError extends Data.TaggedError("PortFileWriteError")<{
  readonly filename: string
  readonly port: number
  readonly cause: unknown
}> {}

/**
 * Reads the current port from a JSON file, returning undefined if file doesn't exist.
 */
const readCurrentPort = (filename: string): number | undefined => {
  try {
    return decodePortFromFileContent(readFileSync(filename, "utf-8"))
  } catch {
    return undefined
  }
}

/**
 * Writes the server port to a JSON file for service discovery.
 * Only writes if the port has changed from the current value.
 *
 * The file format is JSON: {"port": 4000}
 * This allows bun --watch to detect changes when the file is imported.
 *
 * @param filename - The filename to write to (relative to cwd), should end in .json
 * @param port - The port number to write
 */
export const writePortFile = (
  filename: string,
  port: number,
): Effect.Effect<void, PortFileWriteError> =>
  Effect.sync(() => readCurrentPort(filename)).pipe(
    Effect.flatMap((currentPort) => {
      if (currentPort === port) {
        return Effect.logDebug(
          `Port file ${filename} already contains ${port}, skipping write`,
        )
      }
      const content: PortFileContent = { port }
      return Schema.encode(PortFileContentJson)(content).pipe(
        Effect.mapError(
          (cause) => new PortFileWriteError({ filename, port, cause }),
        ),
        Effect.flatMap((encodedContent) =>
          Effect.try({
            try: () => writeFileSync(filename, `${encodedContent}\n`, "utf-8"),
            catch: (cause) => new PortFileWriteError({ filename, port, cause }),
          }),
        ),
        Effect.tap(() => Effect.logDebug(`Wrote port ${port} to ${filename}`)),
      )
    }),
  )
