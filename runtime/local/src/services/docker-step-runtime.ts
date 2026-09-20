import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  ExecutorError,
  ExecutorHost,
  type ExecutorInvocation,
  type ExecutorJobContext,
} from "@processfocus/runtime"
import { Data, Effect, Either, Layer, Schema } from "effect"

const localInternalApiSecret =
  process.env["INTERNAL_API_SECRET"] ?? "dev-secret"
const MAX_TAIL = 16_384

const trimTail = (value: string) =>
  value.length <= MAX_TAIL ? value : value.slice(value.length - MAX_TAIL)

type CommandResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type RunCommand = (
  command: string,
  args: readonly string[],
) => Promise<CommandResult>

const runCommand: RunCommand = (
  command: string,
  args: readonly string[],
): Promise<CommandResult> =>
  new Promise((resolvePromise, reject) => {
    const proc = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString()
      process.stdout.write(text)
      stdout = trimTail(stdout + text)
    })
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString()
      process.stderr.write(text)
      stderr = trimTail(stderr + text)
    })

    proc.once("error", reject)
    proc.once("close", (code) =>
      resolvePromise({ exitCode: code ?? 1, stdout, stderr }),
    )
  })

const buildImageTag = (stepPath: string) => {
  const suffix = createHash("sha256")
    .update(stepPath)
    .digest("hex")
    .slice(0, 16)
  return `pf-docker-step-${suffix}`
}

const resolveDockerfilePath = (contextPath: string, dockerfile: string) =>
  resolve(contextPath, dockerfile)

type DockerStepResultEnvelope = {
  readonly status?: string
  readonly output?: unknown
  readonly error?: string | null
  readonly exitCode?: number
  readonly stdoutTail?: string
  readonly stderrTail?: string
}

const JsonValue = Schema.parseJson(Schema.Unknown)

class DockerStepResultParseError extends Data.TaggedError(
  "DockerStepResultParseError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

const parseResult = (resultPath: string) =>
  Effect.gen(function* () {
    const resultText = yield* Effect.tryPromise({
      try: () => readFile(resultPath, "utf8"),
      catch: (cause) =>
        new DockerStepResultParseError({
          message: "Failed to read Docker step result envelope",
          cause,
        }),
    })

    return yield* Schema.decodeUnknown(JsonValue)(resultText).pipe(
      Effect.map((result) => result as DockerStepResultEnvelope),
      Effect.mapError(
        (cause) =>
          new DockerStepResultParseError({
            message: "Failed to parse Docker step result envelope",
            cause,
          }),
      ),
    )
  })

const normalizeLogText = (value: string | null | undefined) => {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

const formatFailureMessage = (params: {
  readonly title: string
  readonly exitCode: number | undefined
  readonly error: string | null | undefined
  readonly stderrTail: string | undefined
  readonly stdoutTail: string | undefined
  readonly stderr: string | undefined
  readonly stdout: string | undefined
}) => {
  const details = [
    normalizeLogText(params.error),
    normalizeLogText(params.stderrTail),
    normalizeLogText(params.stderr),
    normalizeLogText(params.stdoutTail),
    normalizeLogText(params.stdout),
    typeof params.exitCode === "number"
      ? `Exit code ${params.exitCode}`
      : undefined,
  ].filter((detail, index, values): detail is string => {
    return typeof detail === "string" && values.indexOf(detail) === index
  })

  return [params.title, ...details].join("\n")
}

/**
 * Create a per-step host work directory and remove it when the surrounding
 * scope closes. Cleanup failures are logged and swallowed so they never mask
 * the step result.
 *
 * Exported for unit tests that assert the directory is removed after use.
 */
export const acquireDockerStepWorkDir = Effect.acquireRelease(
  Effect.tryPromise({
    try: () => mkdtemp(join(tmpdir(), "pf-docker-step-")),
    catch: (error) =>
      new ExecutorError({
        message: `Failed to create Docker step work directory: ${String(error)}`,
        cause: error,
      }),
  }),
  (hostWorkDir) =>
    Effect.tryPromise({
      try: () => rm(hostWorkDir, { recursive: true, force: true }),
      catch: (cause) => cause,
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.logWarning("Failed to clean up Docker step work directory", {
          hostWorkDir,
          error: String(cause),
        }),
      ),
    ),
)

export const makeLocalExecutorHostLayer = (
  orgPath: string,
  options?: { readonly runCommand?: RunCommand },
) => {
  const executeCommand = options?.runCommand ?? runCommand

  return Layer.succeed(ExecutorHost, {
    run: (invocation: ExecutorInvocation, jobContext: ExecutorJobContext) =>
      Effect.scoped(
        Effect.gen(function* () {
          const contextPath = resolve(orgPath, invocation.source.context)
          const dockerfilePath = resolveDockerfilePath(
            contextPath,
            invocation.source.definition,
          )
          const imageTag = buildImageTag(jobContext.stepPath)

          const hostWorkDir = yield* acquireDockerStepWorkDir
          const inputPath = join(hostWorkDir, "input.json")
          const resultPath = join(hostWorkDir, "result.json")
          const encodedInput = yield* Schema.encode(JsonValue)(
            invocation.input,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ExecutorError({
                  message: "Failed to encode Docker step input manifest",
                  cause,
                }),
            ),
          )

          yield* Effect.tryPromise({
            try: () =>
              // mkdtemp already created hostWorkDir; write input file directly
              writeFile(inputPath, encodedInput),
            catch: (error) =>
              new ExecutorError({
                message: `Failed to write Docker step input manifest: ${String(error)}`,
                cause: error,
              }),
          })

          const buildResult = yield* Effect.tryPromise({
            try: () =>
              executeCommand("docker", [
                "build",
                "-t",
                imageTag,
                "-f",
                dockerfilePath,
                contextPath,
              ]),
            catch: (error) =>
              new ExecutorError({
                message: `Failed to build Docker image for ${jobContext.stepPath}: ${String(error)}`,
                cause: error,
              }),
          })

          if (buildResult.exitCode !== 0) {
            return yield* new ExecutorError({
              message: formatFailureMessage({
                title: `Docker build failed for ${jobContext.stepPath}`,
                exitCode: buildResult.exitCode,
                error: undefined,
                stderrTail: undefined,
                stdoutTail: undefined,
                stderr: buildResult.stderr,
                stdout: buildResult.stdout,
              }),
            })
          }

          const dockerRunArgs = [
            "run",
            "--rm",
            "-e",
            "PF_INPUT_URL=file:///pf/work/input.json",
            "-e",
            "PF_RESULT_URL=file:///pf/work/result.json",
            "-e",
            "PF_STEP_INPUT_PATH=/pf/input.json",
            "-e",
            "PF_STEP_OUTPUT_PATH=/pf/output.json",
            "-v",
            `${hostWorkDir}:/pf/work`,
            "-v",
            `${resolve(orgPath, "files")}:/pf/document-store:ro`,
          ]

          // TODO: Replace this broad runtime pass-through with an explicit
          // DockerStep secret contract instead of leaking ambient process env.
          dockerRunArgs.push(
            "-e",
            `INTERNAL_API_SECRET=${localInternalApiSecret}`,
          )

          for (const envName of [
            "AWS_PROFILE",
            "AWS_REGION",
            "AWS_DEFAULT_REGION",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
          ]) {
            const value = process.env[envName]
            if (value) {
              dockerRunArgs.push("-e", `${envName}=${value}`)
            }
          }

          const awsDir = join(homedir(), ".aws")
          if (existsSync(awsDir)) {
            dockerRunArgs.push("-v", `${awsDir}:/root/.aws:ro`)
          }

          dockerRunArgs.push(imageTag)

          const runResult = yield* Effect.tryPromise({
            try: () => executeCommand("docker", dockerRunArgs),
            catch: (error) =>
              new ExecutorError({
                message: `Failed to run Docker container for ${jobContext.stepPath}: ${String(error)}`,
                cause: error,
              }),
          })

          const resultEither = yield* Effect.either(
            parseResult(resultPath).pipe(
              Effect.mapError(
                (error) =>
                  new DockerStepResultParseError({
                    message: `Failed to parse Docker step result for ${jobContext.stepPath}: ${String(error)}`,
                    cause: error,
                  }),
              ),
            ),
          )

          if (runResult.exitCode !== 0) {
            const result = Either.isRight(resultEither)
              ? resultEither.right
              : undefined

            return yield* new ExecutorError({
              message: formatFailureMessage({
                title: `Docker step ${jobContext.stepPath} failed`,
                error: result?.error,
                exitCode: result?.exitCode ?? runResult.exitCode,
                stderrTail: result?.stderrTail,
                stdoutTail: result?.stdoutTail,
                stderr: runResult.stderr,
                stdout: runResult.stdout,
              }),
            })
          }

          if (Either.isLeft(resultEither)) {
            return yield* new ExecutorError({
              message: formatFailureMessage({
                title: resultEither.left.message,
                error: undefined,
                exitCode: runResult.exitCode,
                stderrTail: undefined,
                stdoutTail: undefined,
                stderr: runResult.stderr,
                stdout: runResult.stdout,
              }),
              cause: resultEither.left,
            })
          }

          const result = resultEither.right

          if (result.status !== "success") {
            return yield* new ExecutorError({
              message: formatFailureMessage({
                title: `Docker step ${jobContext.stepPath} failed`,
                error: result.error,
                exitCode: result.exitCode ?? runResult.exitCode,
                stderrTail: result.stderrTail,
                stdoutTail: result.stdoutTail,
                stderr: runResult.stderr,
                stdout: runResult.stdout,
              }),
            })
          }

          return {
            _tag: "Completed" as const,
            output:
              typeof result.output === "object" && result.output !== null
                ? (result.output as Record<string, unknown>)
                : {},
          }
        }),
      ),
  })
}
