import { writeFileSync } from "node:fs"
import { Effect } from "effect"
import { CliError } from "../errors"

/** Optional local write-ahead marker for automation. A missing marker after the
 * CLI has exited proves failure preceded the start request; a present marker
 * requires authoritative Backend reconciliation. Contains no credentials. */
export const writeStartReceipt = (
  executionId: string | undefined,
): Effect.Effect<void, CliError> =>
  Effect.try({
    try: () => {
      const path = process.env["PFCLI_START_RECEIPT_PATH"]
      if (path)
        writeFileSync(
          path,
          JSON.stringify({ executionId: executionId ?? null, attempted: true }),
          { mode: 0o600 },
        )
    },
    catch: (cause) =>
      new CliError({
        message: "Cannot persist execution start receipt; request not sent",
        cause,
      }),
  })
