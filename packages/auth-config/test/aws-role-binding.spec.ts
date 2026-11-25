import { Schema } from "effect"
import { AwsRoleBindingSchema } from "../src/lib/aws-role-binding"
import { expect, test } from "bun:test"

const binding = {
  id: "orders",
  targetIssuer: "https://auth.example.com",
  accountId: "123456789012",
  serviceAccountId: "orders",
}

test.each([
  ["neither selector", {}],
  [
    "both selectors",
    { roleId: "AROA12345678901234567", roleName: "OrdersRole" },
  ],
  ["wildcard", { roleName: "Orders*" }],
  ["IAM ARN", { roleName: "arn:aws:iam::123456789012:role/OrdersRole" }],
  ["IAM path", { roleName: "staging/OrdersRole" }],
  ["a 65-character role name", { roleName: "A".repeat(65) }],
] as const)("rejects AWS role binding with %s", (_reason, selector) => {
  expect(() =>
    Schema.decodeUnknownSync(AwsRoleBindingSchema)({ ...binding, ...selector }),
  ).toThrow()
})

test("accepts a 64-character role name", () => {
  const roleName = "A".repeat(64)
  expect(
    Schema.decodeUnknownSync(AwsRoleBindingSchema)({ ...binding, roleName }),
  ).toMatchObject({ roleName })
})
