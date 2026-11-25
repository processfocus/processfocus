import { Schema } from "effect"

const text = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
)

const bindingFields = {
  id: text,
  targetIssuer: text,
  accountId: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{12}$/))),
  serviceAccountId: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)),
  ),
  label: Schema.optional(text),
}

/** Exactly one selector; a name binding deliberately survives role replacement. */
export const AwsRoleBindingSchema = Schema.Union([
  Schema.Struct({
    ...bindingFields,
    roleId: Schema.String.pipe(
      Schema.check(Schema.isPattern(/^AROA[A-Z0-9]{17}$/)),
    ),
    roleName: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    ...bindingFields,
    roleId: Schema.optionalKey(Schema.Never),
    roleName: Schema.String.pipe(
      Schema.check(Schema.isPattern(/^[A-Za-z0-9_+=,.@-]{1,64}$/)),
    ),
  }),
])

export type AwsRoleBinding = Schema.Schema.Type<typeof AwsRoleBindingSchema>

export const awsRoleBindingIdentityKey = (binding: AwsRoleBinding): string =>
  JSON.stringify([
    binding.targetIssuer,
    binding.accountId,
    binding.roleId === undefined
      ? ["roleName", binding.roleName]
      : ["roleId", binding.roleId],
  ])
