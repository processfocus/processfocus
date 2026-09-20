const formatLocalExecutionTimestamp = (now = Date.now()): string => {
  const date = new Date(now)

  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`
}

export const formatExecutionLogMessage = (
  message: string,
  now = Date.now(),
): string => `[${formatLocalExecutionTimestamp(now)}] ${message}`
