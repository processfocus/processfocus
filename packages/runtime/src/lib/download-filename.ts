function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function asciiFallbackFilename(filename: string): string {
  const fallback = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]+/g, "")
    .replace(/\s+/g, " ")
    .trim()

  return fallback || "download"
}

export function hasInvalidDownloadFilename(filename: string): boolean {
  return filename.includes("\r") || filename.includes("\n")
}

export function sanitizeDownloadFilename(filename: string): string {
  const sanitized = filename
    .replaceAll("\\", "_")
    .replaceAll(":", "_")
    .replaceAll('"', "'")
    .replace(/[\r\n]+/g, " ")
    .trim()

  return sanitized || "download"
}

export function formatContentDisposition(filename: string): string {
  const sanitized = sanitizeDownloadFilename(filename)
  const fallback = asciiFallbackFilename(sanitized)

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987Value(sanitized)}`
}
