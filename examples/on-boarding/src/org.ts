import { AuthenticationConfig } from "@pf/auth-config"
import { Invitation, Organisation, Role } from "@pf/process"
import { OnBoarding } from "./on-boarding"

export const org = new Organisation({
  name: "Org",
})

// Org-level role
export const employee = new Role(org, "Employee", { name: "Employee" })

new OnBoarding(org, "on-boarding")

// Placeholders keep pfcli build/typecheck working without secrets (pre-commit
// and CI). Deploy and local auth need real GOOGLE_CLIENT_ID / SECRET set.
const googleClientId =
  process.env["GOOGLE_CLIENT_ID"] ??
  "on-boarding-build-placeholder-google-client-id"
const googleClientSecret =
  process.env["GOOGLE_CLIENT_SECRET"] ??
  "on-boarding-build-placeholder-google-client-secret"

// Configure OAuth authentication
new AuthenticationConfig(org, "auth", {
  inviteOnly: true,
  identityProviders: {
    google: {
      clientID: googleClientId,
      clientSecret: googleClientSecret,
      scopes: ["openid", "email", "profile"],
    },
  },
})

new Invitation(org, "berend", {
  // Set MY_EMAIL for your own invitation; the placeholder keeps CI builds portable.
  email: process.env["MY_EMAIL"] ?? "employee@example.com",
  roles: [employee],
})
