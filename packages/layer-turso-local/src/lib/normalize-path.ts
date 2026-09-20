export { isLocalFilePath, normalizeDatabasePath } from "@pf/db-info"

export const toTursoDatabasePath = (path: string): string => {
  if (path.startsWith("file://")) {
    return path.slice("file://".length)
  }

  if (path.startsWith("file:")) {
    return path.slice("file:".length)
  }

  return path
}
