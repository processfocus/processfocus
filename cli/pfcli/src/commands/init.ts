import { readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { FileSystem } from "@effect/platform"
import { Console, Effect, Schema } from "effect"
import {
  DEFAULT_OAUTH_PROVIDER_SCOPES,
  OAUTH_PROVIDER_NAMES,
  type OAuthProviderName,
} from "@pf/auth-config"
import { InitError } from "../errors"
import {
  CLI_ORGANISATION_RUNTIME_DEPENDENCIES,
  CLI_ORGANISATION_SDK_VERSION,
} from "../package-metadata"
import { runImport } from "./import"

export const SUPPORTED_PROVIDERS = OAUTH_PROVIDER_NAMES

/**
 * Template content for src/index.ts
 */
const INDEX_TS = `export * from "./org"
`

const EFFECT_VERSION = "^3.19.13"
const DRIZZLE_KIT_VERSION = "^1.0.0-rc.4-ca0f029"
const JsonObject = Schema.Record({ key: Schema.String, value: Schema.Unknown })

const toLiteral = (value: string) => JSON.stringify(value)

const providerEnvVar = (provider: OAuthProviderName, suffix: string) =>
  `${provider.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_${suffix}`

const providerDisplayName = (provider: OAuthProviderName) =>
  provider
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")

const makeProviderConfig = (providers: readonly OAuthProviderName[]) => {
  const entries = providers.map((provider) => {
    return `  ${provider}: {
    clientID: process.env[${toLiteral(providerEnvVar(provider, "CLIENT_ID"))}] ?? "",
    clientSecret: process.env[${toLiteral(providerEnvVar(provider, "CLIENT_SECRET"))}] ?? "",
    scopes: [${DEFAULT_OAUTH_PROVIDER_SCOPES[provider].map(toLiteral).join(", ")}],
  },`
  })

  return `{
${entries.join("\n")}
}`
}

const makeIdentityProviderComment = (
  providers: readonly OAuthProviderName[],
) => {
  if (providers.length === 1) {
    const provider = providers[0]

    if (provider === undefined) {
      return `/*
 * Identity providers handle how people prove who they are when logging in.
 *
 * In this example, the configured identity providers confirm who each person
 * is and share basic profile information such as their email address.
 */`
    }

    return `/*
 * Identity providers handle how people prove who they are when logging in.
 *
 * In this example, ${providerDisplayName(provider)} is the identity provider.
 * It confirms who the person is and shares basic profile information such as
 * their email address.
 */`
  }

  return `/*
 * Identity providers handle how people prove who they are when logging in.
 *
 * In this example, the configured identity providers confirm who each person
 * is and share basic profile information such as their email address.
 */`
}

const makePackageJson = (packageName: string) =>
  `${JSON.stringify(
    {
      name: packageName,
      version: "0.0.1",
      private: true,
      type: "module",
      dependencies: {
        ...CLI_ORGANISATION_RUNTIME_DEPENDENCIES,
        effect: EFFECT_VERSION,
        processfocus: CLI_ORGANISATION_SDK_VERSION,
      },
      devDependencies: {
        "drizzle-kit": DRIZZLE_KIT_VERSION,
      },
    },
    null,
    2,
  )}
`

/**
 * Template content for src/todo.ts
 */
const TODO_TS = `import { Schema as ES } from "effect"
import { Form, type OrgUnit, Process, type Role } from "processfocus"
import { FormLabel } from "processfocus/forms"

export class Todo extends Process {
  constructor(
    scope: OrgUnit,
    id: string,
    employeeRole: Role,
    managerRole: Role,
  ) {
    super(scope, id, {
      name: "Todo",
      purpose: "Simple task management process",
    })

    /*
     * This process flow has two steps.
     *
     * First, an employee creates a todo. Then a manager completes and
     * acknowledges it. The final line below wires those steps into a simple
     * start-to-end flow.
     */
    const create_todo = new Form(this, "Create todo", {
      name: "Create new todo",
      form: () => ({
        title: ES.String.annotations({ [FormLabel]: "Title" }),
        description: ES.String.annotations({ [FormLabel]: "Description" }),
      }),
      role: employeeRole,
    })

    const complete_todo = new Form(this, "Complete todo", {
      name: "Complete and acknowledge",
      form: () => ({}),
      role: managerRole,
    })

    this.start(create_todo).end(complete_todo)
  }
}
`

/**
 * Template content for src/org.ts
 */
const ORG_TS = (
  orgName: string,
  orgAcronym: string,
  timeZone: string,
  providers: readonly OAuthProviderName[],
  adminEmail: string,
) => `import {
  AuthenticationConfig,
  type AuthenticationConfigProps,
  PoliciesConfig,
} from "processfocus/auth"
import {
  type BusinessCalendarConfig,
  NZ_HOLIDAYS,
  Saturday,
  Sunday,
  Weekdays,
} from "processfocus/calendar"
import { Invitation, OrgUnit, Organisation, Role } from "processfocus"
import { Todo } from "./todo"

const weekdaySchedule = Weekdays.map((day) => ({
  day,
  ranges: [{ open: { hour: 8, minute: 30 }, close: { hour: 17, minute: 0 } }],
}))

/*
 * The business calendar defines when your organisation is considered to be
 * working.
 *
 * Process Focus uses it for due dates, scheduling, and other time-based
 * calculations. That means weekends, holidays, and working hours are handled
 * consistently everywhere.
 *
 * For example, if you schedule something 2 days from now, that means
 * 2 business days according to this business calendar.
 */
const businessCalendar: BusinessCalendarConfig = {
  weeklySchedule: weekdaySchedule,
  holidays: NZ_HOLIDAYS,
  exceptions: [],
  nonWorkingDays: [Saturday, Sunday],
  periods: [],
  startDayOfWeek: Sunday,
}

export const org = new Organisation({
  name: ${toLiteral(orgName)},
  acronym: ${toLiteral(orgAcronym)},
  timeZone: ${toLiteral(timeZone)},
  businessCalendar,
})

/*
 * Roles describe the responsibilities people can have in your organisation.
 *
 * People are assigned roles, and processes use those roles to decide who can
 * start work, review work, approve work, or administer the system.
 */
export const employee = new Role(org, "Employee", { name: "Employee" })
export const administrator = new Role(org, "Administrator", {
  name: "Administrator",
})

/*
 * Org units model the structure of your organisation.
 *
 * They can represent departments, teams, regions, or other parts of the
 * business. Roles and processes can then be attached to the right part of the
 * organisation.
 */
const operations = new OrgUnit(org, "operations", {
  name: "Operations",
  type: "department",
})
const operations_manager = new Role(operations, "Manager", {
  name: "Manager",
})

/*
 * This creates your first process in the Operations department.
 *
 * A process models a repeatable piece of business work. In this example, the
 * process is a simple todo flow with one person creating work and another
 * person completing it.
 */
new Todo(operations, "todo", employee, operations_manager)

${makeIdentityProviderComment(providers)}
const identityProviders: AuthenticationConfigProps["identityProviders"] = ${makeProviderConfig(providers)}

new AuthenticationConfig(org, "auth", {
  inviteOnly: true,
  identityProviders,
  secretClients: {},
})

/*
 * Policies control authorisation: what people are allowed to do after they
 * have logged in.
 *
 * These policy files let you customise access rules for your organisation,
 * such as who may view, manage, or approve different kinds of work.
 */
new PoliciesConfig(org, "policies", {
  policyFiles: ["cedar/custom.cedar"],
})

/*
 * An invitation allows the person with this email address to log in.
 *
 * Their identity is validated by the identity provider. Process Focus relies
 * on that identity provider and does not validate identities itself.
 *
 * When this person logs in for the first time, Process Focus assigns them the
 * Employee and Administrator roles.
 */
new Invitation(org, "admin", {
  email: ${toLiteral(adminEmail)},
  roles: [employee, administrator],
})
`

/**
 * Template content for drizzle.config.ts
 */
const DRIZZLE_CONFIG_TS = `import { pathToFileURL } from "node:url"
import { defineConfig } from "drizzle-kit"

const dbPath = process.env.SQLITE_DATABASE_PATH
if (!dbPath) {
  throw new Error(
    "SQLITE_DATABASE_PATH environment variable is required.\\n" +
      "Please set it to the path of your SQLite database file.\\n" +
      "Example: export SQLITE_DATABASE_PATH=/path/to/database.db",
  )
}

// Parse the URL to determine protocol
// If no protocol, treat as file path
let parsedUrl: URL
try {
  parsedUrl = new URL(dbPath)
} catch {
  // Not a valid URL, treat as file path
  parsedUrl = pathToFileURL(dbPath)
}

const dbUrl = parsedUrl.href

// Use "turso" dialect for remote Turso databases (libsql://),
// "sqlite" for local files (file://)
const isRemote = parsedUrl.protocol === "libsql:"
const dialect = isRemote ? "turso" : "sqlite"
let authToken: string | undefined
if (isRemote) {
  authToken = process.env.TURSO_AUTH_TOKEN
  if (!authToken) {
    throw new Error("TURSO_AUTH_TOKEN is required for remote Turso databases")
  }
}

export default defineConfig({
  schema: "./src/schema/schema.ts",
  out: "./drizzle",
  dialect,
  // Use separate table to avoid collisions with core schema migrations
  migrations: { table: "__drizzle_migrations_org" },
  dbCredentials: {
    url: dbUrl,
    ...(authToken && { authToken }),
  },
})
`

/**
 * Template content for cedar/custom.cedar
 */
const CUSTOM_CEDAR = (
  adminEmail: string,
) => `// ${adminEmail} can request the Administrator role
permit (
    principal == PF::ProviderUser::${toLiteral(adminEmail)},
    action == PF::Action::"requestRole",
    resource == PF::Role::"/Administrator"
);

// Administrators can complete any step
permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"complete",
    resource is PF::Step
);

// Administrators can administer users
permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"administerUsers",
    resource is PF::Application
);

// Administrators can administer OAuth providers
permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"administerOAuthProviders",
    resource is PF::Application
);

// Administrators can view process state (debugging feature)
permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"showProcessState",
    resource is PF::Application
);

// Administrators can view combined authorisation policies and schema.
permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"viewAuthorization",
    resource is PF::Application
);

// Administrators can restart any execution
permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"restart",
    resource is PF::Execution
);
`

/**
 * Get the system's timezone
 */
const getSystemTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return "UTC"
  }
}

const installDependencies = (orgPath: string) =>
  Effect.gen(function* () {
    const packageJsonPath = path.join(orgPath, "package.json")
    const originalPackageJson = readFileSync(packageJsonPath, "utf8")
    const sdkOverride = process.env["PFCLI_INIT_SDK_OVERRIDE"]
    const runtimeOverride = process.env["PFCLI_INIT_RUNTIME_OVERRIDE"]
    const hasPackageOverrides =
      sdkOverride !== undefined || runtimeOverride !== undefined

    const result = yield* Effect.try({
      try: () => {
        try {
          if (hasPackageOverrides) {
            const packageJson = Schema.decodeUnknownSync(JsonObject)(
              JSON.parse(originalPackageJson),
            )
            const packageJsonWithOverride = {
              ...packageJson,
              overrides: {
                ...(sdkOverride === undefined
                  ? {}
                  : { processfocus: sdkOverride }),
                ...(runtimeOverride === undefined
                  ? {}
                  : { "@processfocus/runtime": runtimeOverride }),
              },
            }
            writeFileSync(
              packageJsonPath,
              `${JSON.stringify(packageJsonWithOverride, null, 2)}\n`,
            )
          }
          return Bun.spawnSync(["bun", "install"], {
            cwd: orgPath,
            stderr: "pipe",
            stdout: "pipe",
          })
        } finally {
          if (hasPackageOverrides) {
            writeFileSync(packageJsonPath, originalPackageJson)
          }
        }
      },
      catch: (cause) =>
        new InitError({
          message: `Failed to install dependencies in ${orgPath}`,
          cause,
        }),
    })

    if (result.exitCode !== 0) {
      const decoder = new TextDecoder()
      const stderr = decoder.decode(result.stderr).trim()
      const stdout = decoder.decode(result.stdout).trim()
      return yield* new InitError({
        message:
          stderr || stdout
            ? `bun install failed in ${orgPath}: ${stderr || stdout}`
            : `bun install failed in ${orgPath} with exit code ${result.exitCode}`,
      })
    }
  })

/**
 * Init command - scaffolds a new organisation directory with template files.
 *
 * Steps:
 * 1. Validate directory (must not exist OR be empty)
 * 2. Create directory structure
 * 3. Write template files
 * 4. Import the org so the default database and frontend JWT exist
 *
 * @param orgPath - Path to organisation directory to create
 */
export const runInit = (
  orgPath: string,
  providers: readonly string[],
  adminEmail: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (providers.length === 0) {
      return yield* new InitError({
        message: `At least one --identity-provider must be supplied. Available providers: ${SUPPORTED_PROVIDERS.join(", ")}`,
      })
    }

    if (!adminEmail.includes("@") || adminEmail.trim().length === 0) {
      return yield* new InitError({
        message: "A valid --email address is required.",
      })
    }

    const unsupportedProviders = providers.filter(
      (provider): provider is string =>
        !SUPPORTED_PROVIDERS.includes(provider as OAuthProviderName),
    )

    if (unsupportedProviders.length > 0) {
      return yield* new InitError({
        message: `Unsupported provider(s): ${unsupportedProviders.join(", ")}`,
      })
    }

    const requestedProviders = providers as readonly OAuthProviderName[]

    const absolutePath = path.resolve(process.cwd(), orgPath)
    const dirName = path.basename(absolutePath)
    const packageName = dirName.toLowerCase().replace(/[^a-z0-9-_]/g, "-")

    // Derive org name and acronym from directory name
    const orgName = dirName
      .split("-")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ")
    const orgAcronym = dirName
      .split("-")
      .map((s) => s.charAt(0).toUpperCase())
      .join("")

    // Get system timezone
    const timeZone = getSystemTimeZone()

    yield* Console.log(`Initialising organisation at: ${absolutePath}`)

    // Step 1: Validate directory
    const exists = yield* fs.exists(absolutePath)

    if (exists) {
      // Check if directory is empty
      const entries = yield* fs.readDirectory(absolutePath).pipe(
        Effect.mapError(
          (error) =>
            new InitError({
              message: `Failed to read directory: ${absolutePath}`,
              cause: error,
            }),
        ),
      )

      if (entries.length > 0) {
        return yield* new InitError({
          message: `Directory is not empty: ${absolutePath}`,
        })
      }
    }

    // Step 2: Create directory structure
    yield* Console.log("\n[1/3] Creating directory structure...")

    yield* fs.makeDirectory(absolutePath, { recursive: true })
    yield* fs.makeDirectory(path.join(absolutePath, "src"), { recursive: true })
    yield* fs.makeDirectory(path.join(absolutePath, "cedar"), {
      recursive: true,
    })

    // Step 3: Write template files
    yield* Console.log("[2/3] Writing template files...")

    yield* fs.writeFileString(
      path.join(absolutePath, "src", "index.ts"),
      INDEX_TS,
    )
    yield* Console.log("  ✅ src/index.ts")

    yield* fs.writeFileString(
      path.join(absolutePath, "src", "todo.ts"),
      TODO_TS,
    )
    yield* Console.log("  ✅ src/todo.ts")

    yield* fs.writeFileString(
      path.join(absolutePath, "src", "org.ts"),
      ORG_TS(orgName, orgAcronym, timeZone, requestedProviders, adminEmail),
    )
    yield* Console.log("  ✅ src/org.ts")

    yield* fs.writeFileString(
      path.join(absolutePath, "cedar", "custom.cedar"),
      CUSTOM_CEDAR(adminEmail),
    )
    yield* Console.log("  ✅ cedar/custom.cedar")

    yield* fs.writeFileString(
      path.join(absolutePath, "drizzle.config.ts"),
      DRIZZLE_CONFIG_TS,
    )
    yield* Console.log("  ✅ drizzle.config.ts")

    yield* fs.writeFileString(
      path.join(absolutePath, "package.json"),
      makePackageJson(packageName),
    )
    yield* Console.log("  ✅ package.json")

    yield* Console.log("[3/3] Importing organisation...")
    yield* Console.log("Installing dependencies with bun...")
    yield* installDependencies(absolutePath)
    yield* runImport(absolutePath)

    yield* Console.log(
      `\n✅ Organisation initialised successfully!\n   Path: ${absolutePath}`,
    )
  })
