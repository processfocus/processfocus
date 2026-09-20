export const normalizeDatabasePath = (path: string): string =>
  /^[a-z]+:/.test(path) ? path : `file://${path}`

export const isLocalFilePath = (path: string): boolean => {
  const protocol = path.match(/^([a-z]+):/)?.[1]
  return protocol === undefined || protocol === "file"
}
