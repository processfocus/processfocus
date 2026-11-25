import { Effect, Option, SchemaAST } from "effect"
import {
  type GraphQLArgument,
  type GraphQLField,
  type GraphQLInputField,
  type GraphQLResolveInfo,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isNonNullType,
  isObjectType,
  valueFromASTUntyped,
} from "graphql"
import {
  GraphQLField as AuthorizationField,
  AuthorizationService,
  ListRef,
} from "@pf/auth-policy"
import {
  FormDescription,
  FormLabel,
  FormLookupInput,
  FormPermission,
  fieldAnnotation,
  isFieldPermissionMetadata,
} from "@pf/form-schema"
import type { ListSchemaField } from "@pf/graphql-schema"
import {
  OrganisationProvider,
  normalizePath,
  resolveFormFieldDefaults,
} from "@pf/process"
import { buildPrincipal, filterAuthorizedProcessRows } from "./authorization"
import {
  canModifyListFieldForAnyRole,
  rolePathsForList,
} from "./list-field-authorization"
import { getSchemaAnnotationDeep, getSubmissionFields } from "./resolver-utils"
import { isProviderUserSession } from "./session-guards"
import type { UserContext } from "./types"

type SchemaField =
  | GraphQLArgument
  | GraphQLInputField
  | GraphQLField<unknown, unknown>

// Read the executable schema, including encoded scalar types and generated names.
// Clients need no introspection permission or browser artifact execution.
const describeField = (
  field: SchemaField,
  ancestors: ReadonlySet<string> = new Set(),
): ListSchemaField => {
  const named = getNamedType(field.type)
  const defaultInput = "default" in field ? field.default : undefined
  const defaultValue = defaultInput?.literal
    ? valueFromASTUntyped(defaultInput.literal)
    : defaultInput?.value
  return {
    name: field.name,
    lookup: false,
    type: String(field.type),
    description: field.description ?? null,
    required: isNonNullType(field.type) && defaultValue === undefined,
    hasDefault: defaultValue !== undefined,
    defaultValue: defaultValue ?? null,
    enumValues: isEnumType(named)
      ? named.getValues().map((value) => value.name)
      : [],
    fields:
      (isInputObjectType(named) || isObjectType(named)) &&
      !ancestors.has(named.name)
        ? Object.values(named.getFields()).map((child) =>
            describeField(child, new Set([...ancestors, named.name])),
          )
        : [],
  }
}

const unionMembers = (ast: SchemaAST.AST): readonly SchemaAST.AST[] =>
  ast._tag === "Union" ? ast.types.flatMap(unionMembers) : [ast]

// GraphQL represents literal choices as scalars, so retain authored schema facts.
const describeInput = (
  field: ListSchemaField,
  ast: SchemaAST.AST | undefined,
): ListSchemaField => {
  if (!ast) return field
  const encoded = SchemaAST.toEncoded(ast)
  const members = unionMembers(encoded)
  const array = members.find((member) => member._tag === "Arrays")
  const element = array?.rest[0]
  const values = (
    element ? unionMembers(SchemaAST.toEncoded(element)) : members
  ).filter((member) => !["Null", "Undefined", "Void"].includes(member._tag))
  const choices =
    values.length > 0 && values.every((member) => member._tag === "Literal")
      ? values.flatMap((member) =>
          member._tag === "Literal" ? [member.literal] : [],
        )
      : field.enumValues
  const object = members.find((member) => member._tag === "Objects")
  const nested = object ?? (element?._tag === "Objects" ? element : undefined)
  const description =
    fieldAnnotation(ast, FormDescription) ?? SchemaAST.resolveDescription(ast)
  const label =
    fieldAnnotation(ast, FormLabel) ??
    fieldAnnotation(ast, "title") ??
    SchemaAST.resolveTitle(ast)
  return {
    ...field,
    label: typeof label === "string" ? label : null,
    lookup: fieldAnnotation(ast, FormLookupInput) !== undefined,
    description:
      typeof description === "string"
        ? description
        : (field.description ?? null),
    enumValues: choices,
    fields: field.fields.map((child) =>
      describeInput(
        child,
        nested?.propertySignatures.find(
          (property) => property.name === child.name,
        )?.type,
      ),
    ),
  }
}

export const listMetadata = Effect.fn("listMetadata")(function* (
  _parent: unknown,
  args: { listPath: string },
  context: UserContext,
  info: GraphQLResolveInfo,
) {
  const { organisation } = yield* OrganisationProvider
  const list = organisation.listByPath(args.listPath)
  if (!list) return null
  const auth = yield* AuthorizationService
  const principal = yield* buildPrincipal(context)
  const path = normalizePath(list.node.path)
  const roles = rolePathsForList(list.roles)
  const resource = new ListRef(path, roles)
  if (!(yield* auth.canAccessList(principal, resource))) return null

  const operation = (name: string, mutation: boolean, permitted: boolean) =>
    Effect.gen(function* () {
      const field = (
        mutation ? info.schema.getMutationType() : info.schema.getQueryType()
      )?.getFields()[name]
      const authorized =
        permitted &&
        field !== undefined &&
        (yield* auth.canAccessField(
          principal,
          new AuthorizationField(`${mutation ? "Mutation" : "Query"}.${name}`),
          mutation ? "mutation" : "query",
        ))
      return {
        configured: field !== undefined,
        authorized: field !== undefined && authorized,
        name: field?.name ?? null,
        arguments:
          field && authorized
            ? field.args.map((arg) => describeField(arg))
            : [],
        result: field && authorized ? describeField(field) : null,
      }
    })
  const browse = yield* operation(list.queryName(), false, true)
  const detail = yield* operation(list.itemQueryName(), false, true)
  const create = yield* operation(
    list.createMutationName(),
    true,
    yield* auth.canCreateList(principal, resource),
  )
  const update = yield* operation(
    list.updateMutationName(),
    true,
    yield* auth.canUpdateList(principal, resource),
  )
  const deletion = yield* operation(
    list.deleteMutationName(),
    true,
    yield* auth.canDeleteList(principal, resource),
  )

  const currentProviderUser = isProviderUserSession(context.jwt?.properties)
    ? context.jwt.properties.email
    : undefined
  for (const [op, fields] of [
    [create, getSubmissionFields(list.createFormFields ?? {})],
    [update, getSubmissionFields(list.editableFormFields())],
  ] as const) {
    const input = op.arguments.find((arg) => arg.name === "input")
    if (!input) continue
    const visible: ListSchemaField[] = []
    for (const field of input.fields) {
      const source = fields[field.name]
      const permission = source
        ? getSchemaAnnotationDeep(source, FormPermission)
        : Option.none()
      if (
        Option.isSome(permission) &&
        isFieldPermissionMetadata(permission.value)
      ) {
        const allowed = yield* canModifyListFieldForAnyRole(context, {
          listPath: path,
          fieldName: field.name,
          rolePath: normalizePath(permission.value.modify.node.path),
          listRolePaths: roles,
          orgUnitId: list.orgUnit.node.path,
          logMessage: "List metadata field authorization failed",
        })
        if (!allowed) continue
      }
      const defaults = source
        ? yield* resolveFormFieldDefaults(
            { [field.name]: source },
            currentProviderUser,
          )
        : {}
      // Defaults initialize forms; they do not make required GraphQL inputs optional.
      visible.push({
        ...describeInput(field, source?.ast),
        hasDefault: Object.hasOwn(defaults, field.name) || field.hasDefault,
        defaultValue: Object.hasOwn(defaults, field.name)
          ? defaults[field.name]
          : field.defaultValue,
      })
    }
    input.fields = visible
  }
  const processStarts = [
    ...(list.startProcess ? [list.startProcess] : []),
    ...list.additionalStartProcesses,
  ]
  return {
    path,
    name: list.name,
    browse,
    detail,
    create,
    update,
    delete: deletion,
    configuredProcessStartCount: processStarts.length,
    authorizedProcessStarts: processStarts.length
      ? yield* filterAuthorizedProcessRows(context, processStarts)
      : [],
    sortableFields: list
      .outputColumns()
      .filter((column) => column.sortable)
      .map((column) => column.field),
  }
})
