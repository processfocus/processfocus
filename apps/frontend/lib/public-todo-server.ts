import "server-only"

import { getFrontendJwt } from "@pf/auth-session"
import type { CalendarSlotItem, FieldError, LookupSuggestion } from "@pf/form"
import { createServerGraphqlClient } from "@/lib/graphql/server-client"
import {
  getPublicTodoGraphqlErrors,
  isPublicTodoLinkError,
} from "@/lib/public-todo-graphql-errors"
import {
  type PublicTodoCompletionResult,
  type PublicTodoFormMetadata,
  type PublicTodoResult,
  parsePublicTodoFormDefinition,
} from "@/lib/public-todo-model"

export { isPublicTodoLinkError }

const PUBLIC_TODO_QUERY = `
  query PublicTodo($token: String!) {
    publicTodo(token: $token) {
      todoId
      status
      organisationName
      completionMessage
      formMetadata {
        stepPath
        processName
        publicFormTitle
        publicFormDescription
        formDefinition
        defaultValues
        jsonSchema
      }
    }
  }
`

const COMPLETE_PUBLIC_TODO_MUTATION = `
  mutation CompletePublicTodo($token: String!, $input: JSON) {
    completePublicTodo(token: $token, input: $input) {
      todoId
      status
      completionMessage
    }
  }
`

const PUBLIC_TODO_LOOKUP_QUERY = `
  query PublicTodoLookupSuggestions($token: String!, $field: String!, $filter: String, $limit: Int) {
    publicTodoLookupSuggestions(token: $token, field: $field, filter: $filter, limit: $limit) {
      value
      label
    }
  }
`

const PUBLIC_TODO_CALENDAR_SLOTS_QUERY = `
  query PublicTodoCalendarSlots($token: String!, $field: String!) {
    publicTodoCalendarSlots(token: $token, field: $field) {
      value
      label
      startsAt
      endsAt
    }
  }
`

const REQUEST_FRESH_PUBLIC_TODO_LINK_MUTATION = `
  mutation RequestFreshPublicTodoLink($token: String!) {
    requestFreshPublicTodoLink(token: $token) {
      todoId
      status
    }
  }
`

export class PublicTodoConfigurationError extends Error {
  constructor() {
    super("FRONTEND_JWT_TOKEN is not configured.")
  }
}

type PublicTodoWireResult = Omit<PublicTodoResult, "formMetadata"> & {
  readonly formMetadata:
    | (Omit<
        PublicTodoFormMetadata,
        "formDefinition" | "formDefinitionStatus"
      > & {
        readonly formDefinition: unknown
      })
    | null
}

const getPublicTodoClient = () => {
  const frontendJwt = getFrontendJwt()
  if (!frontendJwt) {
    throw new PublicTodoConfigurationError()
  }

  return createServerGraphqlClient(frontendJwt)
}

const isFieldError = (value: unknown): value is FieldError =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { readonly field?: unknown }).field === "string" &&
  typeof (value as { readonly message?: unknown }).message === "string"

export async function fetchPublicTodo(
  token: string,
): Promise<PublicTodoResult | null> {
  const client = getPublicTodoClient()
  const data = await client.request<{
    publicTodo: PublicTodoWireResult | null
  }>(PUBLIC_TODO_QUERY, { token })

  const todo = data.publicTodo
  if (!todo) return null
  if (!todo.formMetadata) return { ...todo, formMetadata: null }

  return {
    ...todo,
    formMetadata: {
      ...todo.formMetadata,
      ...parsePublicTodoFormDefinition(todo.formMetadata.formDefinition),
    },
  }
}

export async function completePublicTodo(
  token: string,
  input: Record<string, unknown>,
): Promise<PublicTodoCompletionResult> {
  const client = getPublicTodoClient()
  const data = await client.request<{
    completePublicTodo: PublicTodoCompletionResult
  }>(COMPLETE_PUBLIC_TODO_MUTATION, { token, input })

  return data.completePublicTodo
}

export async function publicTodoLookupSuggestions(
  token: string,
  field: string,
  filter: string | null,
  limit: number | null,
): Promise<LookupSuggestion[]> {
  const client = getPublicTodoClient()
  const data = await client.request<{
    publicTodoLookupSuggestions: LookupSuggestion[]
  }>(PUBLIC_TODO_LOOKUP_QUERY, { token, field, filter, limit })

  return data.publicTodoLookupSuggestions
}

export async function publicTodoCalendarSlots(
  token: string,
  field: string,
): Promise<CalendarSlotItem[]> {
  const client = getPublicTodoClient()
  const data = await client.request<{
    publicTodoCalendarSlots: CalendarSlotItem[]
  }>(PUBLIC_TODO_CALENDAR_SLOTS_QUERY, { token, field })

  return data.publicTodoCalendarSlots
}

export async function requestFreshPublicTodoLink(
  token: string,
): Promise<PublicTodoCompletionResult> {
  const client = getPublicTodoClient()
  const data = await client.request<{
    requestFreshPublicTodoLink: PublicTodoCompletionResult
  }>(REQUEST_FRESH_PUBLIC_TODO_LINK_MUTATION, { token })

  return data.requestFreshPublicTodoLink
}

export const publicTodoFieldErrorsFromGraphqlError = (
  error: unknown,
): FieldError[] | null => {
  const gqlError = getPublicTodoGraphqlErrors(error)?.[0]
  if (
    typeof gqlError !== "object" ||
    gqlError === null ||
    Array.isArray(gqlError)
  ) {
    return null
  }

  const extensions = (gqlError as { readonly extensions?: unknown }).extensions
  if (
    typeof extensions !== "object" ||
    extensions === null ||
    Array.isArray(extensions) ||
    (extensions as { readonly code?: unknown }).code !== "InputValidationError"
  ) {
    return null
  }

  const errors = (extensions as { readonly errors?: unknown }).errors
  if (!Array.isArray(errors)) {
    return null
  }

  return errors.every(isFieldError) ? errors : null
}
