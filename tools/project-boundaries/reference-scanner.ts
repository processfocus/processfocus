export interface ReferenceFile {
  readonly path: string
  readonly content: string
}

export const isNonGraphDependencyFile = (path: string): boolean =>
  !/(^|\/)(?:test|tests|generated)(?:\/|$)|\.(?:spec|test)\.[cm]?[jt]sx?$/.test(
    path,
  ) &&
  (/(^|\/)(?:Dockerfile(?:\.[^/]*)?|docker-compose\.ya?ml|package\.json|project\.json|tsconfig(?:\.[^/]*)?\.json)$/.test(
    path,
  ) ||
    /(?:\.[cm]?[jt]sx?|\.css|\.sh)$/.test(path))

export const withoutComments = (content: string): string => {
  let result = ""
  let quote: '"' | "'" | "`" | undefined
  let escaped = false

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    const nextCharacter = content[index + 1]

    if (quote) {
      result += character
      if (escaped) {
        escaped = false
      } else if (character === "\\") {
        escaped = true
      } else if (character === quote) {
        quote = undefined
      }
      continue
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character
      result += character
      continue
    }
    if (character === "/" && nextCharacter === "/") {
      while (index < content.length && content[index] !== "\n") index += 1
      result += "\n"
      continue
    }
    if (character === "/" && nextCharacter === "*") {
      index += 2
      while (
        index < content.length &&
        !(content[index] === "*" && content[index + 1] === "/")
      ) {
        if (content[index] === "\n") result += "\n"
        index += 1
      }
      index += 1
      continue
    }
    result += character
  }

  return result.replace(/^\s*#.*$/gm, "")
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const hasPackageReference = (
  content: string,
  packageName: string,
): boolean => {
  const escapedName = escapeRegExp(packageName)
  return [
    new RegExp(
      String.raw`(?:from\s*|import\s*|import\(\s*|require\(\s*)["'\x60]${escapedName}(?:\/|["'\x60])`,
    ),
    new RegExp(String.raw`["']${escapedName}["']\s*:`),
    new RegExp(String.raw`node_modules\/${escapedName}(?:\/|["'])`),
    new RegExp(
      String.raw`(?:bun|node|nx|npm|pnpm|yarn)[^\n"']*\s${escapedName}(?:\/|\s|$)`,
    ),
  ].some((pattern) => pattern.test(content))
}
