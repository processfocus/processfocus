import { Data, Effect, Schema, type SchemaAST } from "effect"
import {
  FormCalendarSlotInput,
  FormFileInput,
  FormLookupInput,
  fieldAnnotation,
  hasFlattenAnnotation,
} from "@pf/form-schema"
import type { EmbedLookupDefinition } from "@pf/frontend-manifest"
import type { Form } from "./form"
import { normalizePath, pathToPascalCase } from "./org-utils"
import type { Organisation } from "./organisation"

export interface OrganisationEmbedManifestEntry {
  readonly stepPath: string
  readonly processName: string
  readonly processPath: string
  readonly mutationName: string
  readonly inputTypeName: string
  readonly totalFields: number
  readonly formPath: string
  readonly lookups: readonly EmbedLookupDefinition[]
  readonly sites: readonly string[]
  readonly thankYou: string
}

export interface OrganisationEmbedManifest {
  readonly version: typeof ORGANISATION_EMBED_MANIFEST_VERSION
  readonly entries: readonly OrganisationEmbedManifestEntry[]
}

export const ORGANISATION_EMBED_MANIFEST_VERSION = 3 as const

export class EmbeddedFormNotStartStepError extends Data.TaggedError(
  "EmbeddedFormNotStartStepError",
)<{
  readonly stepPath: string
  readonly message: string
}> {}

export class UnsupportedEmbeddedFormFieldError extends Data.TaggedError(
  "UnsupportedEmbeddedFormFieldError",
)<{
  readonly stepPath: string
  readonly fieldType: string
  readonly message: string
}> {}

export class EmbeddedFormMetadataBuildError extends Data.TaggedError(
  "EmbeddedFormMetadataBuildError",
)<{
  readonly stepPath: string
  readonly message: string
  readonly cause: unknown
}> {}

export class EmbeddedProcessHasMultipleStartStepsError extends Data.TaggedError(
  "EmbeddedProcessHasMultipleStartStepsError",
)<{
  readonly processPath: string
  readonly message: string
}> {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const ensureRecord = (
  value: unknown,
  path: string,
): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`)
  }

  return value
}

const ensureString = (value: unknown, path: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`)
  }

  return value
}

const ensureStringArray = (value: unknown, path: string): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path} must be an array of strings`)
  }

  return value
}

/** Static capability discovery; never decode values or run rules at build time. */
const embedFields = (
  ast: SchemaAST.AST,
  path: readonly string[] = [],
): readonly { path: readonly string[]; schema: Schema.Constraint }[] => {
  const schema = Schema.make(ast)
  const own = [{ path, schema }]
  if (ast._tag === "Objects") {
    const prefix = hasFlattenAnnotation(schema) ? path.slice(0, -1) : path
    return own.concat(
      ast.propertySignatures.flatMap((property) =>
        embedFields(property.type, [...prefix, String(property.name)]),
      ),
    )
  }
  if (ast._tag === "Arrays")
    return own.concat(
      [...ast.elements, ...ast.rest].flatMap((element) =>
        embedFields(element, path),
      ),
    )
  if (ast._tag === "Union")
    return own.concat(ast.types.flatMap((member) => embedFields(member, path)))
  return own
}

const buildEntry = (
  form: Form<
    Record<string, unknown>,
    Record<string, never>,
    Record<string, never>
  >,
): Effect.Effect<
  OrganisationEmbedManifestEntry,
  UnsupportedEmbeddedFormFieldError | EmbeddedFormMetadataBuildError,
  never
> =>
  Effect.gen(function* () {
    if (!form.browser) {
      return yield* new EmbeddedFormMetadataBuildError({
        stepPath: normalizePath(form.node.path),
        message: "Embedded forms require an executable browser artifact",
        cause: undefined,
      })
    }
    const lookups: EmbedLookupDefinition[] = []
    for (const field of embedFields(form.sharedSchema.ast)) {
      if (fieldAnnotation(field.schema.ast, FormFileInput) !== undefined) {
        return yield* new UnsupportedEmbeddedFormFieldError({
          stepPath: normalizePath(form.node.path),
          fieldType: "file",
          message:
            "Embedded file uploads require an anonymous upload authorization model.",
        })
      }
      const calendar =
        fieldAnnotation(field.schema.ast, FormCalendarSlotInput) !== undefined
      if (
        calendar ||
        fieldAnnotation(field.schema.ast, FormLookupInput) !== undefined
      ) {
        const name = field.path.join(".")
        const override = form.lookupOverrides().get(name)
        lookups.push({
          type: calendar ? "calendarSlot" : "lookup",
          field: name,
          normalizedField: field.path.at(-1) ?? name,
          dependencies: override?.dependencies ?? [],
          ...(override?.dependencies?.length
            ? { queryName: form.lookupQueryName(name) }
            : {}),
        })
      }
    }

    const process = form.process
    const stepPath = normalizePath(form.node.path)

    return {
      stepPath,
      processName: process.props.name,
      processPath: normalizePath(process.node.path),
      mutationName: process.startMutationName(),
      inputTypeName: pathToPascalCase(form.node.path),
      totalFields: form.totalFields,
      formPath: stepPath,
      lookups: [
        ...new Map(lookups.map((lookup) => [lookup.field, lookup])).values(),
      ],
      sites: form.embed?.sites ?? [],
      thankYou: form.embed?.thankYou ?? "",
    }
  })

export const parseOrganisationEmbedManifest = (
  value: unknown,
): OrganisationEmbedManifest => {
  const record = ensureRecord(value, "organisation embed manifest")

  if (record["version"] !== ORGANISATION_EMBED_MANIFEST_VERSION) {
    throw new Error(
      `organisation embed manifest version must be ${String(ORGANISATION_EMBED_MANIFEST_VERSION)}`,
    )
  }

  if (!Array.isArray(record["entries"])) {
    throw new Error("entries must be an array")
  }

  return {
    version: ORGANISATION_EMBED_MANIFEST_VERSION,
    entries: record["entries"].map((entry, index) => {
      const item = ensureRecord(entry, `entries[${index}]`)
      const entryPath = `entries[${index}]`

      return {
        stepPath: ensureString(item["stepPath"], `entries[${index}].stepPath`),
        processName: ensureString(
          item["processName"],
          `entries[${index}].processName`,
        ),
        processPath: ensureString(
          item["processPath"],
          `entries[${index}].processPath`,
        ),
        mutationName: ensureString(
          item["mutationName"],
          `entries[${index}].mutationName`,
        ),
        inputTypeName: ensureString(
          item["inputTypeName"],
          `entries[${index}].inputTypeName`,
        ),
        totalFields:
          typeof item["totalFields"] === "number"
            ? item["totalFields"]
            : (() => {
                throw new Error(
                  `entries[${index}].totalFields must be a number`,
                )
              })(),
        formPath: ensureString(item["formPath"], `${entryPath}.formPath`),
        lookups: Schema.decodeUnknownSync(
          Schema.Array(
            Schema.Struct({
              type: Schema.Literals(["lookup", "calendarSlot"]),
              field: Schema.String,
              normalizedField: Schema.String,
              dependencies: Schema.Array(Schema.String),
              queryName: Schema.optional(Schema.String),
            }),
          ),
        )(item["lookups"]),
        sites: ensureStringArray(item["sites"], `entries[${index}].sites`),
        thankYou: ensureString(item["thankYou"], `entries[${index}].thankYou`),
      }
    }),
  }
}

export const buildOrganisationEmbedManifest = (
  org: Organisation,
): Effect.Effect<
  OrganisationEmbedManifest,
  | EmbeddedFormNotStartStepError
  | EmbeddedProcessHasMultipleStartStepsError
  | UnsupportedEmbeddedFormFieldError
  | EmbeddedFormMetadataBuildError,
  never
> =>
  Effect.gen(function* () {
    const embeddedStartForms: Array<
      Form<
        Record<string, unknown>,
        Record<string, never>,
        Record<string, never>
      >
    > = []
    const embeddedStartPaths = new Set<string>()

    for (const process of org.processes()) {
      const startNodes = process.startNodes()
      const embeddedStartNodeCount = startNodes.filter(
        (node) =>
          node.isForm &&
          (
            node as Form<
              Record<string, unknown>,
              Record<string, never>,
              Record<string, never>
            >
          ).embed,
      ).length

      if (embeddedStartNodeCount > 0 && startNodes.length !== 1) {
        return yield* new EmbeddedProcessHasMultipleStartStepsError({
          processPath: normalizePath(process.node.path),
          message:
            `Embedded process ${normalizePath(process.node.path)} has ${startNodes.length} start steps. ` +
            "Embedded forms currently require exactly one start step.",
        })
      }

      for (const startNode of startNodes) {
        if (!startNode.isForm) {
          continue
        }

        const form = startNode as Form<
          Record<string, unknown>,
          Record<string, never>,
          Record<string, never>
        >

        if (form.embed) {
          const stepPath = normalizePath(form.node.path)
          embeddedStartPaths.add(stepPath)
          embeddedStartForms.push(form)
        }
      }
    }

    for (const process of org.processes()) {
      for (const { form, path } of process.forms()) {
        const normalizedPath = normalizePath(path)

        if (form.embed && !embeddedStartPaths.has(normalizedPath)) {
          return yield* new EmbeddedFormNotStartStepError({
            stepPath: normalizedPath,
            message:
              `Embedded form ${normalizedPath} is not a process start step. ` +
              "Only start forms can be embedded anonymously.",
          })
        }
      }
    }

    const entries = yield* Effect.forEach(embeddedStartForms, buildEntry, {
      concurrency: "unbounded",
    })

    return {
      version: ORGANISATION_EMBED_MANIFEST_VERSION,
      entries: entries.sort((left, right) =>
        left.stepPath.localeCompare(right.stepPath),
      ),
    }
  })
