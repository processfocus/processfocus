export const stripTrailingSlash = (value: string): string =>
  value.replace(/\/$/, "")
