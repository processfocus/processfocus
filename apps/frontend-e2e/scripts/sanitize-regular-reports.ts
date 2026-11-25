/** Keep local failure diagnostics without credentials or captured process output. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { JSDOM } from "jsdom"

function readUtf8(path: string): string {
  // Reject malformed bytes before redaction, as Python's strict decoder did.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    readFileSync(path),
  )
}

// Python Unicode whitespace is White_Space plus these four ASCII separators.
const pythonWhitespace = `[\\p{White_Space}${String.fromCodePoint(0x1c)}-${String.fromCodePoint(0x1f)}]`
const authorization = new RegExp(
  String.raw`\b(Bearer|Bas[iİı]c)${pythonWhitespace}+[A-Za-zİı0-9._~+/=-]+`,
  "giu",
)
const credentialLine = new RegExp(
  String.raw`(^|\n)[^\n]*(?:set-cook[iİı]e|cook[iİı]e|access_token|refresh_token)${pythonWhitespace}*[:=][^\n]*(?=\n|$)`,
  "giu",
)

function redact(text: string): string {
  return (
    text
      .replace(authorization, "$1 [REDACTED]")
      .replace(
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
        "[REDACTED]",
      )
      // Python's multiline anchors and dot split only at LF, not U+2028/U+2029.
      // Its Unicode whitespace also includes U+001C–U+001F; Unicode ignore-case
      // includes dotted/dotless I in addition to JavaScript's Unicode folds.
      .replace(credentialLine, "$1[REDACTED]")
  )
}

const directory = process.argv[2]
if (!directory) throw new Error("Report directory is required")
// XML mode rejects malformed documents, rather than recovering as HTML.
const xmlBytes = readFileSync(join(directory, "regular.xml"))
// XML supports UTF-16 in either byte order, identified by its BOM or "<" prefix.
const xmlEncoding =
  (xmlBytes[0] === 0xff && xmlBytes[1] === 0xfe) ||
  (xmlBytes[0] === 0x3c && xmlBytes[1] === 0)
    ? "utf-16le"
    : (xmlBytes[0] === 0xfe && xmlBytes[1] === 0xff) ||
        (xmlBytes[0] === 0 && xmlBytes[1] === 0x3c)
      ? "utf-16be"
      : "utf-8"
const dom = new JSDOM(
  new TextDecoder(xmlEncoding, { fatal: true }).decode(xmlBytes),
  {
    contentType: "text/xml",
  },
)
try {
  const document = dom.window.document
  function sanitize(parent: Node): void {
    // Match ElementTree's text model before redaction: CDATA is ordinary text,
    // and comments/PIs do not split a credential into separate text nodes.
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === dom.window.Node.CDATA_SECTION_NODE) {
        parent.replaceChild(
          document.createTextNode(child.textContent ?? ""),
          child,
        )
      } else if (
        child.nodeType !== dom.window.Node.ELEMENT_NODE &&
        child.nodeType !== dom.window.Node.TEXT_NODE
      ) {
        parent.removeChild(child)
      }
    }
    parent.normalize()
    for (const child of Array.from(parent.childNodes)) {
      if (child instanceof dom.window.Element) {
        if (
          ["system-out", "system-err", "properties"].includes(child.tagName)
        ) {
          // ElementTree removes the element's tail along with the element.
          if (child.nextSibling?.nodeType === dom.window.Node.TEXT_NODE) {
            parent.removeChild(child.nextSibling)
          }
          parent.removeChild(child)
          continue
        }
        for (const attr of Array.from(child.attributes))
          attr.value = redact(attr.value)
        sanitize(child)
      } else if (child.nodeType === dom.window.Node.TEXT_NODE) {
        child.textContent = redact(child.textContent ?? "")
      }
    }
  }
  sanitize(document)
  writeFileSync(
    join(directory, "regular-safe.xml"),
    `<?xml version='1.0' encoding='utf-8'?>\n${dom.serialize()}`,
  )
} finally {
  dom.window.close()
}
const output = join(directory, "regular-output")
for (const path of existsSync(output)
  ? new Bun.Glob("**/error-context.md").scanSync({
      cwd: output,
      absolute: true,
      onlyFiles: true,
      dot: true,
    })
  : []) {
  const safe = join(directory, "regular-safe-output", relative(output, path))
  mkdirSync(dirname(safe), { recursive: true })
  writeFileSync(safe, redact(readUtf8(path)))
}
