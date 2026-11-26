const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
export const publicTodoDefaultValues = (
  defaultValues: unknown,
): Record<string, unknown> | null =>
  isRecord(defaultValues) ? defaultValues : null
