import {
  type ConfigurationGroup,
  configurationField,
  configurationSecret,
  configurationString,
} from "@processfocus/runtime"
import { Config } from "effect"

export const XERO_DEFAULT_SCOPES = "accounting.invoices accounting.contacts"

export const makeXeroConfiguration = (
  bindings: { readonly clientId?: string; readonly clientSecret?: string } = {},
) =>
  ({
    owner: "accounting.xero",
    target: "job-worker",
    fields: {
      clientId: configurationField(
        bindings.clientId ?? "XERO_CLIENT_ID",
        configurationString(bindings.clientId ?? "XERO_CLIENT_ID"),
      ),
      clientSecret: configurationField(
        bindings.clientSecret ?? "XERO_CLIENT_SECRET",
        configurationSecret(bindings.clientSecret ?? "XERO_CLIENT_SECRET"),
        { secret: true },
      ),
      scopes: configurationField(
        "XERO_SCOPES",
        configurationString("XERO_SCOPES").pipe(
          Config.withDefault(XERO_DEFAULT_SCOPES),
        ),
      ),
    },
    rules: [],
  }) satisfies ConfigurationGroup

export const XeroConfiguration = makeXeroConfiguration()
