import { Data, Effect } from "effect"
import ts from "typescript"

class TypeScriptSyntaxError extends Data.TaggedError("TypeScriptSyntaxError")<{
  readonly code: string
  readonly errors: readonly string[]
}> {
  override get message() {
    const errorList = this.errors.map((err) => `  - ${err}`).join("\n")
    const lines = this.code.split("\n")
    const numberedCode = lines
      .map((line, index) => {
        const lineNumber = (index + 1).toString().padStart(3, " ")
        return `${lineNumber}: ${line}`
      })
      .join("\n")
    return `Generated TypeScript has syntax errors:\n${errorList}\n\nGenerated code:\n${numberedCode}`
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return this.message
  }
}

export const validateTypeScriptSyntax = (
  code: string,
): Effect.Effect<void, TypeScriptSyntaxError> =>
  Effect.gen(function* () {
    const sourceFile = ts.createSourceFile(
      "test.ts",
      code,
      ts.ScriptTarget.Latest,
      true,
    )

    const errors: string[] = []
    const lines = code.split("\n")

    const visit = (node: ts.Node) => {
      // Check if node has parse diagnostics (syntax errors)
      if (node.kind === ts.SyntaxKind.Unknown) {
        errors.push(`Syntax error at position ${node.pos}`)
      }
      ts.forEachChild(node, visit)
    }

    visit(sourceFile)

    // Get syntax diagnostics using a minimal program
    // Only check syntax, not semantic errors like missing modules
    const compilerHost = ts.createCompilerHost({
      noResolve: true, // Don't try to resolve imports
      skipLibCheck: true,
    })
    const originalGetSourceFile = compilerHost.getSourceFile
    compilerHost.getSourceFile = (fileName) => {
      if (fileName === "test.ts") {
        return sourceFile
      }
      return originalGetSourceFile.call(
        compilerHost,
        fileName,
        ts.ScriptTarget.Latest,
      )
    }

    const program = ts.createProgram(
      ["test.ts"],
      {
        noResolve: true,
        skipLibCheck: true,
      },
      compilerHost,
    )
    const diagnostics = ts.getPreEmitDiagnostics(program, sourceFile).filter(
      // Only include syntax errors, not semantic errors like module resolution
      (d) => d.code >= 1000 && d.code < 2000,
    )

    diagnostics.forEach((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        "\n",
      )
      const start = diagnostic.start ?? 0

      // Calculate line number from position
      let currentPos = 0
      let lineNumber = 1
      for (let i = 0; i < lines.length; i++) {
        const lineLength = (lines[i]?.length ?? 0) + 1 // +1 for newline
        if (currentPos + lineLength > start) {
          lineNumber = i + 1
          break
        }
        currentPos += lineLength
      }

      errors.push(`${message} (line ${lineNumber})`)
    })

    if (errors.length > 0) {
      return yield* new TypeScriptSyntaxError({ code, errors })
    }
  })
