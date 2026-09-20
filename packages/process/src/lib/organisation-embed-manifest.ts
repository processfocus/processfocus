import { Data, Effect } from "effect"
import {
  type ClientFormDefinition,
  type FormComponent,
  FormComponentType,
  parseNullableClientFormDefinition,
} from "@pf/form-client-representation"
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
  readonly formDefinition: ClientFormDefinition | null
  readonly defaultValues: Record<string, unknown> | null
  readonly jsonSchema: Record<string, unknown> | null
  readonly sites: readonly string[]
  readonly thankYou: string
}

export interface OrganisationEmbedManifest {
  readonly version: typeof ORGANISATION_EMBED_MANIFEST_VERSION
  readonly entries: readonly OrganisationEmbedManifestEntry[]
}

export const ORGANISATION_EMBED_MANIFEST_VERSION = 2 as const

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

const hasUnsupportedEmbeddedField = (
  component: FormComponent,
): FormComponentType.File | null => {
  if (component._tag === FormComponentType.File) {
    return component._tag
  }

  if (component._tag === FormComponentType.FieldSet) {
    for (const child of Object.values(component.children)) {
      const unsupported = hasUnsupportedEmbeddedField(child)
      if (unsupported) {
        return unsupported
      }
    }
  }

  if (
    component._tag === FormComponentType.List ||
    component._tag === FormComponentType.Table
  ) {
    for (const child of Object.values(component.itemChildren)) {
      const unsupported = hasUnsupportedEmbeddedField(child)
      if (unsupported) {
        return unsupported
      }
    }
  }

  return null
}

const validateEmbeddableForm = (
  form: Form<
    Record<string, unknown>,
    Record<string, never>,
    Record<string, never>
  >,
  formDefinition: ClientFormDefinition | null,
) =>
  Effect.gen(function* () {
    if (!formDefinition) {
      return
    }

    for (const component of Object.values(formDefinition.components)) {
      const unsupported = hasUnsupportedEmbeddedField(component)
      if (unsupported) {
        return yield* new UnsupportedEmbeddedFormFieldError({
          stepPath: normalizePath(form.node.path),
          fieldType: unsupported,
          message:
            `Embedded form ${normalizePath(form.node.path)} uses unsupported field type ${unsupported}. ` +
            "File fields are not supported in embedded forms yet.",
        })
      }
    }
  })

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
    // Embed manifests are static deploy metadata. Render-time dynamic text is
    // resolved by form metadata requests where the runtime services exist.
    const formDefinition = yield* form.clientFormDefinition().pipe(
      Effect.mapError(
        (cause) =>
          new EmbeddedFormMetadataBuildError({
            stepPath: normalizePath(form.node.path),
            message: `Failed to build embed metadata for ${normalizePath(form.node.path)}`,
            cause,
          }),
      ),
    )

    yield* validateEmbeddableForm(form, formDefinition)

    const process = form.process
    const stepPath = normalizePath(form.node.path)

    return {
      stepPath,
      processName: process.props.name,
      processPath: normalizePath(process.node.path),
      mutationName: process.startMutationName(),
      inputTypeName: pathToPascalCase(form.node.path),
      totalFields: form.totalFields,
      formDefinition,
      defaultValues: form.output ? form.defaults() : null,
      jsonSchema: form.output ? form.submissionSchema() : null,
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
      const formDefinition = parseNullableClientFormDefinition(
        item["formDefinition"],
        `${entryPath}.formDefinition`,
      )

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
        formDefinition,
        defaultValues:
          item["defaultValues"] === null
            ? null
            : ensureRecord(
                item["defaultValues"],
                `entries[${index}].defaultValues`,
              ),
        jsonSchema:
          item["jsonSchema"] === null
            ? null
            : ensureRecord(item["jsonSchema"], `entries[${index}].jsonSchema`),
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
