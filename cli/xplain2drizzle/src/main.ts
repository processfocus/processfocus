#!/usr/bin/env bun
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { parseArgs as utilParseArgs } from "node:util"
import { Console, Data, Effect, Match, Schema } from "effect"
import { type ParseError, parse } from "@pf/xplain-ddl"
import type { GeneratorError } from "./generator.postgres.js"
import * as PostgresGenerator from "./generator.postgres.js"
import * as SqliteGenerator from "./generator.sqlite.js"

const DatabaseTypeSchema = Schema.Literal("postgres", "sqlite")
type DatabaseType = Schema.Schema.Type<typeof DatabaseTypeSchema>

const ParsedArgsSchema = Schema.Struct({
  inputFile: Schema.String.pipe(Schema.nonEmptyString()),
  outputFile: Schema.optional(Schema.String.pipe(Schema.nonEmptyString())),
  dbType: DatabaseTypeSchema,
  prefix: Schema.optional(Schema.String),
})

type ParsedArgs = Schema.Schema.Type<typeof ParsedArgsSchema>

/**
 * Parse command line arguments
 * Supports: --database=postgres or --database postgres
 */
const parseArgs = (
  args: string[],
): Effect.Effect<ParsedArgs, InvalidUsageError> =>
  Effect.gen(function* () {
    const parseResult = yield* Effect.try({
      try: () =>
        utilParseArgs({
          args,
          options: {
            database: { type: "string" },
            prefix: { type: "string" },
          },
          strict: true,
          allowPositionals: true,
        }),
      catch: () => new InvalidUsageError({ _: undefined }),
    })

    // Validate the entire structure using Schema
    return yield* Schema.decodeUnknown(ParsedArgsSchema)({
      inputFile: parseResult.positionals[0],
      outputFile: parseResult.positionals[1],
      dbType: parseResult.values.database,
      prefix: parseResult.values.prefix,
    }).pipe(Effect.mapError(() => new InvalidUsageError({ _: undefined })))
  })

/**
 * File system error types
 */
export class FileReadError extends Data.TaggedError("FileReadError")<{
  readonly path: string
  readonly message: string
}> {}

export class FileWriteError extends Data.TaggedError("FileWriteError")<{
  readonly path: string
  readonly message: string
}> {}

export class DirectoryCreateError extends Data.TaggedError(
  "DirectoryCreateError",
)<{
  readonly path: string
  readonly message: string
}> {}

export type FileSystemError =
  | FileReadError
  | FileWriteError
  | DirectoryCreateError

/**
 * CLI error types
 */
export class InvalidUsageError extends Data.TaggedError("InvalidUsage")<{
  readonly _: undefined
}> {}

export class ParseErrors extends Data.TaggedError("ParseError")<{
  readonly errors: ParseError[]
}> {}

export class GeneratorErrors extends Data.TaggedError("GeneratorError")<{
  readonly error: GeneratorError
}> {}

/**
 * All program errors
 */
export type ProgramError =
  | FileSystemError
  | InvalidUsageError
  | ParseErrors
  | GeneratorErrors

/**
 * Read file with error handling
 */
const readFile = (filePath: string): Effect.Effect<string, FileReadError> =>
  Effect.tryPromise({
    try: () => fs.readFile(filePath, "utf-8"),
    catch: (error): FileReadError =>
      new FileReadError({
        path: filePath,
        message: error instanceof Error ? error.message : String(error),
      }),
  })

/**
 * Write file with error handling (creates parent directories if needed)
 */
const writeFile = (
  filePath: string,
  content: string,
): Effect.Effect<void, FileSystemError> =>
  Effect.gen(function* () {
    const dir = path.dirname(filePath)

    // Ensure parent directory exists
    yield* Effect.tryPromise({
      try: () => fs.mkdir(dir, { recursive: true }),
      catch: (error): DirectoryCreateError =>
        new DirectoryCreateError({
          path: dir,
          message: error instanceof Error ? error.message : String(error),
        }),
    })

    // Write the file
    yield* Effect.tryPromise({
      try: () => fs.writeFile(filePath, content, "utf-8"),
      catch: (error): FileWriteError =>
        new FileWriteError({
          path: filePath,
          message: error instanceof Error ? error.message : String(error),
        }),
    })
  })

/**
 * Helper function to display multiple error lines
 */
const displayErrorLines = (lines: string[]): Effect.Effect<void> =>
  Effect.all(
    lines.map((line) => Console.error(line)),
    {
      concurrency: 1,
      discard: true,
    },
  )

/**
 * Main program logic
 */
const runProgram = (
  inputFile: string,
  outputFile: string | undefined,
  dbType: DatabaseType,
  prefix: string | undefined,
): Effect.Effect<void, ProgramError> =>
  Effect.gen(function* () {
    yield* Console.log(`Reading ${inputFile}...`)
    const source = yield* readFile(inputFile)

    yield* Console.log("Parsing DDL...")
    const ast = yield* parse(source).pipe(
      Effect.mapError((errors) => new ParseErrors({ errors })),
    )

    yield* Console.log(`Generating Drizzle schema for ${dbType}...`)
    const schemaGenerator = Match.value(dbType).pipe(
      Match.when("postgres", () => PostgresGenerator.generateDrizzleSchema),
      Match.when("sqlite", () => SqliteGenerator.generateDrizzleSchema),
      Match.exhaustive,
    )

    const schema = yield* schemaGenerator(
      ast,
      path.basename(inputFile),
      prefix,
    ).pipe(Effect.mapError((error) => new GeneratorErrors({ error })))

    yield* Console.log(`Generating trigger SQL for ${dbType}...`)
    const triggerGenerator = Match.value(dbType).pipe(
      Match.when("postgres", () => PostgresGenerator.generateTriggerSQL),
      Match.when("sqlite", () => SqliteGenerator.generateTriggerSQL),
      Match.exhaustive,
    )

    const triggerSQL = triggerGenerator(ast, path.basename(inputFile), prefix)

    if (outputFile) {
      yield* Console.log(`Writing to ${outputFile}...`)
      yield* writeFile(outputFile, schema)

      // Write triggers.sql in the same directory
      const outputDir = path.dirname(outputFile)
      const triggersFile = path.join(outputDir, "triggers.sql")
      yield* Console.log(`Writing to ${triggersFile}...`)
      yield* writeFile(triggersFile, triggerSQL)

      yield* Console.log("✓ Done!")
    } else {
      yield* Console.log("") // empty line
      yield* Console.log(schema)
    }
  })

/**
 * Error handler - displays errors in a user-friendly format
 */
const handleError = (error: ProgramError): Effect.Effect<void> =>
  Match.value(error).pipe(
    Match.tag("InvalidUsage", () => Effect.void),
    Match.tag("FileReadError", (err) =>
      displayErrorLines([
        `Error reading file: ${err.path}`,
        `  ${err.message}`,
      ]),
    ),
    Match.tag("FileWriteError", (err) =>
      displayErrorLines([
        `Error writing file: ${err.path}`,
        `  ${err.message}`,
      ]),
    ),
    Match.tag("DirectoryCreateError", (err) =>
      displayErrorLines([
        `Error creating directory: ${err.path}`,
        `  ${err.message}`,
      ]),
    ),
    Match.tag("ParseError", (err) =>
      displayErrorLines([
        "Parse errors:",
        ...err.errors.map((e) => `  ${JSON.stringify(e, null, 2)}`),
      ]),
    ),
    Match.tag("GeneratorError", (err) =>
      Match.value(err.error).pipe(
        Match.tag("UnknownBaseType", (e) =>
          displayErrorLines([
            "Generator error: Unknown base type",
            `  Attribute: ${e.attribute}`,
            `  Base name: ${e.baseName}`,
            `  Make sure the base "${e.baseName}" is declared before using it.`,
          ]),
        ),
        Match.tag("InvalidTypeReference", (e) =>
          displayErrorLines([
            "Generator error: Invalid type reference",
            `  Attribute: ${e.attribute}`,
            `  Type name: ${e.typeName}`,
          ]),
        ),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  )

/**
 * Main program with argument parsing
 */
const program = Effect.gen(function* () {
  const args = process.argv.slice(2)

  // Parse and validate arguments
  const { inputFile, outputFile, dbType, prefix } = yield* parseArgs(args).pipe(
    Effect.tapError(() =>
      displayErrorLines([
        "Usage: xplain2drizzle <input.ddl> [output.ts] --database <type> [--prefix <prefix>]",
        "",
        "Arguments:",
        "  <input.ddl>   Input Xplain DDL file",
        "  [output.ts]   Output Drizzle schema file (optional, writes to stdout if not specified)",
        "  --database    Database type: postgres or sqlite",
        "  --prefix      Optional prefix for SQL table names (e.g., pf_)",
        "",
        "Examples:",
        "  xplain2drizzle test.ddl schema.ts --database=postgres",
        "  xplain2drizzle test.ddl schema.ts --database=postgres --prefix=pf_",
        "  xplain2drizzle test.ddl --database sqlite > schema.ts",
        "  xplain2drizzle test.ddl --database sqlite",
      ]),
    ),
  )

  // Run the program with validated arguments
  yield* runProgram(inputFile, outputFile, dbType, prefix)
})

// Execute the program
Effect.runPromise(program.pipe(Effect.catchAll(handleError))).then(
  () => process.exit(0),
  () => process.exit(1),
)
