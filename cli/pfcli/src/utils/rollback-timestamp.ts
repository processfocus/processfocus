const RFC3339_WITH_TIMEZONE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

const ISO_LOCAL_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/

const formatUtcTimestamp = (date: Date): string =>
  date.toISOString().replace(".000Z", "Z")

export const normalizeRollbackTimestamp = (timestamp: string): string => {
  if (
    RFC3339_WITH_TIMEZONE_PATTERN.test(timestamp) &&
    timestamp.endsWith("Z")
  ) {
    return timestamp
  }

  if (
    !RFC3339_WITH_TIMEZONE_PATTERN.test(timestamp) &&
    !ISO_LOCAL_DATETIME_PATTERN.test(timestamp)
  ) {
    return timestamp
  }

  const parsedTimestamp = new Date(timestamp)
  if (Number.isNaN(parsedTimestamp.getTime())) {
    return timestamp
  }

  return formatUtcTimestamp(parsedTimestamp)
}
