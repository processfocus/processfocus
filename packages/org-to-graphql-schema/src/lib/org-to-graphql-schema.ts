import { Data, Effect, Schema } from "effect"
import { submissionSchema } from "@pf/form-submission-schema"
import {
  type Form,
  type List,
  type OrgUnit,
  OrganisationProvider,
  type Process,
  type Step,
  isForm,
  isList,
  isOrgUnit,
  isProcess,
  pathToPascalCase,
} from "@pf/process"
import { walkOutputAST } from "./output-walker"
import { type GeneratedTypes, walkAST } from "./walker"

/**
 * Type alias for forms to reduce repetition
 */
type AnyForm = Form<
  Record<string, never>,
  Record<string, never>,
  Schema.Struct.Fields
>

/**
 * Type alias for lists to reduce repetition
 */
// biome-ignore lint/suspicious/noExplicitAny: List generics erased at runtime
type AnyList = List<any, any, any, any, any, any>

/**
 * Tagged error for invalid process graph
 */
export class InvalidProcessGraph extends Data.TaggedError(
  "InvalidProcessGraph",
)<{
  readonly processPath: string
  readonly cause: unknown
}> {}

/**
 * Tagged error for when a process has no start nodes
 */
export class NoStartNodeError extends Data.TaggedError("NoStartNodeError")<{
  readonly processPath: string
}> {
  override get message() {
    return `Process "${this.processPath}" has no start nodes`
  }
}

// Alias for clarity - pathToPascalCase is used for GraphQL type names
const pathToInputTypeName = pathToPascalCase
const graphqlNamePattern = /^[_A-Za-z][_0-9A-Za-z]*$/

/**
 * Gets start nodes from a process using process.startNodes().
 * Returns the first start node if any exist, fails if none.
 */
const getFirstStartNode = (
  process: Process,
): Effect.Effect<
  Step<Record<string, unknown>, Schema.Struct.Fields | undefined>,
  NoStartNodeError
> =>
  Effect.gen(function* () {
    const startNodes = process.startNodes()

    if (startNodes.length === 0) {
      return yield* new NoStartNodeError({
        processPath: process.node.path,
      })
    }

    // Return the first start node (multiple start nodes are now allowed)
    return startNodes[0] as Step<
      Record<string, unknown>,
      Schema.Struct.Fields | undefined
    >
  })

/**
 * Recursively walks an org unit to find all forms in all processes
 */
const collectFormsFromOrgUnit = (
  orgUnit: OrgUnit,
): Effect.Effect<AnyForm[], InvalidProcessGraph> =>
  Effect.gen(function* () {
    const forms: AnyForm[] = []

    // Process all children of this org unit
    for (const child of orgUnit.node.children) {
      if (isOrgUnit(child)) {
        // Recursively collect from child org units
        const childForms = yield* collectFormsFromOrgUnit(child)
        forms.push(...childForms)
      } else if (isProcess(child)) {
        // Extract forms from this process with error handling
        const graph = yield* Effect.try({
          try: () => child.getGraph(),
          catch: (error) =>
            new InvalidProcessGraph({
              processPath: child.node.path,
              cause: error,
            }),
        })

        const nodes = graph.nodes()

        for (const nodeId of nodes) {
          const step = graph.getNodeAttributes(nodeId)
          if (isForm(step)) {
            forms.push(step)
          }
        }
      }
    }

    return forms
  })

/**
 * Recursively walks an org unit to find all processes
 */
const collectProcessesFromOrgUnit = (
  orgUnit: OrgUnit,
): Effect.Effect<Process[], never> =>
  Effect.gen(function* () {
    const processes: Process[] = []

    // Process all children of this org unit
    for (const child of orgUnit.node.children) {
      if (isOrgUnit(child)) {
        // Recursively collect from child org units
        const childProcesses = yield* collectProcessesFromOrgUnit(child)
        processes.push(...childProcesses)
      } else if (isProcess(child)) {
        processes.push(child)
      }
    }

    return processes
  })

/**
 * Recursively walks an org unit to find all lists
 */
const collectListsFromOrgUnit = (orgUnit: OrgUnit): Effect.Effect<AnyList[]> =>
  Effect.gen(function* () {
    const lists: AnyList[] = []

    // Process all children of this org unit
    for (const child of orgUnit.node.children) {
      if (isOrgUnit(child)) {
        // Recursively collect from child org units
        const childLists = yield* collectListsFromOrgUnit(child)
        lists.push(...childLists)
      } else if (isList(child)) {
        lists.push(child)
      }
    }

    return lists
  })

/**
 * Tagged error for invalid list schema
 */
export class InvalidListSchema extends Data.TaggedError("InvalidListSchema")<{
  readonly listPath: string
  readonly cause: unknown
}> {
  override get message() {
    const causeMessage =
      this.cause instanceof Error ? `: ${this.cause.message}` : ""

    return `Invalid list schema for ${this.listPath}${causeMessage}`
  }
}

/**
 * Generates GraphQL output type definitions for a List item.
 * Returns the main item type and any auxiliary types needed.
 */
const generateListItemType = (
  list: AnyList,
): Effect.Effect<GeneratedTypes, InvalidListSchema> =>
  Effect.gen(function* () {
    const typeName = `${pathToPascalCase(list.node.path)}Item`

    // Create the output schema from the list's output fields
    const outputSchema = Schema.Struct(list.output)

    // Walk the AST to generate GraphQL SDL (output type, not input type)
    const result = yield* walkOutputAST(outputSchema.ast, typeName).pipe(
      Effect.mapError(
        (error) =>
          new InvalidListSchema({
            listPath: list.node.path,
            cause: error,
          }),
      ),
    )

    return result
  })

/**
 * Generates GraphQL output type for a List item's detail view.
 * Uses the form schema (if defined) to generate fields.
 * Returns null if no form is defined.
 */
const generateListDetailType = (
  list: AnyList,
): Effect.Effect<GeneratedTypes | null, InvalidListSchema> =>
  Effect.gen(function* () {
    if (!list.hasForm || !list.formFields) {
      return null
    }

    const typeName = `${pathToPascalCase(list.node.path)}Detail`

    // Create the output schema from the list's form fields
    const formSchema = Schema.Struct(list.formFields)

    // Walk the AST to generate GraphQL SDL (output type, not input type)
    const result = yield* walkOutputAST(formSchema.ast, typeName).pipe(
      Effect.mapError(
        (error) =>
          new InvalidListSchema({
            listPath: list.node.path,
            cause: error,
          }),
      ),
    )

    return result
  })

/**
 * Generates the GraphQL query definition for fetching a single list item by ID.
 * Returns null if no form is defined.
 */
const generateListItemQuery = (
  list: AnyList,
): Effect.Effect<string | null, InvalidListSchema> =>
  Effect.gen(function* () {
    if (!list.hasForm) {
      return null
    }

    const baseName = pathToPascalCase(list.node.path)
    const queryName = list.itemQueryName()
    const detailTypeName = `${baseName}Detail`
    const controlParams: string[] = []

    for (const control of list.itemQueryControls()) {
      if (!graphqlNamePattern.test(control.name) || control.name === "id") {
        return yield* Effect.fail(
          new InvalidListSchema({
            listPath: list.node.path,
            cause: new Error(
              `MetricBreakdown control name "${control.name}" is not a safe GraphQL item query argument name`,
            ),
          }),
        )
      }

      controlParams.push(`${control.name}: String`)
    }

    const params = [`id: String!`, ...controlParams]

    // Nullable return (no !) - returns null if item not found
    return `  ${queryName}(${params.join(", ")}): ${detailTypeName}`
  })

/**
 * Generates the GraphQL page wrapper type for a list.
 */
const generateListPageType = (list: AnyList): string => {
  const baseName = pathToPascalCase(list.node.path)
  const itemTypeName = `${baseName}Item`
  const pageTypeName = `${baseName}Page`

  return `type ${pageTypeName} {
  items: [${itemTypeName}!]!
  totalCount: Int!
  page: Int!
  limit: Int!
  hasNextPage: Boolean!
}`
}

/**
 * Generates the GraphQL query definition for a list.
 * All lists support optional text filtering and standard sort metadata.
 */
const generateListQuery = (list: AnyList): string => {
  const baseName = pathToPascalCase(list.node.path)
  const queryName = list.queryName()
  const pageTypeName = `${baseName}Page`
  const defaultPageSize = list.defaultPageSize

  // Build query parameters - all lists support optional text filter
  const params = [
    `page: Int! = 1`,
    `limit: Int! = ${defaultPageSize}`,
    `filter: String`,
    `sort: ListSortInput`,
  ]

  return `  ${queryName}(${params.join(", ")}): ${pageTypeName}!`
}

/**
 * Generates GraphQL input type definition for list item updates.
 * Uses submissionSchema + walkAST to generate the input type from editable form fields.
 * Returns null if list has no update or no form.
 */
const generateListUpdateInputType = (
  list: AnyList,
): Effect.Effect<GeneratedTypes | null, InvalidListSchema> =>
  Effect.gen(function* () {
    if (!list.hasUpdate || !list.hasForm || !list.formFields) {
      return null
    }

    const typeName = list.updateInputTypeName()

    // Create the submission schema (flattens Wrapper fields)
    const inputSchema = Schema.Struct(list.editableFormFields())
    const submission = yield* submissionSchema(inputSchema).pipe(
      Effect.mapError(
        (error) =>
          new InvalidListSchema({
            listPath: list.node.path,
            cause: error,
          }),
      ),
    )

    // Walk the AST to generate GraphQL SDL (input type)
    const result = yield* walkAST(submission.ast, typeName).pipe(
      Effect.mapError(
        (error) =>
          new InvalidListSchema({
            listPath: list.node.path,
            cause: error,
          }),
      ),
    )

    return result
  })

/**
 * Generates the GraphQL mutation definition for updating a list item.
 * Returns null if list has no update or no form.
 */
const generateListUpdateMutation = (list: AnyList): string | null => {
  if (!list.hasUpdate || !list.hasForm) {
    return null
  }

  const baseName = pathToPascalCase(list.node.path)
  const mutationName = list.updateMutationName()
  const inputTypeName = list.updateInputTypeName()
  const detailTypeName = `${baseName}Detail`

  return `  ${mutationName}(id: String!, input: ${inputTypeName}!): ${detailTypeName}`
}

/**
 * Generates the GraphQL mutation definition for deleting a list item.
 * Returns null if list has no delete.
 */
const generateListDeleteMutation = (list: AnyList): string | null => {
  if (!list.hasDelete) {
    return null
  }

  const mutationName = list.deleteMutationName()

  return `  ${mutationName}(id: String!): Boolean!`
}

/**
 * Generates all GraphQL schema parts for a single list.
 * Returns an object with item types, page types, filter types, query definitions,
 * and optionally detail types, item queries, update input types, and update mutations.
 */
const generateSchemaForList = (
  list: AnyList,
): Effect.Effect<
  {
    itemTypes: GeneratedTypes
    pageType: string
    query: string
    detailType: GeneratedTypes | null
    itemQuery: string | null
    createInputType: GeneratedTypes | null
    createMutation: string | null
    updateInputType: GeneratedTypes | null
    updateMutation: string | null
    deleteMutation: string | null
  },
  InvalidListSchema
> =>
  Effect.gen(function* () {
    const submission = list.createSubmissionSchema()
    const createInputType = submission
      ? yield* walkAST(submission.ast, list.createInputTypeName()).pipe(
          Effect.mapError(
            (cause) =>
              new InvalidListSchema({ listPath: list.node.path, cause }),
          ),
        )
      : null
    const createMutation = list.hasCreate
      ? `  ${list.createMutationName()}(input: ${list.createInputTypeName()}!): String!`
      : null
    const itemTypes = yield* generateListItemType(list)
    const pageType = generateListPageType(list)
    const query = generateListQuery(list)

    // Generate detail type and item query if form is defined
    const detailType = yield* generateListDetailType(list)
    const itemQuery = yield* generateListItemQuery(list)

    // Generate update input type and mutation if update is defined
    const updateInputType = yield* generateListUpdateInputType(list)
    const updateMutation = generateListUpdateMutation(list)

    // Generate delete mutation if delete is defined
    const deleteMutation = generateListDeleteMutation(list)

    return {
      itemTypes,
      pageType,
      query,
      detailType,
      itemQuery,
      createInputType,
      createMutation,
      updateInputType,
      updateMutation,
      deleteMutation,
    }
  })

/**
 * Generates GraphQL input type definitions for a single form
 * Returns the main type and any auxiliary types needed
 */
const generateInputType = (
  form: AnyForm,
): Effect.Effect<GeneratedTypes, InvalidProcessGraph> =>
  Effect.gen(function* () {
    const typeName = pathToInputTypeName(form.node.path)

    // Create the submission schema (flattens Wrapper fields, removes read-only)
    const inputSchema = Schema.Struct(form.output)
    const submission = yield* submissionSchema(inputSchema).pipe(
      Effect.mapError(
        (error) =>
          new InvalidProcessGraph({
            processPath: form.node.path,
            cause: error,
          }),
      ),
    )

    // If the form has no submittable input fields, generate a simple dummy type
    // (GraphQL doesn't allow empty input types)
    if (Object.keys(submission.fields).length === 0) {
      return {
        main: `input ${typeName} {
  _dummy: String
}`,
        auxiliary: [],
      }
    }

    // Walk the AST to generate GraphQL SDL
    const result = yield* walkAST(submission.ast, typeName).pipe(
      Effect.mapError(
        (error) =>
          new InvalidProcessGraph({
            processPath: form.node.path,
            cause: error,
          }),
      ),
    )

    return result
  })

/**
 * Generates GraphQL mutation definitions for a single process
 * Returns an array of mutation definitions (one or two depending on whether start node has input)
 */
const generateMutationsForProcess = (
  process: Process,
): Effect.Effect<string[], NoStartNodeError | InvalidProcessGraph> =>
  Effect.gen(function* () {
    // Get the first start node
    const startNode = yield* getFirstStartNode(process)

    // Get mutation name from the process
    const mutationName = process.startMutationName()
    const startForm = startNode.isForm
      ? (startNode as unknown as Form<
          Record<string, never>,
          Record<string, never>,
          Schema.Struct.Fields
        >)
      : null
    const authTag = startForm?.embed
      ? ' @auth(tag: "embed")'
      : process.props.cron && startNode.isSystemStep
        ? ' @auth(tag: "cron")'
        : ""

    // Only Form start nodes produce GraphQL input types.
    // System steps (e.g. AwsFunctionStep) may have output fields but those
    // are not user-supplied, so no input type is generated for them.
    const hasInputFields =
      startNode.isForm &&
      startNode.output &&
      Object.keys(startNode.output).length > 0
    if (!hasInputFields) {
      // No input fields: only generate start mutation, no draft
      return [
        `  ${mutationName}(executionId: ID, withoutWaiting: Boolean = false): StartProcessPayload!${authTag}`,
      ]
    }

    // Has input fields: generate start mutation
    const inputTypeName = pathToInputTypeName(startNode.node.path)

    return [
      `  ${mutationName}(input: ${inputTypeName}!, executionId: ID, withoutWaiting: Boolean = false): StartProcessPayload!${authTag}`,
    ]
  })

/**
 * Generates complete mutation definitions for all Form steps in a process.
 * For each Form step, generates: complete<StepPath>(todoId: ID!, input: InputType!): CompleteStepPayload!
 * For forms without input: complete<StepPath>(todoId: ID!): CompleteStepPayload!
 */
const generateCompleteMutationsForProcess = (
  process: Process,
): Effect.Effect<string[], InvalidProcessGraph> =>
  Effect.gen(function* () {
    // Get the process graph
    const graph = yield* Effect.try({
      try: () => process.getGraph(),
      catch: (error) =>
        new InvalidProcessGraph({
          processPath: process.node.path,
          cause: error,
        }),
    })

    const mutations: string[] = []
    const nodes = graph.nodes()

    // Iterate all steps in the process
    for (const nodeId of nodes) {
      const step = graph.getNodeAttributes(nodeId)

      // Only generate complete mutations for Form steps
      if (isForm(step)) {
        // Convert step path to mutation name: complete<PascalCasePath>
        const pascalPath = pathToInputTypeName(step.node.path)
        const mutationName = `complete${pascalPath}`

        // Check if form has submittable input fields (excludes read-only)
        const inputSchema = Schema.Struct(step.output)
        const submission = yield* submissionSchema(inputSchema).pipe(
          Effect.mapError(
            (error) =>
              new InvalidProcessGraph({
                processPath: process.node.path,
                cause: error,
              }),
          ),
        )
        const submittableFieldCount = Object.keys(submission.fields).length

        if (submittableFieldCount === 0) {
          // No submittable fields: only todoId parameter
          mutations.push(`  ${mutationName}(todoId: ID!): CompleteStepPayload!`)
        } else {
          // Has submittable fields: todoId and input parameters
          const inputTypeName = pathToInputTypeName(step.node.path)
          mutations.push(
            `  ${mutationName}(todoId: ID!, input: ${inputTypeName}!): CompleteStepPayload!`,
          )
        }
      }
    }

    return mutations
  })

/**
 * Generates GraphQL input types and query fields for dependent lookup overrides.
 *
 * For each form with lookup overrides that have dependencies, generates:
 * - An input type: `input Lookup<PascalPath>Input { filter: String, dep1: String!, ... }`
 * - A query field: `lookup<PascalPath>(input: Lookup<PascalPath>Input!, limit: Int): [LookupItem!]!`
 */
const generateLookupQueriesForProcess = (
  process: Process,
): { inputTypes: string[]; queryFields: string[] } => {
  const inputTypes: string[] = []
  const queryFields: string[] = []

  for (const { form } of process.forms()) {
    const overrides = form.lookupOverrides()

    for (const [fieldName, override] of overrides) {
      if (!override.dependencies || override.dependencies.length === 0) {
        continue
      }

      const queryName = form.lookupQueryName(fieldName)
      const inputTypeName = `${queryName.charAt(0).toUpperCase() + queryName.slice(1)}Input`

      // Build input type fields: filter + required dependency fields
      const depFields = override.dependencies
        .map((dep) => `  ${dep}: String!`)
        .join("\n")

      inputTypes.push(
        `input ${inputTypeName} {\n  filter: String\n${depFields}\n}`,
      )

      const embedTag = form.embed ? ' @auth(tag: "embed")' : ""

      queryFields.push(
        `  ${queryName}(input: ${inputTypeName}!, limit: Int): [LookupItem!]!${embedTag}`,
      )
    }
  }

  return { inputTypes, queryFields }
}

/**
 * GraphQL type definition for the payload returned by start mutations.
 * On validation failure, the resolver throws a GraphQLError with structured
 * extensions containing field-level validation errors.
 */
const START_PROCESS_PAYLOAD_TYPE = `type StartProcessPayload {
  deduplicated: Boolean!
  executionId: ID!
  processId: ID!
  processPath: String!
  timestamp: DateTimeISO!
}`

/**
 * GraphQL type definition for the payload returned by complete mutations.
 * On validation failure, the resolver throws a GraphQLError with structured
 * extensions containing field-level validation errors.
 */
const COMPLETE_STEP_PAYLOAD_TYPE = `type CompleteStepPayload {
  executionId: ID!
  stepPath: String!
  timestamp: DateTimeISO!
}`

/**
 * Generates GraphQL input type definitions and mutations from all forms and processes in the organization
 */
export const buildDynamicSchema = (): Effect.Effect<
  string,
  InvalidProcessGraph | NoStartNodeError | InvalidListSchema,
  OrganisationProvider
> =>
  Effect.gen(function* () {
    // Get the organization from context
    const { organisation: org, customGraphqlSchema } =
      yield* OrganisationProvider

    // Collect all forms from the organization
    const forms = yield* collectFormsFromOrgUnit(org)

    // Generate input type definitions
    const generatedTypes = yield* Effect.forEach(forms, (form) =>
      generateInputType(form),
    )

    // Collect all auxiliary types and deduplicate by type definition
    const auxiliarySet = new Set<string>()
    const mainTypes: string[] = []

    for (const generated of generatedTypes) {
      mainTypes.push(generated.main)
      for (const aux of generated.auxiliary) {
        auxiliarySet.add(aux)
      }
    }

    // Collect all processes from the organization
    const processes = yield* collectProcessesFromOrgUnit(org)

    // Generate start mutations for each process
    const startMutationArrays = yield* Effect.forEach(processes, (process) =>
      generateMutationsForProcess(process),
    )

    // Generate complete mutations for each process
    const completeMutationArrays = yield* Effect.forEach(processes, (process) =>
      generateCompleteMutationsForProcess(process),
    )

    // Flatten mutation arrays into a single array
    const allMutations = [
      ...startMutationArrays.flat(),
      ...completeMutationArrays.flat(),
    ]

    // Generate per-lookup typed queries for dependent lookups
    const lookupInputTypes: string[] = []
    const lookupQueryFields: string[] = []

    for (const process of processes) {
      const { inputTypes, queryFields } =
        generateLookupQueriesForProcess(process)
      lookupInputTypes.push(...inputTypes)
      lookupQueryFields.push(...queryFields)
    }

    // Collect all lists from the organization
    const lists = yield* collectListsFromOrgUnit(org)

    // Generate schema parts for each list
    const listSchemas = yield* Effect.forEach(lists, (list) =>
      generateSchemaForList(list),
    )

    // Collect list types and queries
    const listOutputTypes: string[] = []
    const listQueries: string[] = []

    for (const listSchema of listSchemas) {
      // Add item type and its auxiliary types
      listOutputTypes.push(listSchema.itemTypes.main)
      for (const aux of listSchema.itemTypes.auxiliary) {
        listOutputTypes.push(aux)
      }
      // Add page type
      listOutputTypes.push(listSchema.pageType)
      // Add detail type and its auxiliary types if present
      if (listSchema.detailType) {
        listOutputTypes.push(listSchema.detailType.main)
        for (const aux of listSchema.detailType.auxiliary) {
          listOutputTypes.push(aux)
        }
      }
      if (listSchema.createInputType) {
        listOutputTypes.push(
          listSchema.createInputType.main,
          ...listSchema.createInputType.auxiliary,
        )
      }
      if (listSchema.createMutation)
        allMutations.push(listSchema.createMutation)
      // Add update input type and its auxiliary types if present
      if (listSchema.updateInputType) {
        listOutputTypes.push(listSchema.updateInputType.main)
        for (const aux of listSchema.updateInputType.auxiliary) {
          listOutputTypes.push(aux)
        }
      }
      // Add query
      listQueries.push(listSchema.query)
      // Add item query if present
      if (listSchema.itemQuery) {
        listQueries.push(listSchema.itemQuery)
      }
      // Add update mutation if present
      if (listSchema.updateMutation) {
        allMutations.push(listSchema.updateMutation)
      }
      // Add delete mutation if present
      if (listSchema.deleteMutation) {
        allMutations.push(listSchema.deleteMutation)
      }
    }

    // Build the final schema
    const schemaParts: string[] = []

    // Add the payload types
    schemaParts.push(START_PROCESS_PAYLOAD_TYPE)
    schemaParts.push(COMPLETE_STEP_PAYLOAD_TYPE)

    // Add auxiliary input types
    if (auxiliarySet.size > 0) {
      schemaParts.push(...auxiliarySet)
    }

    // Add main input types
    if (mainTypes.length > 0) {
      schemaParts.push(...mainTypes)
    }

    // Add lookup input types for dependent lookups
    if (lookupInputTypes.length > 0) {
      schemaParts.push(...lookupInputTypes)
    }

    // Add list output types
    if (listOutputTypes.length > 0) {
      schemaParts.push(...listOutputTypes)
    }

    // Add mutations block if there are any mutations
    if (allMutations.length > 0) {
      const mutationsBlock = `type Mutation {\n${allMutations.join("\n")}\n}`
      schemaParts.push(mutationsBlock)
    }

    // Combine list queries and lookup queries into a single Query block
    const allQueries = [...listQueries, ...lookupQueryFields]
    if (allQueries.length > 0) {
      const queriesBlock = `type Query {\n${allQueries.join("\n")}\n}`
      schemaParts.push(queriesBlock)
    }

    if (customGraphqlSchema?.typeDefs) {
      schemaParts.push(customGraphqlSchema.typeDefs)
    }

    // Join all parts with double newlines
    return schemaParts.join("\n\n")
  })
