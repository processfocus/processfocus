import { Data, Effect } from "effect"
import type * as AST from "effect/SchemaAST"
import {
  FormComponentPluginType,
  type FormComponentPluginTypeDeclaration,
} from "@pf/form-schema"
import type {
  OrganisationFrontendManifest,
  OrganisationFrontendManifestAnalyticsPlugin,
  OrganisationFrontendManifestFormComponentPlugin,
  OrganisationFrontendManifestFormComponentPluginDeclaration,
  OrganisationFrontendManifestProcessDocumentation,
} from "@pf/frontend-manifest"
import {
  ORGANISATION_FRONTEND_MANIFEST_VERSION,
  ensureNonEmptyString,
  ensureRecord,
  isRecord,
} from "@pf/frontend-manifest"
import { buildOrganisationFrontendManifestAppIcons } from "./app-icons"
import { isProcess } from "./brands"
import type { Form } from "./form"
import { normalizePath } from "./org-utils"
import type { Organisation } from "./organisation"
import {
  type EmbeddedFormMetadataBuildError,
  type EmbeddedFormNotStartStepError,
  type EmbeddedProcessHasMultipleStartStepsError,
  type UnsupportedEmbeddedFormFieldError,
  buildOrganisationEmbedManifest,
} from "./organisation-embed-manifest"
import {
  buildOrganisationFrontendPluginManifestClientPlugin,
  findOrganisationFrontendPluginManifestProviders,
} from "./organisation-frontend-plugin-manifest"
import { buildOrganisationFrontendManifestPublicFormBranding } from "./public-form-branding"

export type {
  OrganisationFrontendManifest,
  OrganisationFrontendManifestAnalyticsPlugin,
  OrganisationFrontendManifestFormComponentPlugin,
  OrganisationFrontendManifestProcessDocumentation,
} from "@pf/frontend-manifest"
export {
  ORGANISATION_FRONTEND_MANIFEST_FILE,
  ORGANISATION_FRONTEND_MANIFEST_VERSION,
  parseOrganisationFrontendManifest,
} from "@pf/frontend-manifest"

export class OrganisationFrontendManifestBuildError extends Data.TaggedError(
  "OrganisationFrontendManifestBuildError",
)<{
  readonly message: string
  readonly cause: unknown
}> {}

const isSchemaAst = (value: unknown): value is AST.AST =>
  isRecord(value) && typeof value["_tag"] === "string"

const isSchemaWithAst = (value: unknown): value is { readonly ast: AST.AST } =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  isSchemaAst((value as { readonly ast?: unknown }).ast)

const isListConstruct = (
  construct: unknown,
): construct is { readonly isList: true; readonly formFields?: unknown } =>
  isRecord(construct) && construct["isList"] === true

const parseFormComponentPluginDeclaration = (
  value: unknown,
): FormComponentPluginTypeDeclaration => {
  const declaration = ensureRecord(value, "FormComponentPluginType annotation")
  return {
    module: ensureNonEmptyString(
      declaration["module"],
      "FormComponentPluginType annotation.module",
    ),
    type: ensureNonEmptyString(
      declaration["type"],
      "FormComponentPluginType annotation.type",
    ),
  }
}

const collectPluginDeclarationsFromAst = (
  ast: AST.AST,
  annotations: AST.Annotations = ast.annotations,
): ReadonlyArray<FormComponentPluginTypeDeclaration> => {
  const declarations: FormComponentPluginTypeDeclaration[] = []
  const mergedAnnotations = { ...ast.annotations, ...annotations }
  const declaration = mergedAnnotations[FormComponentPluginType]

  if (declaration !== undefined) {
    declarations.push(parseFormComponentPluginDeclaration(declaration))
  }

  switch (ast._tag) {
    case "TypeLiteral": {
      for (const prop of ast.propertySignatures) {
        declarations.push(
          ...collectPluginDeclarationsFromAst(prop.type, prop.annotations),
        )
      }

      return declarations
    }
    case "TupleType": {
      const restType = ast.rest[0]

      if (!restType) {
        return declarations
      }

      declarations.push(...collectPluginDeclarationsFromAst(restType.type))
      return declarations
    }
    case "Refinement":
      declarations.push(
        ...collectPluginDeclarationsFromAst(ast.from, {
          ...ast.annotations,
          ...annotations,
        }),
      )
      return declarations
    case "Transformation":
      declarations.push(
        ...collectPluginDeclarationsFromAst(ast.from, {
          ...ast.annotations,
          ...annotations,
        }),
      )
      return declarations
    case "Union": {
      for (const type of ast.types) {
        if (type._tag === "Literal" && type.literal === null) {
          continue
        }

        if (type._tag === "UndefinedKeyword") {
          continue
        }

        declarations.push(
          ...collectPluginDeclarationsFromAst(type, {
            ...ast.annotations,
            ...annotations,
          }),
        )
      }

      return declarations
    }
    default:
      return declarations
  }
}

const addPluginDeclaration = (
  declarations: Map<
    string,
    OrganisationFrontendManifestFormComponentPluginDeclaration
  >,
  declaration: OrganisationFrontendManifestFormComponentPluginDeclaration,
): void => {
  const existing = declarations.get(declaration.type)
  if (existing && existing.module !== declaration.module) {
    throw new Error(
      `Frontend plugin type "${declaration.type}" declares conflicting modules "${existing.module}" and "${declaration.module}"`,
    )
  }
  declarations.set(declaration.type, declaration)
}

const findFormComponentPlugins = (
  org: Organisation,
): ReadonlyArray<OrganisationFrontendManifestFormComponentPlugin> => {
  const declarations = new Map<
    string,
    OrganisationFrontendManifestFormComponentPluginDeclaration
  >()

  const collectFromFields = (fields: unknown) => {
    const fieldRecord = ensureRecord(fields, "list.formFields")

    for (const [fieldName, schema] of Object.entries(fieldRecord)) {
      if (!isSchemaWithAst(schema)) {
        throw new Error(`list.formFields.${fieldName} must be an Effect schema`)
      }

      for (const declaration of collectPluginDeclarationsFromAst(schema.ast)) {
        addPluginDeclaration(declarations, declaration)
      }
    }
  }

  for (const construct of org.node.findAll()) {
    const maybeForm = construct as { readonly isForm?: unknown }

    if (maybeForm.isForm === true) {
      const form = construct as Form<
        Record<string, unknown>,
        Record<string, never>,
        Record<string, never>
      >

      for (const declaration of collectPluginDeclarationsFromAst(
        form.outputSchema.ast,
      )) {
        addPluginDeclaration(declarations, declaration)
      }
      continue
    }

    if (isListConstruct(construct) && construct.formFields !== undefined) {
      collectFromFields(construct.formFields)
    }
  }

  // Org constructs may declare formComponents-category client plugins that are
  // not form fields (e.g. execution-menu wiring) but still need frontend load.
  for (const provider of findOrganisationFrontendPluginManifestProviders(org)) {
    if (provider.frontendManifestPluginCategory !== "formComponents") {
      continue
    }
    const { module, type } =
      buildOrganisationFrontendPluginManifestClientPlugin(provider)
    addPluginDeclaration(declarations, { module, type })
  }

  return Array.from(declarations.values()).sort((left, right) =>
    left.type.localeCompare(right.type),
  )
}

const buildAnalyticsPlugins = (
  org: Organisation,
): ReadonlyArray<OrganisationFrontendManifestAnalyticsPlugin> => {
  return findOrganisationFrontendPluginManifestProviders(org)
    .filter(
      (provider) => provider.frontendManifestPluginCategory === "analytics",
    )
    .map((provider) =>
      buildOrganisationFrontendPluginManifestClientPlugin(provider),
    )
    .map(({ module, type, config }) => ({ module, type, config }))
}

const assertNoConflictingPluginModules = (
  plugins: ReadonlyArray<OrganisationFrontendManifestFormComponentPluginDeclaration>,
): void => {
  const declarations = new Map<
    string,
    OrganisationFrontendManifestFormComponentPluginDeclaration
  >()
  for (const plugin of plugins) {
    addPluginDeclaration(declarations, plugin)
  }
}

const buildProcessDocumentation = (
  org: Organisation,
): ReadonlyArray<OrganisationFrontendManifestProcessDocumentation> => {
  return org.node
    .findAll()
    .filter(isProcess)
    .map((process) => ({
      processPath: normalizePath(process.node.path),
      documentationPath: process.props.documentationPath,
    }))
    .filter(
      (entry): entry is OrganisationFrontendManifestProcessDocumentation =>
        entry.documentationPath !== undefined,
    )
    .sort((left, right) => left.processPath.localeCompare(right.processPath))
}

export const buildOrganisationFrontendManifest = (
  org: Organisation,
  options?: { readonly basePath?: string | undefined },
): Effect.Effect<
  OrganisationFrontendManifest,
  | EmbeddedFormNotStartStepError
  | EmbeddedProcessHasMultipleStartStepsError
  | UnsupportedEmbeddedFormFieldError
  | EmbeddedFormMetadataBuildError
  | OrganisationFrontendManifestBuildError,
  never
> =>
  Effect.gen(function* () {
    const embedManifest = yield* buildOrganisationEmbedManifest(org)
    const appIcons = yield* Effect.try({
      try: () =>
        buildOrganisationFrontendManifestAppIcons(org, {
          basePath: options?.basePath,
        }),
      catch: (error) =>
        new OrganisationFrontendManifestBuildError({
          message:
            error instanceof Error
              ? error.message
              : "Failed to build App Icons for frontend manifest",
          cause: error,
        }),
    })
    const analyticsPlugins = yield* Effect.try({
      try: () => buildAnalyticsPlugins(org),
      catch: (error) =>
        new OrganisationFrontendManifestBuildError({
          message:
            error instanceof Error
              ? error.message
              : "Failed to build analytics plugins for frontend manifest",
          cause: error,
        }),
    })
    const formComponentPlugins = yield* Effect.try({
      try: () => findFormComponentPlugins(org),
      catch: (error) =>
        new OrganisationFrontendManifestBuildError({
          message:
            error instanceof Error
              ? error.message
              : "Failed to collect form component plugins for frontend manifest",
          cause: error,
        }),
    })
    yield* Effect.try({
      try: () =>
        assertNoConflictingPluginModules([
          ...analyticsPlugins,
          ...formComponentPlugins,
        ]),
      catch: (error) =>
        new OrganisationFrontendManifestBuildError({
          message:
            error instanceof Error
              ? error.message
              : "Conflicting frontend plugin module declarations",
          cause: error,
        }),
    })
    const publicFormBranding = yield* Effect.try({
      try: () =>
        buildOrganisationFrontendManifestPublicFormBranding(org, {
          basePath: options?.basePath,
        }),
      catch: (error) =>
        new OrganisationFrontendManifestBuildError({
          message:
            error instanceof Error
              ? error.message
              : "Failed to build Public Form Branding for frontend manifest",
          cause: error,
        }),
    })

    return {
      version: ORGANISATION_FRONTEND_MANIFEST_VERSION,
      organisation: {
        name: org.name,
        ...(org.acronym !== undefined ? { acronym: org.acronym } : {}),
      },
      appIcons,
      publicFormBranding,
      embed: {
        entries: embedManifest.entries,
      },
      processes: {
        documentation: buildProcessDocumentation(org),
      },
      plugins: {
        analytics: analyticsPlugins,
        formComponents: formComponentPlugins,
      },
    }
  })
