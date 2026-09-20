#!/usr/bin/env bun
import { execSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Data, Effect, Match } from "effect"

/**
 * Error Types
 */
export class CommandExecutionError extends Data.TaggedError(
  "CommandExecutionError",
)<{
  readonly command: string
  readonly message: string
}> {}

export class DirectoryReadError extends Data.TaggedError("DirectoryReadError")<{
  readonly path: string
  readonly message: string
}> {}

export class FileReadError extends Data.TaggedError("FileReadError")<{
  readonly path: string
  readonly message: string
}> {}

export class FileWriteError extends Data.TaggedError("FileWriteError")<{
  readonly path: string
  readonly message: string
}> {}

export class NoMigrationFilesError extends Data.TaggedError(
  "NoMigrationFilesError",
)<{
  readonly directory: string
}> {}

export type ProgramError =
  | CommandExecutionError
  | DirectoryReadError
  | FileReadError
  | FileWriteError
  | NoMigrationFilesError

/**
 * Generate custom SQL migration using drizzle-kit
 */
const generateCustomSql = (): Effect.Effect<void, CommandExecutionError> =>
  Effect.gen(function* () {
    console.log("Running drizzle-kit generate --custom...")

    yield* Effect.try({
      try: () =>
        execSync(
          "bun drizzle-kit generate --custom --name=updated-at-triggers",
          {
            cwd: process.cwd(),
            stdio: "inherit",
          },
        ),
      catch: (error): CommandExecutionError =>
        new CommandExecutionError({
          command: "drizzle-kit generate --custom",
          message: error instanceof Error ? error.message : String(error),
        }),
    })
  })

/**
 * Find the newest SQL migration file in the drizzle/ directory
 */
const findLatestMigration = (): Effect.Effect<
  string,
  DirectoryReadError | NoMigrationFilesError
> =>
  Effect.gen(function* () {
    const drizzleDir = path.join(process.cwd(), "drizzle")

    const files = yield* Effect.tryPromise({
      try: () => fs.readdir(drizzleDir),
      catch: (error): DirectoryReadError =>
        new DirectoryReadError({
          path: drizzleDir,
          message: error instanceof Error ? error.message : String(error),
        }),
    })

    const sqlFiles = files
      .filter((f) => f.endsWith(".sql") && !f.startsWith("."))
      .sort()
      .reverse()

    if (sqlFiles.length === 0) {
      return yield* new NoMigrationFilesError({
        directory: drizzleDir,
      })
    }

    // biome-ignore lint/style/noNonNullAssertion: array length checked above
    const newestFile = sqlFiles[0]!
    console.log(`Found newest migration: ${newestFile}`)

    return path.join(drizzleDir, newestFile)
  })

/**
 * Copy triggers.sql content to the migration file
 */
const copyTriggers = (
  migrationPath: string,
): Effect.Effect<void, FileReadError | FileWriteError> =>
  Effect.gen(function* () {
    const triggerSQLPath = path.join(process.cwd(), "src/lib/triggers.sql")

    const triggerSQL = yield* Effect.tryPromise({
      try: () => fs.readFile(triggerSQLPath, "utf-8"),
      catch: (error): FileReadError =>
        new FileReadError({
          path: triggerSQLPath,
          message: error instanceof Error ? error.message : String(error),
        }),
    })

    yield* Effect.tryPromise({
      try: () => fs.writeFile(migrationPath, triggerSQL, "utf-8"),
      catch: (error): FileWriteError =>
        new FileWriteError({
          path: migrationPath,
          message: error instanceof Error ? error.message : String(error),
        }),
    })

    console.log(
      `✓ Generated trigger migration: ${path.basename(migrationPath)}`,
    )
  })

/**
 * Main program logic
 */
const program = Effect.sync(() =>
  console.log("Generating trigger migration..."),
).pipe(
  Effect.flatMap(() => generateCustomSql()),
  Effect.flatMap(() => findLatestMigration()),
  Effect.flatMap(copyTriggers),
)

/**
 * Error handler with pattern matching
 */
const handleError = (error: ProgramError): Effect.Effect<void> =>
  Match.value(error).pipe(
    Match.tag("CommandExecutionError", (err) =>
      Effect.sync(() => {
        console.error(`Error executing command: ${err.command}`)
        console.error(`  ${err.message}`)
      }),
    ),
    Match.tag("DirectoryReadError", (err) =>
      Effect.sync(() => {
        console.error(`Error reading directory: ${err.path}`)
        console.error(`  ${err.message}`)
      }),
    ),
    Match.tag("FileReadError", (err) =>
      Effect.sync(() => {
        console.error(`Error reading file: ${err.path}`)
        console.error(`  ${err.message}`)
      }),
    ),
    Match.tag("FileWriteError", (err) =>
      Effect.sync(() => {
        console.error(`Error writing file: ${err.path}`)
        console.error(`  ${err.message}`)
      }),
    ),
    Match.tag("NoMigrationFilesError", (err) =>
      Effect.sync(() => {
        console.error(`No SQL migration files found in: ${err.directory}`)
      }),
    ),
    Match.exhaustive,
  )

// Execute the program
Effect.runPromise(program.pipe(Effect.catchAll(handleError))).then(
  () => process.exit(0),
  () => process.exit(1),
)
