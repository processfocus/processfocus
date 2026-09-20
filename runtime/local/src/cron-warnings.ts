import { Effect } from "effect"
import type { Organisation } from "@pf/process"

export const warnIgnoredCronDeclarations = (
  org: Organisation,
  runtimeName: string,
) =>
  Effect.forEach(
    org.processes().filter((process) => process.props.cron !== undefined),
    (process) =>
      Effect.logWarning(
        `Ignoring cron for ${process.node.path} in ${runtimeName}. Local cron execution is not supported.`,
      ),
    { discard: true },
  )
