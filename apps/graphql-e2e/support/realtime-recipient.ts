import { decodeJwt } from "jose"
import { getRealtimeRecipientId, subjects } from "@pf/auth-session"

/** Routing facts only; AppSync remains responsible for signature and authorization checks. */
export const getAppSyncRecipientId = async (
  accessToken: string,
): Promise<string> => {
  try {
    const payload = decodeJwt(accessToken)
    const type = payload["type"]
    const properties = payload["properties"]
    if (
      payload["mode"] !== "access" ||
      (type !== "providerUser" && type !== "user") ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp * 1000 <= Date.now()
    ) {
      throw new Error("Invalid token claims")
    }
    // A service schema must not strip a delegated marker into another actor.
    if (
      type === "user" &&
      typeof properties === "object" &&
      properties !== null &&
      "delegation" in properties
    ) {
      throw new Error("Invalid actor")
    }
    const parsed = await subjects[type]["~standard"].validate(properties)
    if (parsed.issues) throw new Error("Invalid session")
    const recipientId = await getRealtimeRecipientId(parsed.value, payload.exp)
    if (!recipientId) throw new Error("Missing recipient")
    return recipientId
  } catch {
    // Neither JWT parser nor schema diagnostics may expose credential contents.
    throw new Error(
      "Invalid access token facts for AppSync recipient addressing",
    )
  }
}
