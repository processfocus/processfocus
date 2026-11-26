import { Schema } from "effect"
import {
  CheckboxGroupField,
  type CheckboxGroupOption,
  FormEmailInput,
  TextFieldFrom,
  Wrapper,
} from "@pf/form-schema"

export const invitationForm = (
  roles: readonly CheckboxGroupOption[],
  readOnly = false,
) =>
  Schema.Struct({
    invitation: Wrapper(
      {
        email: TextFieldFrom(
          Schema.Trim.check(
            Schema.makeFilter((value) =>
              !value
                ? "Email is required"
                : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ||
                  "Enter a valid email address",
            ),
          ).annotate({ [FormEmailInput]: true }),
          { label: "Email", readOnly },
        ),
      },
      { label: "Invitation" },
    ),
    assignments: Wrapper(
      {
        roleIds: CheckboxGroupField({
          label: "Roles",
          options: roles,
          readOnly,
        }).check(
          Schema.isMinLength(1, { message: "Select at least one role" }),
        ),
      },
      { label: "Role Assignments" },
    ),
  })
