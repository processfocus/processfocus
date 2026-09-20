import { Construct } from "constructs"
import type { Organisation } from "./organisation"
import type { Role } from "./role"

export interface ExecutionFailureNotificationsProps {
  readonly roles?: readonly Role[]
}

/**
 * Org-wide configuration for fatal execution failure notifications.
 */
export class ExecutionFailureNotifications extends Construct {
  readonly isExecutionFailureNotifications = true as const
  readonly roles: readonly Role[]

  constructor(
    scope: Organisation,
    props: ExecutionFailureNotificationsProps = {},
  ) {
    super(scope, "ExecutionFailureNotifications")
    this.roles = props.roles ?? []
  }
}
