import { Cause, Effect, Exit } from "effect"
import { object, string } from "valibot"
import { PasswordProvider } from "../src/provider/password.js"
import {
  ProviderCallbackError,
  tryProviderCallback,
} from "../src/provider/provider.js"
import { createSubjects } from "../src/subject.js"
import {
  type TestApp,
  createIssuer,
  createTestAppFromIssuer,
} from "./test-utils.js"
import { describe, expect, test } from "bun:test"

const subjects = createSubjects({
  user: object({
    userID: string(),
  }),
})

const uiOk = async () => new Response("ok")

describe("provider callback error handling", () => {
  test("tryProviderCallback maps rejection to ProviderCallbackError, not a defect", async () => {
    const sendCode = async () => {
      throw new Error("SMTP unavailable")
    }

    // Baseline: Effect.promise turns the rejection into a defect.
    const defectExit = await Effect.runPromiseExit(
      Effect.promise(() => sendCode()),
    )
    expect(Exit.isFailure(defectExit)).toBe(true)
    if (Exit.isFailure(defectExit)) {
      expect([...Cause.defects(defectExit.cause)]).toHaveLength(1)
      expect([...Cause.failures(defectExit.cause)]).toHaveLength(0)
    }

    // Same helper password/code/passkey providers use for consumer callbacks.
    const typedExit = await Effect.runPromiseExit(
      tryProviderCallback("Password provider sendCode failed", () =>
        sendCode(),
      ),
    )
    expect(Exit.isFailure(typedExit)).toBe(true)
    if (Exit.isFailure(typedExit)) {
      expect([...Cause.defects(typedExit.cause)]).toHaveLength(0)
      const failures = [...Cause.failures(typedExit.cause)]
      expect(failures).toHaveLength(1)
      const failure = failures[0]
      expect(failure).toBeInstanceOf(ProviderCallbackError)
      expect(failure?._tag).toBe("@pf/openauth/ProviderCallbackError")
      expect(failure?.message).toBe("Password provider sendCode failed")
    }
  })

  test("rejecting PasswordProvider sendCode during register returns server_error", async () => {
    const app: TestApp = await createTestAppFromIssuer(
      createIssuer({
        subjects,
        clients: [
          {
            id: "web",
            redirectUris: ["https://client.example.com/callback"],
          },
        ],
        providers: {
          password: PasswordProvider({
            login: uiOk,
            register: uiOk,
            change: uiOk,
            sendCode: async () => {
              throw new Error("SMTP unavailable")
            },
          }),
        },
        success: (ctx, _value) =>
          ctx.subject("user", {
            userID: "123",
          }),
      }),
    )

    // Establish provider cookie state for the register flow.
    const start = await app.request("https://auth.example.com/oauth/password/register")
    expect(start.status).toBe(200)

    const response = await app.request(
      "https://auth.example.com/oauth/password/register",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: start.headers.get("set-cookie")!,
        },
        body: new URLSearchParams({
          action: "register",
          email: "user@example.com",
          password: "secret-password",
          repeat: "secret-password",
        }).toString(),
      },
    )

    expect(response.status).toBe(500)
    const body = (await response.json()) as {
      error?: string
      error_description?: string
    }
    expect(body.error).toBe("server_error")
    expect(body.error_description).toBe(
      "Authentication provider callback failed",
    )
  })
})
