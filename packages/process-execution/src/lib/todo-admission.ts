import { DateTime, Effect } from "effect"
import { StepCompletionOperations } from "@pf/graphql-db-operations"
import { NotAuthorized } from "@pf/graphql-schema/errors"
import type { PublicTodoTokenPayload } from "@pf/public-completion/credentials"
import { getRequestTime } from "@pf/request-time"
import {
  checkPublicTodoAuthorization,
  checkTodoAuthorization,
} from "./authorization"
import type { ExecutionIdentity } from "./identity"

export type TodoActor =
  | { readonly kind: "authenticated"; readonly identity: ExecutionIdentity }
  | {
      readonly kind: "public-completion"
      readonly capability: PublicTodoTokenPayload
      /** Caller context for field permissions/defaults; the capability admits the Todo. */
      readonly identity: ExecutionIdentity
    }

/** Re-read live admission on every completion attempt, before any writes. */
export const authorizeTodo = (todoId: string, actor: TodoActor) =>
  Effect.gen(function* () {
    const operations = yield* StepCompletionOperations
    const todo = yield* operations.queryTodoForCompletionById(todoId)
    if (!todo || todo.correctionRequiredAt !== null)
      return yield* new NotAuthorized({
        action: "complete",
        resource: todoId,
        message:
          todo?.correctionRequiredAt !== null && todo
            ? "Correction required todos must use correction handling"
            : "Not authorized to complete step",
      })
    if (actor.kind === "authenticated")
      return yield* checkTodoAuthorization(actor.identity, todo)
    const capability = actor.capability
    const info = yield* operations.queryPublicTodoInfo(todoId)
    const recipient = info.latestPublicCompletionInvitationRecipientEmail
    const now = yield* getRequestTime()
    if (
      capability.tid !== todoId ||
      info.status === "unavailable" ||
      (recipient !== null &&
        capability.externalParticipantEmail?.trim().toLowerCase() !==
          recipient.trim().toLowerCase()) ||
      (info.status !== "completed" &&
        capability.exp <= DateTime.toEpochMillis(now) / 1000)
    )
      return yield* new NotAuthorized({
        action: "complete",
        resource: todoId,
        message: "This public link is not available to complete this todo",
      })
    yield* checkPublicTodoAuthorization(capability.tid, todoId)
    return null
  })
