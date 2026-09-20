export const formatStructuredLogLine = (
  message: string,
  attributes: Record<string, unknown> = {},
): string => JSON.stringify({ message, ...attributes })
