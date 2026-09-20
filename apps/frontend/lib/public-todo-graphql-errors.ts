export const getPublicTodoGraphqlErrors = (
  error: unknown,
): readonly unknown[] | null => {
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return null
  }

  const response = (error as { readonly response?: unknown }).response
  if (
    typeof response !== "object" ||
    response === null ||
    Array.isArray(response)
  ) {
    return null
  }

  const errors = (response as { readonly errors?: unknown }).errors
  return Array.isArray(errors) ? errors : null
}

const getGraphqlErrorCode = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return null
  }

  const extensions = (error as { readonly extensions?: unknown }).extensions
  if (
    typeof extensions !== "object" ||
    extensions === null ||
    Array.isArray(extensions)
  ) {
    return null
  }

  const code = (extensions as { readonly code?: unknown }).code
  return typeof code === "string" ? code : null
}

export const isPublicTodoLinkError = (error: unknown): boolean => {
  const codes =
    getPublicTodoGraphqlErrors(error)?.map(getGraphqlErrorCode) ?? []
  return codes.some(
    (code) => code === "PublicTodoTokenError" || code === "NotAuthorized",
  )
}
