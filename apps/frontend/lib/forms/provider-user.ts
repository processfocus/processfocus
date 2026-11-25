import { Schema } from "effect"
import {
  BooleanField,
  CheckboxGroupField,
  type CheckboxGroupOption,
  TextBlock,
  TextField,
  Wrapper,
} from "@pf/form-schema"

export const providerUserForm = (
  roles: readonly CheckboxGroupOption[],
  provider: string,
  taskAssignmentEmailAvailable: boolean,
) =>
  Schema.Struct({
    identity: Wrapper(
      {
        explanation: TextBlock(
          provider === "passkey"
            ? "First and last names can be edited here. Email remains read-only; full name is computed from the saved names."
            : "Email and name come from the external identity provider and are read-only here.",
        ),
        email: TextField({ label: "Email", readOnly: true }),
        firstName:
          provider === "passkey"
            ? Schema.optional(TextField({ label: "First Name" }))
            : TextField({ label: "First Name", readOnly: true }),
        lastName:
          provider === "passkey"
            ? Schema.optional(TextField({ label: "Last Name" }))
            : TextField({ label: "Last Name", readOnly: true }),
        fullName: TextField({
          label: "Full Name (auto-computed)",
          readOnly: true,
        }),
      },
      { label: "User Information" },
    ),
    assignments: Wrapper(
      {
        roleIds: CheckboxGroupField({ label: "Roles", options: roles }),
      },
      { label: "Role Assignments" },
    ),
    notifications: Wrapper(
      {
        taskAssignmentEmail: taskAssignmentEmailAvailable
          ? BooleanField({
              label: "Task Assignment Emails",
              description:
                "Send email notifications when new tasks are assigned",
              default: false,
            })
          : TextBlock(
              "Task Assignment Emails are unavailable because email delivery is not configured.",
            ),
        executionFailureEmail: BooleanField({
          label: "Execution failures",
          description: "Send email notifications for fatal execution failures",
          default: false,
        }),
      },
      { label: "Notification Preferences" },
    ),
  })
