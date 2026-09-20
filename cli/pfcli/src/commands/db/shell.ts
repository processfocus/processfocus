import { accessSync, constants, statSync } from "node:fs"
import { delimiter, join } from "node:path"
import { httpsUrlFromTursoLibsqlUrl } from "@processfocus/hosting-contract"
import { Console, Effect } from "effect"
import { CliError } from "../../errors"
import { graphqlRequestWithCredentials } from "../../utils/graphql-client"

const CREATE_DATABASE_SHELL_SESSION_MUTATION = `
  mutation CreateDatabaseShellSession($projectId: String!, $environmentId: String!, $ttlSeconds: Int) {
    createDatabaseShellSession(projectId: $projectId, environmentId: $environmentId, ttlSeconds: $ttlSeconds) {
      databaseUrl
      authToken
      expiresAt
      databaseName
    }
  }
`

const MAX_TTL_SECONDS = 60 * 60

interface CreateDatabaseShellSessionResponse {
  readonly createDatabaseShellSession: {
    readonly databaseUrl: string
    readonly authToken: string
    readonly expiresAt: string
    readonly databaseName: string
  }
}

type Environment = Record<string, string | undefined>

type FindExecutable = (command: string, env?: Environment) => string | undefined

type SpawnDatabaseShell = (
  command: readonly [string, ...string[]],
  options: {
    readonly stdin: "inherit"
    readonly stdout: "inherit"
    readonly stderr: "inherit"
    readonly env: Environment
  },
) => { readonly exited: Promise<number> }

interface RunDatabaseShellDependencies {
  readonly findExecutable?: FindExecutable
  readonly spawn?: SpawnDatabaseShell
}

const TTL_UNITS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 60 * 60,
  hr: 60 * 60,
  hrs: 60 * 60,
  hour: 60 * 60,
  hours: 60 * 60,
}

const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) {
      return false
    }
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const executableNames = (
  command: string,
  env: Environment,
): ReadonlyArray<string> => {
  if (process.platform !== "win32") {
    return [command]
  }

  const extensions = (env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter((extension) => extension.length > 0)

  return [command, ...extensions.map((extension) => `${command}${extension}`)]
}

const findExecutableOnPath: FindExecutable = (command, env = process.env) => {
  const pathValue = env["PATH"]
  if (!pathValue) {
    return undefined
  }

  for (const directory of pathValue.split(delimiter)) {
    if (!directory) {
      continue
    }

    for (const executableName of executableNames(command, env)) {
      const candidate = join(directory, executableName)
      if (isExecutableFile(candidate)) {
        return candidate
      }
    }
  }

  return undefined
}

const parseDatabaseShellTtlSeconds = (
  value: string | undefined,
): Effect.Effect<number | undefined, CliError> =>
  Effect.gen(function* () {
    if (value === undefined) {
      return undefined
    }

    const trimmed = value.trim().toLowerCase()
    const match = /^(\d+)\s*([a-z]+)?$/.exec(trimmed)
    if (!match) {
      return yield* new CliError({
        message:
          'Invalid Database Shell TTL. Use seconds or a duration like "900s", "15m", or "1h".',
      })
    }

    const [, amountText, unitText = "seconds"] = match
    const multiplier = TTL_UNITS[unitText]
    if (multiplier === undefined) {
      return yield* new CliError({
        message:
          'Invalid Database Shell TTL unit. Use seconds, minutes, or hours, for example "900s", "15m", or "1h".',
      })
    }

    const seconds = Number(amountText) * multiplier
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
      return yield* new CliError({
        message:
          "Database Shell TTL must be a positive whole number of seconds.",
      })
    }

    if (seconds > MAX_TTL_SECONDS) {
      return yield* new CliError({
        message: "Database Shell TTL must be 1 hour or less.",
      })
    }

    return seconds
  })

const formatExpiry = (expiresAt: string): string => {
  const date = new Date(expiresAt)
  if (Number.isNaN(date.getTime())) {
    return expiresAt
  }

  return date.toLocaleString()
}

const ensureTursoCliAvailable = (
  findExecutable: FindExecutable,
): Effect.Effect<string, CliError> =>
  Effect.gen(function* () {
    const tursoExecutable = findExecutable("turso")
    if (tursoExecutable !== undefined) {
      return tursoExecutable
    }

    return yield* new CliError({
      message:
        'The Turso CLI executable "turso" was not found on PATH. Install it from https://docs.turso.tech/cli/installation and rerun pfcli db shell.',
    })
  })

const createCredentialBearingDatabaseUrl = (
  databaseUrl: string,
  authToken: string,
): Effect.Effect<string, CliError> =>
  Effect.try({
    try: () => {
      const url = new URL(httpsUrlFromTursoLibsqlUrl(databaseUrl))
      url.searchParams.set("authToken", authToken)
      return `${url.origin}?${url.searchParams.toString()}`
    },
    catch: (cause) =>
      new CliError({
        message: "Database Shell session returned an invalid database URL",
        cause,
      }),
  })

const printReadWriteWarning = (input: {
  readonly projectId: string
  readonly environmentId: string
  readonly databaseName: string
  readonly expiresAt: string
}): Effect.Effect<void> =>
  Console.error(
    [
      "",
      "WARNING: opening a live read-write Database Shell session.",
      `Project: ${input.projectId}`,
      `Environment: ${input.environmentId}`,
      `Database: ${input.databaseName}`,
      `Session expires: ${formatExpiry(input.expiresAt)}`,
      "Changes made in this shell affect the active hosted environment database.",
      "The Turso child process receives the session token in its argv; local process listings may expose it until the shell exits.",
      "",
    ].join("\n"),
  )

const defaultSpawnDatabaseShell: SpawnDatabaseShell = (command, options) =>
  Bun.spawn([...command], options)

export const runDatabaseShell = (
  projectId: string,
  environmentId: string,
  ttl: string | undefined,
  dependencies: RunDatabaseShellDependencies = {},
): Effect.Effect<number, CliError> => {
  const findExecutable = dependencies.findExecutable ?? findExecutableOnPath
  const spawn = dependencies.spawn ?? defaultSpawnDatabaseShell

  return Effect.gen(function* () {
    const ttlSeconds = yield* parseDatabaseShellTtlSeconds(ttl)
    const tursoExecutable = yield* ensureTursoCliAvailable(findExecutable)

    const variables: Record<string, unknown> = {
      projectId,
      environmentId,
    }

    if (ttlSeconds !== undefined) {
      variables["ttlSeconds"] = ttlSeconds
    }

    const session =
      yield* graphqlRequestWithCredentials<CreateDatabaseShellSessionResponse>(
        CREATE_DATABASE_SHELL_SESSION_MUTATION,
        variables,
      ).pipe(Effect.map((response) => response.createDatabaseShellSession))

    yield* printReadWriteWarning({
      projectId,
      environmentId,
      databaseName: session.databaseName,
      expiresAt: session.expiresAt,
    })

    // Turso's shell command accepts remote database auth via URL query params.
    // Keep the credential out of pfcli output and persistence. The token is
    // still visible to the OS as part of the Turso child process argv.
    const shellTarget = yield* createCredentialBearingDatabaseUrl(
      session.databaseUrl,
      session.authToken,
    )
    const childEnv: Environment = { ...process.env }
    // Prevent ambient credentials from interfering with or bypassing the short-lived session URL token.
    delete childEnv["LIBSQL_AUTH_TOKEN"]
    delete childEnv["TURSO_AUTH_TOKEN"]
    delete childEnv["TURSO_API_TOKEN"]

    const child = yield* Effect.try({
      try: () =>
        spawn([tursoExecutable, "db", "shell", shellTarget], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          env: childEnv,
        }),
      catch: (cause) =>
        new CliError({
          message: "Failed to launch Turso database shell",
          cause,
        }),
    })

    return yield* Effect.tryPromise({
      try: () => child.exited,
      catch: (cause) =>
        new CliError({
          message: "Turso database shell failed before exiting cleanly",
          cause,
        }),
    })
  })
}
