import { Effect } from "effect"
import {
  type PublicTodoTokenPayload,
  buildPublicTodoUrl,
  decryptPublicTodoToken,
  encryptPublicTodoToken,
} from "../src/credentials"
import { describe, expect, it } from "bun:test"

// Fixed ciphertexts from the pre-extraction protocol. Expiry admission belongs
// to the protected operation, so these intentionally old timestamps still decode.
const basePayload: PublicTodoTokenPayload = {
  v: 1,
  tid: "todo-1",
  iat: 1700000000,
  exp: 1700086400,
  aud: "graphql-api:public-todo",
}
const compatibilityCases = [
  {
    name: "legacy Todo-only payload",
    token:
      "yPGnnTRWVbzGC7eN.mIVpI0t_QY5Jd6WZNwRFYQ.hAH7-RBTxdcFqG-jniHiwLASQRquDQveViIuRfFNU3oQQZMu6RiLTmIyL9SIjS_Lw2TDMzd14LiVgc6U463d2STFKG6UxlJ77wJ747Rh0JUNNeb1LAdtLw",
    payload: basePayload,
  },
  {
    name: "legacy recipient payload",
    token:
      "k4ZOoydI97sBuhVy.fmkXZ2M2lnCp1QBVcbIYmw.c-OopPWffzki4obWxZuuT_jMmIjV1AKvZ4pLYLVw5fgGiBr1ytCouTBdV1-WR3ID03bMGX_lBbZT_LaHv2zBBhP6rE3tnVhwXDt_v2a9y4E5Y2voqc4tFTP5PiECo99oHdfwL214PXDTl9T-YnuTQNqUkgY4M7zQZeXn5PmP4jpFypyl-aE4RQ",
    payload: { ...basePayload, externalParticipantEmail: "parent@example.com" },
  },
  {
    name: "current invitation payload",
    token:
      "sABX4JP1niDALWb9.arvBlzbx5_itJCHg6uE2DQ.1ONDosmLOOGkTLewFTiVsAvxp5e48BeSL8sed_nKUf3cpamSluGr3bmvCVJH88KnHyl4cQyoV0qrnPetLo_8oCJzD-U05F7QJdGTclxruL3LKWoNCqTNU-MPtsVSBnHuLO5Wy9CWJSxaYmA4bsqgRRkM4IBnscVWydF3QgXNwPnGj6IM_t-7_HOLUrWomEfCdbNbeuyebth2qyrlB-ufBiqIrpj6iVS_npOMGkTtU3CUBkgQp5OWImiK",
    payload: {
      ...basePayload,
      externalParticipantEmail: "parent@example.com",
      publicCompletionInvitationAttemptId: "attempt-1",
    },
  },
]

describe("Public Completion credential compatibility", () => {
  for (const { name, token, payload } of compatibilityCases) {
    it(`reads existing ${name}`, async () => {
      expect(
        await Effect.runPromise(
          decryptPublicTodoToken(token, "compatibility-secret"),
        ),
      ).toEqual(payload)
    })
  }

  it("rejects a ciphertext encrypted with another secret", async () => {
    const token = await Effect.runPromise(
      encryptPublicTodoToken(basePayload, "other-secret"),
    )
    const error = await Effect.runPromise(
      decryptPublicTodoToken(token, "compatibility-secret").pipe(Effect.flip),
    )
    expect(error).toMatchObject({
      _tag: "PublicTodoTokenError",
      message: "Invalid public todo token",
    })
  })

  it("preserves environment secret selection and development/test fallback", async () => {
    const originalSecret = process.env["PUBLIC_TODO_TOKEN_SECRET"]
    const originalNodeEnv = process.env["NODE_ENV"]
    try {
      for (const nodeEnv of ["development", "test", "production"]) {
        process.env["NODE_ENV"] = nodeEnv
        process.env["PUBLIC_TODO_TOKEN_SECRET"] = "configured-secret"
        const configured = await Effect.runPromise(
          encryptPublicTodoToken(basePayload),
        )
        expect(
          await Effect.runPromise(
            decryptPublicTodoToken(configured, "configured-secret"),
          ),
        ).toEqual(basePayload)
        delete process.env["PUBLIC_TODO_TOKEN_SECRET"]
        if (nodeEnv === "production") {
          const error = await Effect.runPromise(
            encryptPublicTodoToken(basePayload).pipe(Effect.flip),
          )
          expect(error.message).toBe(
            "PUBLIC_TODO_TOKEN_SECRET is not configured",
          )
        } else {
          const fallback = await Effect.runPromise(
            encryptPublicTodoToken(basePayload),
          )
          expect(
            await Effect.runPromise(
              decryptPublicTodoToken(fallback, "dev-public-todo-secret"),
            ),
          ).toEqual(basePayload)
        }
      }
    } finally {
      if (originalSecret === undefined)
        delete process.env["PUBLIC_TODO_TOKEN_SECRET"]
      else process.env["PUBLIC_TODO_TOKEN_SECRET"] = originalSecret
      if (originalNodeEnv === undefined) delete process.env["NODE_ENV"]
      else process.env["NODE_ENV"] = originalNodeEnv
    }
  })
})

describe("buildPublicTodoUrl", () => {
  it("builds a public form URL from the frontend origin and token", () => {
    expect(buildPublicTodoUrl("https://app.example.com/", "abc.def.ghi")).toBe(
      "https://app.example.com/public/form/abc.def.ghi",
    )
  })

  it("encodes the capability token in the path", () => {
    expect(buildPublicTodoUrl("https://app.example.com", "a+b/c")).toBe(
      "https://app.example.com/public/form/a%2Bb%2Fc",
    )
  })
})
