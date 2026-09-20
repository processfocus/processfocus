import { FileSystem } from "@effect/platform"
import { Effect, Either, Option, Schema } from "effect"
import type { GraphQLResolveInfo } from "graphql"
import { FormPermission, isFieldPermissionMetadata } from "@pf/form-schema"
import { submissionSchemaSync } from "@pf/form-submission-schema"
import {
  ProcessQueries,
  type ProcessState,
  StepCompletionOperations,
} from "@pf/graphql-db-operations"
import {
  InputValidationError,
  MissingGeneratedSchemaError,
  NotAuthorized,
} from "@pf/graphql-schema"
import {
  type Form,
  type FormStepMeta,
  type List,
  type ListQueryContext,
  type ListSortInput,
  OrganisationProvider,
  type StepMeta,
  normalizePath,
  pathToPascalCase,
} from "@pf/process"
import {
  checkListAuthorization,
  checkListCreateAuthorization,
  checkListDeleteAuthorization,
  checkListUpdateAuthorization,
  checkScheduleModeAuthorization,
  checkStepAuthorization,
  checkTodoAuthorization,
} from "./authorization"
import { createPaginatedCollectionResolver } from "./collection-resolvers"
import { DynamicSchemaConfig } from "./graphql-api"
import {
  canModifyListFieldForAnyRole,
  rolePathsForList,
} from "./list-field-authorization"
import {
  checkProviderUserTargetFields,
  completeStep,
  startProcess,
  startProcessExecution,
} from "./process-operations"
import {
  deepMerge,
  extractValidationErrors,
  getSchemaAnnotationDeep,
  getSubmissionFields,
} from "./resolver-utils"
import { processStartTriggerForSession } from "./session-guards"
import type { UserContext } from "./types"

/**
 * Creates a start mutation resolver with proper closure and input validation.
 * Authorization check first, then delegates to startProcess for validation + execution.
 */
const createStartMutationResolver = (
  processId: string,
  processPath: string,
  startStepPath: string,
  step: Form<
    Record<string, unknown>,
    Record<string, StepMeta | FormStepMeta>,
    // biome-ignore lint/suspicious/noExplicitAny: Form generics erased at runtime
    any,
    string
  >,
  inputSchema: Schema.Schema.Any,
) => {
  return (
    _parent: unknown,
    args: {
      input: ProcessState
      executionId?: string | null
      withoutWaiting?: boolean | null
    },
    context: UserContext,
    _info: GraphQLResolveInfo,
  ) =>
    Effect.gen(function* () {
      const completingRolePath = yield* checkStepAuthorization(
        context,
        startStepPath,
      )
      const withoutWaiting = args.withoutWaiting ?? false
      yield* checkScheduleModeAuthorization(
        context,
        processPath,
        withoutWaiting,
      )
      const startOptions = {
        withoutWaiting,
        ...(args.executionId == null ? {} : { executionId: args.executionId }),
        ...(completingRolePath ? { completingRolePath } : {}),
      }

      return yield* startProcess(
        processId,
        processPath,
        startStepPath,
        args.input,
        inputSchema,
        step,
        context,
        startOptions,
      )
    })
}

/**
 * Creates a start mutation resolver for processes without input.
 * Authorization check first, then delegates to startProcessExecution.
 */
const createStartMutationResolverNoInput = (
  processId: string,
  processPath: string,
  startStepPath: string,
  options?: {
    readonly enqueueStartSystemStep?: boolean
  },
) => {
  return (
    _parent: unknown,
    args: { executionId?: string | null; withoutWaiting?: boolean | null },
    context: UserContext,
    _info: GraphQLResolveInfo,
  ) =>
    Effect.gen(function* () {
      const completingRolePath = yield* checkStepAuthorization(
        context,
        startStepPath,
      )
      const withoutWaiting = args.withoutWaiting ?? false
      yield* checkScheduleModeAuthorization(
        context,
        processPath,
        withoutWaiting,
      )
      const startOptions = {
        withoutWaiting,
        trigger: processStartTriggerForSession(context.jwt?.properties),
        ...(options ?? {}),
        ...(args.executionId == null ? {} : { executionId: args.executionId }),
        ...(completingRolePath ? { completingRolePath } : {}),
      }

      return yield* startProcessExecution(
        processId,
        processPath,
        startStepPath,
        {},
        startOptions,
      )
    })
}

/**
 * Creates a complete mutation resolver.
 * Authorization check first, then delegates to completeStep for validation + execution.
 */
export const createCompleteMutationResolver = (
  step: Form<
    Record<string, unknown>,
    Record<string, StepMeta | FormStepMeta>,
    // biome-ignore lint/suspicious/noExplicitAny: Form generics erased at runtime
    any,
    string
  >,
  inputSchema?: Schema.Schema.Any,
) => {
  return (
    _parent: unknown,
    args: { todoId: string; input?: ProcessState },
    context: UserContext,
    _info: GraphQLResolveInfo,
  ): Effect.Effect<
    Effect.Effect.Success<ReturnType<typeof completeStep>>,
    Effect.Effect.Error<
      | ReturnType<typeof completeStep>
      | ReturnType<typeof checkTodoAuthorization>
    >,
    Effect.Effect.Context<
      | ReturnType<typeof completeStep>
      | ReturnType<typeof checkTodoAuthorization>
    >
  > =>
    Effect.gen(function* () {
      const stepCompletionOps = yield* StepCompletionOperations
      const todo = yield* stepCompletionOps.queryTodoForCompletionById(
        args.todoId,
      )
      if (!todo) {
        return yield* new NotAuthorized({
          action: "complete",
          resource: args.todoId,
          message: "Not authorized to complete step",
        })
      }
      // Correction-required Todos remain active, but the normal completion route
      // cannot update recipient data. Keep it blocked until correction handling
      // gets its own submission mutation.
      if (todo.correctionRequiredAt !== null) {
        return yield* new NotAuthorized({
          action: "complete",
          resource: args.todoId,
          message: "Correction required todos must use correction handling",
        })
      }
      const completingRolePath = yield* checkTodoAuthorization(context, todo)
      return yield* completeStep(
        args.todoId,
        args.input ?? {},
        step,
        inputSchema,
        context,
        {
          ...(completingRolePath ? { completingRolePath } : {}),
        },
      )
    })
}

/**
 * Creates a complete mutation resolver for steps without input.
 */
const createCompleteMutationResolverNoInput = (
  step: Form<
    Record<string, unknown>,
    Record<string, StepMeta | FormStepMeta>,
    Schema.Struct.Fields,
    string
  >,
) => {
  return createCompleteMutationResolver(step, undefined)
}

/**
 * Type alias for list queries
 */
// biome-ignore lint/suspicious/noExplicitAny: List generics erased at runtime
type AnyList = List<any, any, any, any, any, any>

const validateListSortInput = (
  sortableFields: ReadonlySet<string>,
  sort: ListSortInput | undefined,
): Effect.Effect<ListSortInput | undefined, InputValidationError> => {
  if (sort === undefined) {
    return Effect.succeed(undefined)
  }

  if (!sortableFields.has(sort.field)) {
    return Effect.fail(
      new InputValidationError({
        errors: [
          {
            field: "sort.field",
            message: `Unsupported list sort field "${sort.field}".`,
          },
        ],
      }),
    )
  }

  return Effect.succeed(sort)
}

/**
 * Creates a query resolver for a List.
 * Validates pagination params, checks authorization, executes the list query.
 */
const createListQueryResolver = (list: AnyList) => {
  const listPath = normalizePath(list.node.path)
  const rolePaths = rolePathsForList(list.roles)
  const sortableFields = new Set(
    list
      .outputColumns()
      .filter((column) => column.sortable)
      .map((column) => column.field),
  )

  return createPaginatedCollectionResolver(
    (
      args: {
        page: number
        limit: number
        filter?: string
        sort?: ListSortInput
      },
      pagination,
      context,
    ) =>
      Effect.gen(function* () {
        // Authorize before sort validation so inaccessible lists do not leak field metadata.
        yield* checkListAuthorization(context, listPath, rolePaths)
        const sort = yield* validateListSortInput(sortableFields, args.sort)

        // Build query context
        const queryContext = {
          page: pagination.page,
          limit: pagination.limit,
          ...(args.filter !== undefined ? { filter: args.filter } : {}),
          ...(sort !== undefined ? { sort } : {}),
        } satisfies ListQueryContext

        // Execute the list query
        return yield* list.executeQuery(queryContext)
      }),
  )
}

/**
 * Creates a query resolver for fetching a single list item by ID.
 * Checks authorization, then executes the list's item query.
 */
const createListItemQueryResolver = (list: AnyList) => {
  const listPath = normalizePath(list.node.path)
  const rolePaths = rolePathsForList(list.roles)
  const controls = list.itemQueryControls()

  return (
    _parent: unknown,
    args: { id: string } & Record<string, unknown>,
    context: UserContext,
    _info: GraphQLResolveInfo,
  ) =>
    Effect.gen(function* () {
      // Check authorization (same as list query)
      yield* checkListAuthorization(context, listPath, rolePaths)

      // Execute the item query
      // The error case (no itemQuery defined) shouldn't happen since we only
      // register this resolver when list.hasForm is true, but handle it gracefully
      for (const control of controls) {
        const value = args[control.name]
        if (
          typeof value === "string" &&
          !control.options.some((option) => option.value === value)
        ) {
          return yield* new InputValidationError({
            errors: [
              {
                field: control.name,
                message: `Unsupported value "${value}".`,
              },
            ],
          })
        }
      }

      const selectedControls = Object.fromEntries(
        controls.flatMap((control) => {
          const value = args[control.name]
          return typeof value === "string" ? [[control.name, value]] : []
        }),
      )

      return yield* list
        .executeItemQuery(args.id, { controls: selectedControls })
        .pipe(
          Effect.catchTag("ListItemQueryNotDefinedError", () =>
            Effect.succeed(null),
          ),
        )
    })
}

const checkListFieldPermissions = (
  list: AnyList,
  input: Record<string, unknown>,
  fields: Schema.Struct.Fields,
  context: UserContext,
) =>
  Effect.gen(function* () {
    const listPath = normalizePath(list.node.path)
    const rolePaths = rolePathsForList(list.roles)

    // Callers pass submission fields, so permissions are checked only for
    // editable form inputs and not auxiliary wrapper fields.
    for (const [fieldName, fieldSchema] of Object.entries(fields)) {
      if (!Object.hasOwn(input, fieldName)) continue

      const permission = getSchemaAnnotationDeep(
        fieldSchema as Schema.Schema.Any,
        FormPermission,
      )
      if (!Option.isSome(permission)) continue
      if (!isFieldPermissionMetadata(permission.value)) continue

      const allowed = yield* canModifyListFieldForAnyRole(context, {
        listPath,
        fieldName,
        rolePath: normalizePath(permission.value.modify.node.path),
        listRolePaths: rolePaths,
        orgUnitId: list.orgUnit.node.path,
        logMessage: "List field authorization check failed",
      })

      if (!allowed) {
        return yield* new NotAuthorized({
          action: "modifyField",
          resource: `${listPath}/${fieldName}`,
          message: `User is not authorized to modify field ${fieldName}`,
        })
      }
    }
  })

/**
 * Creates a record only after List and field authorization and authoritative schema validation.
 */
const createListCreateMutationResolver =
  (list: AnyList, inputSchema: Schema.Schema<Record<string, unknown>>) =>
  (
    _parent: unknown,
    args: { input: Record<string, unknown> },
    context: UserContext,
  ) =>
    Effect.gen(function* () {
      const listPath = normalizePath(list.node.path)
      const roles = rolePathsForList(list.roles)
      yield* checkListAuthorization(context, listPath, roles)
      yield* checkListCreateAuthorization(context, listPath, roles)
      const result = Schema.decodeUnknownEither(inputSchema, {
        errors: "all",
        onExcessProperty: "error",
      })(args.input)
      if (Either.isLeft(result))
        return yield* new InputValidationError({
          errors: extractValidationErrors(result.left),
        })
      const input = result.right
      const fields = getSubmissionFields(list.createFormFields ?? {})
      yield* checkListFieldPermissions(list, input, fields, context)
      yield* checkProviderUserTargetFields(context, input, fields)
      return yield* list.executeCreate(input).pipe(
        Effect.catchTag("ListCreateError", (error) =>
          Effect.fail(
            new InputValidationError({
              errors: [{ field: error.field, message: error.message }],
            }),
          ),
        ),
      )
    })

const createListUpdateMutationResolver = (
  list: AnyList,
  inputSchema: Schema.Schema<unknown, unknown, never>,
) => {
  const listPath = normalizePath(list.node.path)
  const rolePaths = rolePathsForList(list.roles)

  return (
    _parent: unknown,
    args: { id: string; input: Record<string, unknown> },
    context: UserContext,
    _info: GraphQLResolveInfo,
  ) =>
    Effect.gen(function* () {
      // Check authorization
      yield* checkListUpdateAuthorization(context, listPath, rolePaths)

      const submissionFields = getSubmissionFields(list.editableFormFields())
      const validationInput = {
        ...Object.fromEntries(
          Object.keys(submissionFields).map((field) => [field, null]),
        ),
        ...args.input,
      }

      // Validate input against the Effect Schema, collecting all errors.
      // Nullable omitted fields validate as null, but only provided fields are
      // authorized and passed to the list update implementation.
      const validationResult = Schema.decodeUnknownEither(inputSchema, {
        errors: "all",
      })(validationInput)

      if (Either.isLeft(validationResult)) {
        const errors = extractValidationErrors(validationResult.left)
        return yield* new InputValidationError({ errors })
      }

      const validatedInput = validationResult.right as Record<string, unknown>
      const providedInput = Object.fromEntries(
        Object.keys(args.input).map((field) => [field, validatedInput[field]]),
      )
      yield* checkListFieldPermissions(
        list,
        providedInput,
        submissionFields,
        context,
      )
      yield* checkProviderUserTargetFields(
        context,
        providedInput,
        submissionFields,
      )

      // Execute the update
      return yield* list.executeUpdate(args.id, providedInput).pipe(
        Effect.catchTag("ListItemUpdateNotDefinedError", () =>
          Effect.succeed(null),
        ),
        Effect.catchTag("ListUpdateValidationError", (e) =>
          Effect.fail(
            new InputValidationError({
              errors: [{ field: e.field, message: e.message }],
            }),
          ),
        ),
      )
    })
}

/**
 * Creates a mutation resolver for deleting a single list item.
 * Checks authorization, then executes the list's delete function.
 */
const createListDeleteMutationResolver = (list: AnyList) => {
  const listPath = normalizePath(list.node.path)
  const rolePaths = rolePathsForList(list.roles)

  return (
    _parent: unknown,
    args: { id: string },
    context: UserContext,
    _info: GraphQLResolveInfo,
  ) =>
    Effect.gen(function* () {
      // Check authorization
      yield* checkListDeleteAuthorization(context, listPath, rolePaths)

      // Execute the delete
      // Note: ListItemDeleteNotDefinedError should be unreachable here since
      // this resolver is only registered when list.hasDelete is true. The
      // catch is kept as a defensive fallback in case of race conditions
      // or future code changes.
      yield* list
        .executeDelete(args.id)
        .pipe(
          Effect.catchTag("ListItemDeleteNotDefinedError", () => Effect.void),
        )

      return true
    })
}

/**
 * Creates a query resolver for a dependent lookup field.
 * Extracts filter, limit, and dependency values from args.input,
 * checks step authorization, then delegates to form.executeLookup.
 */
const createLookupQueryResolver = (
  form: Form<
    Record<string, unknown>,
    Record<string, StepMeta | FormStepMeta>,
    Schema.Struct.Fields
  >,
  fieldName: string,
  dependencies: ReadonlyArray<string>,
) => {
  const stepPath = normalizePath(form.node.path)

  return (
    _parent: unknown,
    args: { input: Record<string, string>; limit?: number | null },
    context: UserContext,
    _info: GraphQLResolveInfo,
  ) =>
    Effect.gen(function* () {
      yield* checkStepAuthorization(context, stepPath)

      const filter = args.input["filter"] ?? ""
      const limit = Math.min(args.limit ?? 20, 100)

      // Extract dependency values from input
      const deps: Record<string, string | undefined> = {}
      for (const dep of dependencies) {
        deps[dep] = args.input[dep]
      }

      return yield* form.executeLookup(fieldName, filter, limit, deps)
    })
}

export const dynamicSchema = Effect.gen(function* () {
  // Load static schema from file
  const fs = yield* FileSystem.FileSystem
  const config = yield* DynamicSchemaConfig
  const schemaPath = config.schemaPath

  // Check if file exists
  const fileExists = yield* fs.exists(schemaPath)
  if (!fileExists) {
    return yield* new MissingGeneratedSchemaError({
      path: schemaPath,
    })
  }

  // Read the schema file
  const dynamicTypeDefs = yield* fs.readFileString(schemaPath)

  // Get the services needed for mutation resolvers
  const processQueries = yield* ProcessQueries
  const { organisation: org, customGraphqlSchema } = yield* OrganisationProvider

  // Collect all processes from the organization to build mutation mapping
  const allProcesses = org.processes()

  // Build mapping from process path to processId by querying all processes
  const dbProcesses = yield* processQueries.queryAllProcesses
  const processPathToId = new Map<string, string>(
    dbProcesses.map((p) => [p.path, p.id]),
  )

  // Build dynamic mutation resolvers
  // biome-ignore lint/suspicious/noExplicitAny: legacy code
  const mutationResolvers: Record<string, any> = {}

  for (const process of allProcesses) {
    const startMutationName = process.startMutationName()
    // Normalize process path for DB lookup (DB stores paths with leading slash)
    const processPath = normalizePath(process.node.path)
    const processId = processPathToId.get(processPath)

    if (!processId) {
      yield* Effect.logWarning(
        `Process ${processPath} not found in database, skipping mutation resolvers`,
      )
      continue
    }

    // Find the start node to check if it has input
    const startNodes = process.startNodes()

    const startNode = startNodes[0]
    if (startNodes.length !== 1 || !startNode) {
      yield* Effect.logWarning(
        `Process ${processPath} has ${startNodes.length} start nodes, skipping mutation resolvers`,
      )
      continue
    }

    // Normalize start step path for DB storage
    const startStepPath = normalizePath(startNode.node.path)

    // Generate start mutation resolver.
    // Only Form start nodes accept user input. System steps may have output
    // fields, but those are produced by the worker rather than supplied by
    // the caller. Zero-field forms intentionally share the no-input path.
    const hasStartInput =
      startNode.isForm && Object.keys(startNode.output ?? {}).length > 0
    const startSchema = hasStartInput
      ? startNode.submissionEffectSchema
      : undefined
    if (startSchema) {
      // Has output schema: create start mutation with validation
      mutationResolvers[startMutationName] = createStartMutationResolver(
        processId,
        processPath,
        startStepPath,
        startNode as Form<
          Record<string, unknown>,
          Record<string, StepMeta | FormStepMeta>,
          // biome-ignore lint/suspicious/noExplicitAny: Form generics erased at runtime
          any,
          string
        >,
        startSchema,
      )
    } else {
      // No input: create start mutation
      mutationResolvers[startMutationName] = createStartMutationResolverNoInput(
        processId,
        processPath,
        startStepPath,
        { enqueueStartSystemStep: startNode.isSystemStep },
      )
    }

    // Generate complete mutation resolvers for all Form steps in this process
    for (const { form, path: stepPath } of process.forms()) {
      const mutationName = `complete${pathToPascalCase(stepPath)}`

      // Use submissionEffectSchema (flat, excludes read-only/structural)
      // for server-side validation instead of the wrapped outputSchema.
      const completeSchema = form.submissionEffectSchema
      if (completeSchema) {
        mutationResolvers[mutationName] = createCompleteMutationResolver(
          form,
          completeSchema,
        )
      } else {
        mutationResolvers[mutationName] =
          createCompleteMutationResolverNoInput(form)
      }
    }
  }

  // Build dynamic query resolvers for lists
  // biome-ignore lint/suspicious/noExplicitAny: legacy code
  const queryResolvers: Record<string, any> = {}

  // Get all lists from the organization
  const allLists = org.lists()

  for (const list of allLists) {
    const queryName = list.queryName()
    queryResolvers[queryName] = createListQueryResolver(list)

    // Register item query resolver if list has a form (detail view)
    if (list.hasForm) {
      const itemQueryName = list.itemQueryName()
      queryResolvers[itemQueryName] = createListItemQueryResolver(list)
    }

    const createSchema = list.createSubmissionSchema()
    if (createSchema) {
      mutationResolvers[list.createMutationName()] =
        createListCreateMutationResolver(
          list,
          Schema.make<Record<string, unknown>>(createSchema.ast),
        )
    }

    // Register update mutation resolver if list has update and form fields
    if (list.hasUpdate && list.formFields) {
      const inputSchema = Schema.Struct(list.editableFormFields())
      // Sync boundary: avoid expanding AppSchemaBuilder's typed error channel.
      // Rethrows the original TaggedError on authoring-time flatten failures.
      const submission = submissionSchemaSync(inputSchema)
      const updateMutationName = list.updateMutationName()
      mutationResolvers[updateMutationName] = createListUpdateMutationResolver(
        list,
        submission as unknown as Schema.Schema<unknown, unknown, never>,
      )
    }

    // Register delete mutation resolver if list has delete
    if (list.hasDelete) {
      const deleteMutationName = list.deleteMutationName()
      mutationResolvers[deleteMutationName] =
        createListDeleteMutationResolver(list)
    }
  }

  // Register lookup query resolvers for dependent lookups
  for (const process of allProcesses) {
    for (const { form } of process.forms()) {
      const overrides = form.lookupOverrides()

      for (const [fieldName, override] of overrides) {
        if (!override.dependencies || override.dependencies.length === 0) {
          continue
        }

        const queryName = form.lookupQueryName(fieldName)
        queryResolvers[queryName] = createLookupQueryResolver(
          form,
          fieldName,
          override.dependencies,
        )
      }
    }
  }

  return {
    typeDefs: dynamicTypeDefs,
    resolvers: deepMerge(
      {
        Mutation: mutationResolvers,
        ...(Object.keys(queryResolvers).length > 0 && {
          Query: queryResolvers,
        }),
      },
      customGraphqlSchema?.resolvers ?? {},
    ),
  }
})
