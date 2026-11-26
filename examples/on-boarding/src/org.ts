import {
  type ConfigurationContract,
  configurationField,
} from "@processfocus/runtime"
import { Config, Effect } from "effect"
import { AuthenticationConfig } from "@pf/auth-config"
import { Invitation, Organisation, Role } from "@pf/process"
import { OnBoarding } from "./on-boarding"

export const org = new Organisation({
  platformRef: "trunk",
  name: "Org",
})

// Org-level role
export const employee = new Role(org, "Employee", { name: "Employee" })

new OnBoarding(org, "on-boarding")

const onBoardingConfiguration = {
  owner: "On-boarding",
  target: "authentication",
  fields: {
    googleClientId: configurationField(
      "GOOGLE_CLIENT_ID",
      Config.String("GOOGLE_CLIENT_ID"),
    ),
    googleClientSecret: configurationField(
      "GOOGLE_CLIENT_SECRET",
      Config.String("GOOGLE_CLIENT_SECRET"),
      { secret: true },
    ),
    email: configurationField(
      "MY_EMAIL",
      Config.String("MY_EMAIL").pipe(
        Config.withDefault("employee@example.com"),
      ),
    ),
  },
  rules: [],
}

export const Configuration = {
  version: 1,
  groups: [onBoardingConfiguration],
} satisfies ConfigurationContract

export const configureOrg: Effect.Effect<Organisation, Config.ConfigError> =
  Effect.gen(function* () {
    const googleClientId =
      yield* onBoardingConfiguration.fields.googleClientId.config
    const googleClientSecret =
      yield* onBoardingConfiguration.fields.googleClientSecret.config
    const email = yield* onBoardingConfiguration.fields.email.config
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
    new Invitation(org, "berend", { email, roles: [employee] })
    return org
  })
