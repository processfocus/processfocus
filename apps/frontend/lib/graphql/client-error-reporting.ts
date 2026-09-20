import { ClientError, type RequestDocument } from "graphql-request"
import type {
  FrontendClientPluginGraphqlRequestError,
  FrontendClientPluginRegistration,
} from "@/lib/frontend-client-plugin-registry"

interface ActiveFrontendClientPlugin {
  readonly config: unknown
  readonly registration: FrontendClientPluginRegistration
}

const MAX_GRAPHQL_ERROR_MESSAGE_LENGTH = 500
const GRAPHQL_REQUEST_FAILED_PREFIX = "GraphQL request failed for "
// These prefixes must stay in sync with buildGraphqlRequestException's
// sanitized message format for PostHog re-entry suppression.
const CURRENT_PROVIDER_USER_MESSAGE_PREFIX = `${GRAPHQL_REQUEST_FAILED_PREFIX}CurrentProviderUser: `
const CURRENT_PROVIDER_USER_HTTP_MESSAGE_PREFIX = `${GRAPHQL_REQUEST_FAILED_PREFIX}CurrentProviderUser with `

const truncate = (value: string) =>
  value.slice(0, MAX_GRAPHQL_ERROR_MESSAGE_LENGTH)

const isDocumentNodeLike = (
  value: unknown,
): value is Exclude<RequestDocument, string> =>
  typeof value === "object" && value !== null

interface GraphqlOperationDefinitionLike {
  readonly kind?: unknown
  readonly name?: {
    readonly value?: unknown
  }
}

interface GraphqlDocumentNodeLike {
  readonly definitions?: readonly GraphqlOperationDefinitionLike[]
  readonly loc?: {
    readonly source?: {
      readonly body?: string
    }
  }
}

const getAstOperationName = (
  document: GraphqlDocumentNodeLike,
): string | null => {
  const definition = document.definitions?.find(
    (candidate) => candidate.kind === "OperationDefinition",
  )
  const name = definition?.name?.value

  return typeof name === "string" && name.length > 0 ? name : null
}

export const extractGraphqlRequestDocument = (
  input: unknown,
): RequestDocument | null => {
  if (typeof input === "string") {
    return input
  }

  if (!isDocumentNodeLike(input)) {
    return null
  }

  if ("document" in input) {
    return extractGraphqlRequestDocument(input.document)
  }

  return input
}

const getGraphqlOperationName = (document: RequestDocument | null): string => {
  if (document === null) {
    return "anonymous"
  }

  if (isDocumentNodeLike(document)) {
    const operationName = getAstOperationName(
      document as GraphqlDocumentNodeLike,
    )

    if (operationName) {
      return operationName
    }
  }

  const text =
    typeof document === "string"
      ? document
      : "loc" in document && document.loc?.source.body
        ? document.loc.source.body
        : null

  if (text === null) {
    return "anonymous"
  }

  const match = text.match(/(?:query|mutation|subscription)\s+(\w+)/)

  return match?.[1] ?? text.slice(0, 50)
}

const getBrowserPathname = (): string | null => {
  if (typeof window === "undefined") {
    return null
  }

  return window.location.pathname
}

const getErrorMessage = (error: unknown): string | null => {
  if (!(error instanceof Error)) {
    return null
  }

  const message = error.message.trim()
  return message.length > 0 ? message : null
}

export const buildGraphqlRequestErrorDetails = (
  document: RequestDocument | null,
  error: unknown,
): FrontendClientPluginGraphqlRequestError => {
  const operationName = getGraphqlOperationName(document)

  if (!(error instanceof ClientError)) {
    return {
      operationName,
      pathname: getBrowserPathname(),
      responseStatus: null,
      graphqlErrors: [],
    }
  }

  return {
    operationName,
    pathname: getBrowserPathname(),
    responseStatus:
      typeof error.response.status === "number" ? error.response.status : null,
    graphqlErrors: (error.response.errors ?? []).map((graphqlError) => ({
      code:
        typeof graphqlError.extensions?.["code"] === "string"
          ? graphqlError.extensions["code"]
          : null,
      message: truncate(graphqlError.message),
      path: Array.isArray(graphqlError.path)
        ? graphqlError.path.join(".")
        : null,
    })),
  }
}

export const buildGraphqlRequestException = (
  details: FrontendClientPluginGraphqlRequestError,
  error: unknown,
): Error => {
  const firstGraphqlError = details.graphqlErrors[0]

  if (firstGraphqlError) {
    const responseStatus =
      details.responseStatus !== null && details.responseStatus >= 400
        ? ` with HTTP ${String(details.responseStatus)}`
        : ""

    return new Error(
      `GraphQL request failed for ${details.operationName}${responseStatus}: ${firstGraphqlError.message}`,
    )
  }

  if (details.responseStatus !== null) {
    return new Error(
      `GraphQL request failed for ${details.operationName} with HTTP ${String(details.responseStatus)}`,
    )
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    if (error.message.startsWith(GRAPHQL_REQUEST_FAILED_PREFIX)) {
      return new Error(truncate(error.message))
    }

    return new Error(
      `GraphQL request failed for ${details.operationName}: ${truncate(error.message)}`,
    )
  }

  return new Error(`GraphQL request failed for ${details.operationName}`)
}

const isExpectedCurrentProviderUserAuthFailure = (
  details: FrontendClientPluginGraphqlRequestError,
  error: unknown,
): boolean => {
  const errorMessage = getErrorMessage(error)
  const isCurrentProviderUser =
    details.operationName === "CurrentProviderUser" ||
    // PostHog can re-enter this path with the already-sanitized Error message
    // created by buildGraphqlRequestException above.
    errorMessage?.startsWith(CURRENT_PROVIDER_USER_MESSAGE_PREFIX) === true ||
    errorMessage?.startsWith(CURRENT_PROVIDER_USER_HTTP_MESSAGE_PREFIX) === true

  if (!isCurrentProviderUser) {
    return false
  }

  if (details.responseStatus === 401) {
    return true
  }

  if (
    details.graphqlErrors.some(
      (graphqlError) => graphqlError.message === "Unauthenticated",
    )
  ) {
    return true
  }

  if (errorMessage === null) {
    return false
  }

  if (
    / with HTTP 401(?::|$)/.test(errorMessage) ||
    errorMessage.endsWith(": Unauthenticated")
  ) {
    return true
  }

  const normalizedMessage = errorMessage.startsWith(
    CURRENT_PROVIDER_USER_MESSAGE_PREFIX,
  )
    ? errorMessage.slice(CURRENT_PROVIDER_USER_MESSAGE_PREFIX.length)
    : errorMessage

  return (
    normalizedMessage === "Failed to fetch" ||
    normalizedMessage === "NetworkError when attempting to fetch resource."
  )
}

export const reportGraphqlRequestError = (
  activePlugins: ReadonlyArray<ActiveFrontendClientPlugin>,
  document: RequestDocument | null,
  error: unknown,
): void => {
  if (activePlugins.length === 0) {
    return
  }

  const details = buildGraphqlRequestErrorDetails(document, error)

  if (isExpectedCurrentProviderUserAuthFailure(details, error)) {
    return
  }

  const exception = buildGraphqlRequestException(details, error)

  for (const plugin of activePlugins) {
    try {
      plugin.registration.captureGraphqlRequestError?.(
        plugin.config,
        exception,
        details,
      )
    } catch {
      // Telemetry plugins must not replace the original GraphQL failure.
    }
  }
}
