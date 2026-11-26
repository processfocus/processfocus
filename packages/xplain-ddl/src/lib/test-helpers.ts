import { Effect } from "effect"
import type { Program } from "./ast.js"
import { parse } from "./xplain-ddl.js"

// Helper to run parse and unwrap result
export const parseSource = async (source: string): Promise<Program> => {
  const result = await Effect.runPromise(Effect.result(parse(source)))
  if (result._tag === "Failure") {
    throw new Error(`Parse failed: ${JSON.stringify(result.failure)}`)
  }
  return result.success
}

// Helper to run parse and expect errors
export const parseSourceExpectingErrors = async (source: string) => {
  const result = await Effect.runPromise(Effect.result(parse(source)))
  return result
}
