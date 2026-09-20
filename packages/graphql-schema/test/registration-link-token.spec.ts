import { Effect } from "effect"
import {
  buildRegistrationLinkUrl,
  decryptRegistrationLinkToken,
  generateRegistrationLinkMaterial,
  hashRegistrationLinkToken,
} from "../src/registration-link-token"
import { describe, expect, it } from "bun:test"

describe("registration-link-token", () => {
  const secret = "test-invitation-registration-secret-32b!!"
  const organisationScope = "org-test"
  const invitationId = "inv-01TESTINVITATIONID0000001"
  const expiresAtUnixMs = Date.UTC(2026, 6, 28, 12, 0, 0)

  it("generates a 256-bit token with hash and decryptable envelope", async () => {
    const material = await Effect.runPromise(
      generateRegistrationLinkMaterial({
        organisationScope,
        invitationId,
        expiresAtUnixMs,
        secret,
      }),
    )

    expect(Buffer.from(material.rawToken, "base64url").length).toBe(32)
    expect(material.tokenHash).toBe(
      hashRegistrationLinkToken(material.rawToken),
    )
    expect(material.envelope.encryptionVersion).toBe(1)
    expect(material.envelope.nonce.length).toBeGreaterThan(0)
    expect(material.envelope.authenticationTag.length).toBeGreaterThan(0)
    expect(material.envelope.ciphertext.length).toBeGreaterThan(0)

    const decrypted = await Effect.runPromise(
      decryptRegistrationLinkToken({
        organisationScope,
        invitationId,
        tokenHash: material.tokenHash,
        expiresAtUnixMs,
        envelope: material.envelope,
        secret,
      }),
    )
    expect(decrypted).toBe(material.rawToken)
  })

  it("fails closed when the secret is missing", async () => {
    const result = await Effect.runPromise(
      generateRegistrationLinkMaterial({
        organisationScope,
        invitationId,
        expiresAtUnixMs,
        secret: "",
      }).pipe(Effect.either),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left.message).toContain(
        "INVITATION_REGISTRATION_ENCRYPTION_KEY",
      )
    }
  })

  it("fails decryption when the secret or organisation scope differs", async () => {
    const material = await Effect.runPromise(
      generateRegistrationLinkMaterial({
        organisationScope,
        invitationId,
        expiresAtUnixMs,
        secret,
      }),
    )

    const wrongSecret = await Effect.runPromise(
      decryptRegistrationLinkToken({
        organisationScope,
        invitationId,
        tokenHash: material.tokenHash,
        expiresAtUnixMs,
        envelope: material.envelope,
        secret: "different-invitation-registration-secret!!",
      }).pipe(Effect.either),
    )
    expect(wrongSecret._tag).toBe("Left")

    const wrongScope = await Effect.runPromise(
      decryptRegistrationLinkToken({
        organisationScope: "pf-other-scope",
        invitationId,
        tokenHash: material.tokenHash,
        expiresAtUnixMs,
        envelope: material.envelope,
        secret,
      }).pipe(Effect.either),
    )
    expect(wrongScope._tag).toBe("Left")
  })

  it("fails decryption when AAD binding changes", async () => {
    const material = await Effect.runPromise(
      generateRegistrationLinkMaterial({
        organisationScope,
        invitationId,
        expiresAtUnixMs,
        secret,
      }),
    )

    const result = await Effect.runPromise(
      decryptRegistrationLinkToken({
        organisationScope,
        invitationId: "inv-different",
        tokenHash: material.tokenHash,
        expiresAtUnixMs,
        envelope: material.envelope,
        secret,
      }).pipe(Effect.either),
    )
    expect(result._tag).toBe("Left")
  })

  it("builds the fragment-bearing registration URL", () => {
    expect(buildRegistrationLinkUrl("https://app.example.com/", "abc")).toBe(
      "https://app.example.com/register/passkey#token=abc",
    )
  })
})
