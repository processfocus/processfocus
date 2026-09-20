import { Console, Data, Effect, Layer } from "effect"
import { issuePasskeyRecoveryLink } from "@pf/auth-api"
import {
  DATABASE_PATH_NOT_CONFIGURED,
  makeDatabaseConfigLayer,
  resolveDatabasePath,
} from "@pf/db-info"
import {
  ACTIVE_REGISTRATION_LINK_EXISTS_MESSAGE,
  ACTIVE_REGISTRATION_LINK_REQUIRES_ROTATE_MESSAGE,
  DEVELOPMENT_INVITATION_REGISTRATION_SECRET,
  IMMUTABLE_INVITATION_MESSAGE,
  issueRegistrationLinkForEmail,
} from "@pf/graphql-db-operations"
import { TypedSqliteDrizzleLayer } from "@pf/service-drizzle-sqlite"
import {
  SqliteAuthenticationDatabaseLive,
  SqliteOpenAuthStorageServiceLive,
  SqliteSettingsQueriesLive,
} from "@pf/sqlite-operations"
import { graphqlRequestWithCredentials } from "../utils/graphql-client"
import { makePfcliSqlClientLayer } from "../utils/local-database-layer"
import { ensureKnownEnvironmentName } from "../utils/remote-name-validation"

class InvitationRegistrationLinkDbPathError extends Data.TaggedError(
  "InvitationRegistrationLinkDbPathError",
)<{
  readonly message: string
}> {}

class InvitationRegistrationLinkDatabaseError extends Data.TaggedError(
  "InvitationRegistrationLinkDatabaseError",
)<{
  readonly message: string
  readonly cause: unknown
}> {
  constructor(cause: unknown) {
    const failureCategory =
      typeof cause === "object" &&
      cause !== null &&
      "_tag" in cause &&
      cause._tag === "SqlError"
        ? "SQL operation failed"
        : "database client initialization failed"

    super({
      message: `Could not access the local database. Check SQLITE_DATABASE_PATH or org-path and try again. Failure category: ${failureCategory}.`,
      cause,
    })
  }
}

class InvitationRegistrationLinkModeError extends Data.TaggedError(
  "InvitationRegistrationLinkModeError",
)<{
  readonly message: string
}> {}

const REMOTE_REGISTRATION_LINK_TIMEOUT_MS = 30_000

const GENERATE_PROJECT_REGISTRATION_LINK_MUTATION = `
  mutation GenerateProjectRegistrationLink($projectId: String!, $environmentId: String!, $email: String!, $rotate: Boolean) {
    generateProjectRegistrationLink(projectId: $projectId, environmentId: $environmentId, email: $email, rotate: $rotate) {
      __typename
      ... on ProjectRegistrationLinkSuccess {
        email
        registrationLinkUrl
        expiresAt
      }
      ... on ProjectRegistrationLinkFailure {
        error
      }
    }
  }
`

type ProjectRegistrationLinkGraphqlResult =
  | {
      readonly __typename: "ProjectRegistrationLinkSuccess"
      readonly email: string
      readonly registrationLinkUrl: string
      readonly expiresAt: string
    }
  | {
      readonly __typename: "ProjectRegistrationLinkFailure"
      readonly error: string
    }

interface GenerateProjectRegistrationLinkResponse {
  readonly generateProjectRegistrationLink: ProjectRegistrationLinkGraphqlResult
}

type RegistrationLinkOutcome =
  | {
      readonly ok: true
      readonly registrationLinkUrl: string
      readonly expiresAt: string
    }
  | {
      readonly ok: false
      readonly error: string
    }

const reportRegistrationLinkOutcome = (result: RegistrationLinkOutcome) =>
  Effect.gen(function* () {
    if (!result.ok) {
      yield* Console.error(`❌ ${result.error}`)
      yield* Effect.sync(() => {
        process.exitCode = 1
      })
      return
    }

    yield* Console.log(result.registrationLinkUrl)
    yield* Console.log(`expires at: ${result.expiresAt}`)
  })

const operatorRegistrationLinkError = (
  error: string,
  rotate: boolean,
): string =>
  !rotate && error === ACTIVE_REGISTRATION_LINK_EXISTS_MESSAGE
    ? ACTIVE_REGISTRATION_LINK_REQUIRES_ROTATE_MESSAGE
    : error

export const resolveLocalRegistrationLinkOrganisationScope = (
  orgPath?: string,
): string =>
  process.env["PF_SCOPE"] ?? process.env["PF_ORG"] ?? orgPath ?? "local"

export const resolveLocalRegistrationLinkFrontendOrigin = (): string => {
  const configured =
    process.env["FRONTEND_BASE_URL"] ??
    process.env["BASE_URL"] ??
    process.env["NEXT_PUBLIC_FRONTEND_URL"]

  return (configured || "http://localhost:3000").replace(/\/$/, "")
}

const resolveLocalRegistrationLinkEncryptionSecret = (): string | undefined => {
  const configured = process.env["INVITATION_REGISTRATION_ENCRYPTION_KEY"]
  if (configured) return configured

  const nodeEnv = process.env["NODE_ENV"]
  return nodeEnv === undefined ||
    nodeEnv === "development" ||
    nodeEnv === "test"
    ? DEVELOPMENT_INVITATION_REGISTRATION_SECRET
    : undefined
}

const generateRegistrationLinkLocal = (options: {
  readonly orgPath?: string | undefined
  readonly email: string
  readonly rotate: boolean
}) =>
  Effect.gen(function* () {
    const databasePath = resolveDatabasePath(options.orgPath)
    if (!databasePath) {
      return yield* new InvitationRegistrationLinkDbPathError({
        message: DATABASE_PATH_NOT_CONFIGURED,
      })
    }

    const dbLayer = makePfcliSqlClientLayer(databasePath)
    const appLayer = Layer.mergeAll(
      SqliteSettingsQueriesLive,
      SqliteAuthenticationDatabaseLive,
      SqliteOpenAuthStorageServiceLive,
    ).pipe(
      Layer.provideMerge(TypedSqliteDrizzleLayer),
      Layer.provideMerge(dbLayer),
      Layer.provide(makeDatabaseConfigLayer(databasePath)),
    )

    const secret = resolveLocalRegistrationLinkEncryptionSecret()
    const result = yield* issueRegistrationLinkForEmail({
      email: options.email,
      rotate: options.rotate,
      actor: "SYSTEM",
      organisationScope: resolveLocalRegistrationLinkOrganisationScope(
        options.orgPath,
      ),
      frontendOrigin: resolveLocalRegistrationLinkFrontendOrigin(),
      ...(secret === undefined ? {} : { secret }),
    }).pipe(
      Effect.flatMap((result) =>
        !result.ok &&
        options.rotate &&
        result.error === IMMUTABLE_INVITATION_MESSAGE
          ? issuePasskeyRecoveryLink({
              email: options.email,
              actor: "SYSTEM",
              frontendOrigin: resolveLocalRegistrationLinkFrontendOrigin(),
            })
          : Effect.succeed(result),
      ),
      Effect.provide(appLayer),
      Effect.mapError(
        (cause) => new InvitationRegistrationLinkDatabaseError(cause),
      ),
    )

    yield* reportRegistrationLinkOutcome(
      result.ok
        ? {
            ok: true,
            registrationLinkUrl: result.registrationLinkUrl,
            expiresAt: result.expiresAt.toISOString(),
          }
        : {
            ok: false,
            error: operatorRegistrationLinkError(result.error, options.rotate),
          },
    )
  })

const generateRegistrationLinkRemote = (options: {
  readonly projectId: string
  readonly environmentId: string
  readonly email: string
  readonly rotate: boolean
}) =>
  Effect.gen(function* () {
    const response =
      yield* graphqlRequestWithCredentials<GenerateProjectRegistrationLinkResponse>(
        GENERATE_PROJECT_REGISTRATION_LINK_MUTATION,
        {
          projectId: options.projectId,
          environmentId: options.environmentId,
          email: options.email,
          rotate: options.rotate,
        },
        { timeoutMs: REMOTE_REGISTRATION_LINK_TIMEOUT_MS },
      )

    const result = response.generateProjectRegistrationLink
    yield* reportRegistrationLinkOutcome(
      result.__typename === "ProjectRegistrationLinkSuccess"
        ? {
            ok: true,
            registrationLinkUrl: result.registrationLinkUrl,
            expiresAt: result.expiresAt,
          }
        : { ok: false, error: result.error },
    )
  })

type InvitationRegistrationLinkOptions = {
  readonly orgPath?: string | undefined
  readonly projectId?: string | undefined
  readonly environmentId?: string | undefined
  readonly email?: string | undefined
  readonly rotate: boolean
}

type InvitationRegistrationLinkMode =
  | {
      readonly kind: "local"
      readonly orgPath?: string | undefined
      readonly email: string
      readonly rotate: boolean
    }
  | {
      readonly kind: "remote"
      readonly projectId: string
      readonly environmentId: string
      readonly email: string
      readonly rotate: boolean
    }

const resolveRegistrationLinkMode = (
  options: InvitationRegistrationLinkOptions,
): Effect.Effect<
  InvitationRegistrationLinkMode,
  InvitationRegistrationLinkModeError
> =>
  Effect.gen(function* () {
    const { projectId, environmentId } = options
    if (Boolean(projectId) !== Boolean(environmentId)) {
      return yield* new InvitationRegistrationLinkModeError({
        message: "Remote mode requires both --project and --env together.",
      })
    }

    if (projectId && environmentId) {
      if (options.orgPath) {
        return yield* new InvitationRegistrationLinkModeError({
          message:
            "Remote mode does not accept positional org-path. Remove org-path when using --project/--env.",
        })
      }
    }

    if (!options.email) {
      return yield* new InvitationRegistrationLinkModeError({
        message: `Missing required option: --email.
Local example: pfcli invitation registration-link [org-path] --email <invited-email>
Remote example: pfcli invitation registration-link --project <project-number> --env <environment-name> --email <invited-email>`,
      })
    }

    if (projectId && environmentId) {
      return {
        kind: "remote",
        projectId,
        environmentId,
        email: options.email,
        rotate: options.rotate,
      }
    }

    return {
      kind: "local",
      orgPath: options.orgPath,
      email: options.email,
      rotate: options.rotate,
    }
  })

const invitationRegistrationLink = (
  options: InvitationRegistrationLinkOptions,
) =>
  Effect.gen(function* () {
    const mode = yield* resolveRegistrationLinkMode(options)
    if (mode.kind === "local") {
      return yield* generateRegistrationLinkLocal(mode)
    }

    yield* ensureKnownEnvironmentName(mode.projectId, mode.environmentId)

    return yield* generateRegistrationLinkRemote({
      projectId: mode.projectId,
      environmentId: mode.environmentId,
      email: mode.email,
      rotate: mode.rotate,
    })
  })

const reportCommandError = (error: { readonly message: string }) =>
  Effect.gen(function* () {
    yield* Console.error(`\n❌ ${error.message}`)
    yield* Effect.sync(() => {
      process.exitCode = 1
    })
  })

export const runInvitationRegistrationLink = (
  options: InvitationRegistrationLinkOptions,
) =>
  invitationRegistrationLink(options).pipe(
    Effect.catchTags({
      InvitationRegistrationLinkModeError: reportCommandError,
      InvitationRegistrationLinkDbPathError: reportCommandError,
      InvitationRegistrationLinkDatabaseError: reportCommandError,
      CliError: reportCommandError,
    }),
    Effect.catchAll(() =>
      Effect.gen(function* () {
        yield* Console.error("\n❌ Registration link failed unexpectedly.")
        yield* Effect.sync(() => {
          process.exitCode = 1
        })
      }),
    ),
  )
