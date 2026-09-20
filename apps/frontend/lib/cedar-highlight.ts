export type CedarTokenKind =
  | "comment"
  | "string"
  | "keyword"
  | "entity"
  | "text"

export interface CedarToken {
  readonly kind: CedarTokenKind
  readonly value: string
  readonly start: number
}

const KEYWORDS = new Set([
  "permit",
  "forbid",
  "when",
  "unless",
  "if",
  "then",
  "else",
  "in",
  "has",
  "like",
  "is",
  "principal",
  "action",
  "resource",
  "context",
  "namespace",
  "entity",
  "appliesTo",
  "contains",
  "containsAny",
  "isEmpty",
])

const isIdentStart = (char: string): boolean => /[A-Za-z_]/.test(char)
const isIdentPart = (char: string): boolean => /[A-Za-z0-9_]/.test(char)

export const tokenizeCedar = (source: string): CedarToken[] => {
  const tokens: CedarToken[] = []
  let index = 0

  const push = (kind: CedarTokenKind, value: string, start: number) => {
    if (value !== "") tokens.push({ kind, value, start })
  }

  while (index < source.length) {
    const char = source[index] ?? ""
    const next = source[index + 1] ?? ""

    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index)
      const stop = end === -1 ? source.length : end
      push("comment", source.slice(index, stop), index)
      index = stop
      continue
    }

    if (char === '"') {
      let cursor = index + 1
      while (cursor < source.length) {
        if (source[cursor] === "\\" && cursor + 1 < source.length) {
          cursor += 2
          continue
        }
        if (source[cursor] === '"') {
          cursor += 1
          break
        }
        cursor += 1
      }
      push("string", source.slice(index, cursor), index)
      index = cursor
      continue
    }

    if (isIdentStart(char)) {
      let cursor = index + 1
      while (cursor < source.length && isIdentPart(source[cursor] ?? "")) {
        cursor += 1
      }
      while (
        source[cursor] === ":" &&
        source[cursor + 1] === ":" &&
        isIdentStart(source[cursor + 2] ?? "")
      ) {
        cursor += 2
        while (cursor < source.length && isIdentPart(source[cursor] ?? "")) {
          cursor += 1
        }
      }
      const value = source.slice(index, cursor)
      if (value.includes("::")) push("entity", value, index)
      else if (KEYWORDS.has(value)) push("keyword", value, index)
      else push("text", value, index)
      index = cursor
      continue
    }

    let cursor = index + 1
    while (
      cursor < source.length &&
      source[cursor] !== "/" &&
      source[cursor] !== '"' &&
      !isIdentStart(source[cursor] ?? "")
    ) {
      cursor += 1
    }
    push("text", source.slice(index, cursor), index)
    index = cursor
  }

  return tokens
}
