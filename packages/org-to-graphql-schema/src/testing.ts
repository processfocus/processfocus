import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { isDeepStrictEqual } from "node:util"
import { Effect, JSONSchema, Schema } from "effect"
import {
  type GraphQLInputType,
  type GraphQLSchema,
  Kind,
  buildSchema,
  extendSchema,
  isInputObjectType,
  isListType,
  isNonNullType,
  parse,
  validateInputValue,
} from "graphql"
import { submissionSchemaSync } from "@pf/form-submission-schema"
import {
  type Form,
  type Organisation,
  OrganisationProviderTest,
  type StepMeta,
  pathToPascalCase,
} from "@pf/process"
import { buildDynamicSchema } from "./lib/org-to-graphql-schema"

/** Build the actual organisation inputs, including start and completion mutations. */
export const buildFormContractSchema = async (
  org: Organisation,
): Promise<GraphQLSchema> => {
  const require = createRequire(import.meta.url)
  let schema = buildSchema(
    readFileSync(require.resolve("@pf/graphql-schema/rxdb.graphql"), "utf8"),
  )
  const sources = [
    readFileSync(require.resolve("@pf/graphql-schema/system.graphql"), "utf8"),
    await Effect.runPromise(
      buildDynamicSchema().pipe(Effect.provide(OrganisationProviderTest(org))),
    ),
  ]
  for (const source of sources) {
    const document = parse(source)
    schema = extendSchema(schema, {
      ...document,
      definitions: document.definitions
        .filter(
          (definition) =>
            definition.kind !== Kind.SCALAR_TYPE_DEFINITION ||
            !schema.getType(definition.name.value),
        )
        .map((definition) =>
          definition.kind === Kind.OBJECT_TYPE_DEFINITION &&
          ["Query", "Mutation"].includes(definition.name.value)
            ? { ...definition, kind: Kind.OBJECT_TYPE_EXTENSION }
            : definition,
        ),
    })
  }
  return schema
}

// Presentation annotations and root openness do not change submitted values.
const semantics = (value: unknown, propertyMap = false): unknown => {
  if (Array.isArray(value)) return value.map((child) => semantics(child))
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          propertyMap ||
          ![
            "$schema",
            "title",
            "description",
            "default",
            "examples",
            "x-message",
          ].includes(key),
      )
      .map(([key, child]) => [
        key,
        semantics(child, ["properties", "$defs", "definitions"].includes(key)),
      ]),
  )
}

const differences = (
  expected: unknown,
  actual: unknown,
  path = "",
): string[] => {
  if (isDeepStrictEqual(expected, actual)) return []
  if (
    expected &&
    actual &&
    typeof expected === "object" &&
    typeof actual === "object" &&
    !Array.isArray(expected) &&
    !Array.isArray(actual)
  ) {
    const left = new Map(Object.entries(expected))
    const right = new Map(Object.entries(actual))
    return [...new Set([...left.keys(), ...right.keys()])].flatMap((key) =>
      differences(left.get(key), right.get(key), path ? `${path}.${key}` : key),
    )
  }
  return [path || "<root>"]
}

const record = (value: unknown): Record<string, unknown> =>
  Schema.decodeUnknownSync(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  )(value)

/** Independently compare JSON wire semantics with GraphQL; do not reuse the SDL
 * generator as the oracle (a generator bug must fail these contracts too).
 */
const checkGraphQL = (
  root: Record<string, unknown>,
  inputType: GraphQLInputType,
): void => {
  const visit = (
    json: Record<string, unknown>,
    graphql: GraphQLInputType,
    path: string,
    required: boolean,
    ancestors: readonly string[],
  ): void => {
    if (typeof json["$ref"] === "string") {
      if (ancestors.includes(json["$ref"])) return
      const reference = json["$ref"]
      if (!reference.startsWith("#/"))
        throw new Error(
          `GraphQL ${path}: unsupported JSON reference ${reference}`,
        )
      let resolved: unknown = root
      for (const part of reference.slice(2).split("/"))
        resolved =
          record(resolved)[part.replaceAll("~1", "/").replaceAll("~0", "~")]
      visit(record(resolved), graphql, path, required, [
        ...ancestors,
        reference,
      ])
      return
    }
    const variants = Array.isArray(json["anyOf"])
      ? json["anyOf"].map(record)
      : [json]
    const types = variants.flatMap((variant) =>
      Array.isArray(variant["type"]) ? variant["type"] : [variant["type"]],
    )
    const nullable =
      types.includes("null") ||
      variants.some(
        (variant) =>
          Array.isArray(variant["enum"]) && variant["enum"].includes(null),
      )
    const nonNull = required && !nullable
    if (isNonNullType(graphql) !== nonNull)
      throw new Error(
        `GraphQL ${path}: requiredness differs from submissionSchema`,
      )
    const type = isNonNullType(graphql) ? graphql.ofType : graphql
    const value = variants.find((variant) => variant["type"] !== "null") ?? json
    if (typeof value["$ref"] === "string") {
      visit(value, type, path, false, ancestors)
      return
    }
    const kind =
      types.find((candidate) => candidate !== "null") ??
      (Array.isArray(value["enum"])
        ? typeof value["enum"].find((item) => item !== null)
        : undefined)
    if (kind === "object") {
      if (!isInputObjectType(type))
        throw new Error(`GraphQL ${path}: expected object, got ${type}`)
      const properties = record(value["properties"] ?? {})
      const actual = type.getFields()
      const names = Object.keys(properties)
      if (names.length === 0) return // GraphQL's generated _dummy input for no-value forms.
      for (const name of new Set([...names, ...Object.keys(actual)])) {
        const childPath = path ? `${path}.${name}` : name
        const field = actual[name]
        if (!field || !(name in properties))
          throw new Error(`GraphQL ${childPath}: submitted field path differs`)
        visit(
          record(properties[name]),
          field.type,
          childPath,
          Array.isArray(value["required"]) && value["required"].includes(name),
          ancestors,
        )
      }
    } else if (kind === "array") {
      if (!isListType(type))
        throw new Error(`GraphQL ${path}: expected list, got ${type}`)
      visit(record(value["items"]), type.ofType, `${path}[]`, true, ancestors)
    } else {
      const expected =
        kind === "boolean"
          ? ["Boolean"]
          : kind === "string"
            ? ["String", "ID"]
            : kind === "number"
              ? ["Float"]
              : kind === "integer"
                ? ["Float", "Int"]
                : []
      if (!expected.includes(String(type)))
        throw new Error(
          `GraphQL ${path}: JSON ${String(kind)} is incompatible with ${type}`,
        )
    }
  }
  // Input object presence is enforced by the mutation argument, not this schema.
  visit(root, inputType, "", false, [])
}

/** Representative fixtures are authored beside the organisation's process tests.
 * Args preserve the concrete Form's state/context/item types. `input` is the
 * wire submission (wrappers flattened; structural/read-only values omitted).
 */
export const verifyFormContract = async <Args extends unknown[]>(options: {
  readonly schema: GraphQLSchema
  readonly form: {
    readonly node: { readonly path: string }
    getFieldsWithState(...args: Args): Schema.Struct.Fields
    submissionSchema(): Record<string, unknown>
  }
  readonly fixtures: readonly [
    { readonly name: string; readonly args: Args; readonly input: unknown },
    ...{
      readonly name: string
      readonly args: Args
      readonly input: unknown
    }[],
  ]
}): Promise<void> => {
  const { form, schema } = options
  const typeName = pathToPascalCase(form.node.path)
  const inputType = schema.getType(typeName)
  if (!isInputObjectType(inputType))
    throw new Error(`${form.node.path}: missing GraphQL input ${typeName}`)
  const mutations = Object.values(
    schema.getMutationType()?.getFields() ?? {},
  ).filter((field) =>
    field.args.some((arg) => String(arg.type).replace(/!$/, "") === typeName),
  )

  for (const fixture of options.fixtures) {
    try {
      // Resolve defaults/presentation while keeping the declared value contract.
      const fields = form.getFieldsWithState(...fixture.args)
      const submission = submissionSchemaSync(Schema.Struct(fields))
      const { additionalProperties: _openness, ...runtimeJson } = record(
        JSONSchema.make(submission),
      )
      const mismatches = differences(
        semantics(runtimeJson),
        semantics(form.submissionSchema()),
      )
      if (mismatches.length)
        throw new Error(`submissionSchema mismatch: ${mismatches.join(", ")}`)
      if (Object.keys(submission.fields).length > 0) {
        if (mutations.length === 0)
          throw new Error(`no start/completion mutation uses ${typeName}`)
        checkGraphQL(runtimeJson, inputType)
      }

      Schema.decodeUnknownSync(Schema.encodedSchema(submission))(fixture.input)
      validateInputValue(fixture.input, inputType, (error, path) => {
        throw new Error(`GraphQL ${path.join(".")}: ${error.message}`)
      })
    } catch (cause) {
      throw new Error(
        `${form.node.path} [${fixture.name}]: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      )
    }
  }
}

/** Dynamic discovery erases authored generics; validate the node at this boundary.
 * Fixtures for exported concrete forms can instead pass the typed Form directly.
 */
export const contractFormAt = (
  org: Organisation,
  path: string,
): Form<
  Record<string, unknown>,
  Record<string, StepMeta>,
  Schema.Struct.Fields,
  string,
  unknown
> => {
  const form = org.formByPath(path)
  if (!form) throw new Error(`Missing contract form: ${path}`)
  return form as Form<
    Record<string, unknown>,
    Record<string, StepMeta>,
    Schema.Struct.Fields,
    string,
    unknown
  >
}
