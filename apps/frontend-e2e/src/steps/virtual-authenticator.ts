import type { CDPSession } from "@playwright/test"

/** Same user-verified, discoverable credential device for probes and BDD. */
export async function addVirtualPasskeyAuthenticator(cdp: CDPSession) {
  return (
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })
  ).authenticatorId
}
