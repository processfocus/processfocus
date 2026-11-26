import type { ExecutionIdentity } from "@pf/process-execution"
import type { UserContext } from "./types"

export const executionIdentity = (context: UserContext): ExecutionIdentity => ({
  session: context.jwt?.properties,
  userId: context.userId,
  ...(context.jwt ? { subject: context.jwt.sub } : {}),
})
