import { Construct, type IConstruct } from "constructs"
import type { Role } from "./role"

export interface InvitationProps {
  /**
   * The email address of the invited user.
   */
  readonly email: string
  /**
   * The roles to assign when the user accepts the invitation.
   * Pass Role construct instances to ensure they exist at construction time.
   */
  readonly roles: readonly Role[]
}

/**
 * An invitation for a user to join the organisation with pre-assigned roles.
 *
 * When a user signs in for the first time with a matching email address,
 * they will automatically be assigned the specified roles.
 *
 * @example
 * ```typescript
 * const employee = new Role(org, "Employee", { name: "Employee" })
 *
 * new Invitation(org, "admin-invite", {
 *   email: "admin@example.com",
 *   roles: [employee],
 * })
 * ```
 */
export class Invitation extends Construct {
  readonly isInvitation: true = true
  readonly email: string
  readonly roles: readonly Role[]

  constructor(scope: IConstruct, id: string, props: InvitationProps) {
    super(scope, id)
    this.email = props.email
    this.roles = props.roles
  }
}
