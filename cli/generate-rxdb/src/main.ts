#!/usr/bin/env bun
import * as fs from "node:fs/promises"
import { Console, Data, Effect, Match } from "effect"
import { RxDbCollections, toRxDbJsonSchema } from "@pf/rxdb-collections"
import { generateGraphQL } from "./generator.js"
import type { WalkError } from "./walker.js"

/**
 * Error for file write operations
 */
export class FileWriteError extends Data.TaggedError("FileWriteError")<{
  readonly path: string
  readonly error: string
}> {
  override get message(): string {
    return `Failed to write file "${this.path}": ${this.error}`
  }
}

/**
 * All possible errors from the CLI
 */
type CliError = WalkError | FileWriteError

/**
 * Convert collection name to kebab-case filename
 */
const toKebabCase = (name: string): string =>
  name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()

/**
 * Pretty-print an object as JSON string for file output.
 * Uses JSON.stringify intentionally for formatted file writing.
 */
const prettyPrintJson = (value: unknown): string =>
  globalThis.JSON.stringify(value, null, 2)

/**
 * Generate JSON schema file for a collection
 */
const generateJsonSchema = (
  collectionName: string,
  // biome-ignore lint/suspicious/noExplicitAny: Effect Schema type
  schema: any,
): Effect.Effect<void, FileWriteError> =>
  Effect.gen(function* () {
    const outputDir = "packages/rxdb-collections/generated"
    const filename = `${toKebabCase(collectionName)}-schema.json`
    const outputPath = `${outputDir}/${filename}`

    const rxdbSchema = toRxDbJsonSchema(schema)

    const content = prettyPrintJson(rxdbSchema)
    yield* Effect.tryPromise({
      try: () => fs.writeFile(outputPath, `${content}\n`, "utf-8"),
      catch: (error) =>
        new FileWriteError({
          path: outputPath,
          error: String(error),
        }),
    })

    yield* Console.log(`  ✓ ${filename}`)
  })

const program = Effect.gen(function* () {
  const graphqlOutputPath = "packages/graphql-schema/graphql/rxdb.graphql"

  yield* Console.log("Generating GraphQL schema from RxDB collections...")

  const graphql = yield* generateGraphQL(RxDbCollections)

  yield* Effect.tryPromise({
    try: () => fs.writeFile(graphqlOutputPath, graphql, "utf-8"),
    catch: (error) =>
      new FileWriteError({
        path: graphqlOutputPath,
        error: String(error),
      }),
  })

  yield* Console.log(`✓ Generated ${graphqlOutputPath}`)

  yield* Console.log("Generating RxDB JSON schemas...")

  for (const [collectionName, schema] of Object.entries(RxDbCollections)) {
    yield* generateJsonSchema(collectionName, schema)
  }

  yield* Console.log(
    `✓ Processed ${Object.keys(RxDbCollections).length} collection(s)`,
  )
})

/**
 * Handle errors and format them for display
 */
const handleError = (error: CliError): Effect.Effect<void> =>
  Match.value(error).pipe(
    Match.tag("UnsupportedSchemaTypeError", (e) =>
      Console.error(`Error: ${e.message}`),
    ),
    Match.tag("InvalidPropertyKeyError", (e) =>
      Console.error(`Error: ${e.message}`),
    ),
    Match.tag("UnrecognizedASTNodeError", (e) =>
      Console.error(`Error: ${e.message}`),
    ),
    Match.tag("FileWriteError", (e) => Console.error(`Error: ${e.message}`)),
    Match.exhaustive,
  )

Effect.runPromise(program.pipe(Effect.catch(handleError))).then(
  () => process.exit(0),
  () => process.exit(1),
)
