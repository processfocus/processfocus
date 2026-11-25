import { Option, Schema } from "effect"
import type { Session } from "./subjects"

/** Attribution only; never a credential or authorization principal. */
export const encodeWorkloadAudit = (session: Session): string | undefined =>
  "awsRole" in session && session.awsRole
    ? `pf:aws-role:${JSON.stringify({ actor: session.clientId, ...session.awsRole })}`
    : session.workload
      ? `pf:workload:${JSON.stringify({
          userId: session.userId,
          actor: "email" in session ? session.email : session.clientId,
          workload: session.workload,
        })}`
      : undefined

const AuditLabel = Schema.Struct({
  actor: Schema.String,
  workload: Schema.Struct({ runId: Schema.String, runAttempt: Schema.String }),
})

const AwsAuditLabel = Schema.Struct({
  actor: Schema.String,
  accountId: Schema.String,
  roleId: Schema.String,
  requestId: Schema.String,
})

export const workloadAuditLabel = (by: string): string | undefined => {
  if (by.startsWith("pf:aws-role:")) {
    return Option.match(
      Schema.decodeUnknownOption(Schema.fromJsonString(AwsAuditLabel))(
        by.slice("pf:aws-role:".length),
      ),
      {
        onNone: () => "",
        onSome: ({ actor, accountId, roleId, requestId }) =>
          `${actor}/AWS ${accountId}/${roleId} request ${requestId}`,
      },
    )
  }
  if (!by.startsWith("pf:workload:")) return undefined
  return Option.match(
    Schema.decodeUnknownOption(Schema.fromJsonString(AuditLabel))(
      by.slice("pf:workload:".length),
    ),
    {
      onNone: () => "",
      onSome: ({ actor, workload }) =>
        `${actor}/CI ${workload.runId} attempt ${workload.runAttempt}`,
    },
  )
}
