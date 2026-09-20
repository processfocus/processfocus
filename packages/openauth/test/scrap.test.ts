import { object, string } from "valibot"
import { createClient } from "../src/client.js"
import { DummyProvider } from "../src/provider/dummy.js"
import { createSubjects } from "../src/subject.js"
import {
  type TestApp,
  createIssuer,
  createTestAppFromIssuer,
} from "./test-utils.js"
import { afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test"

const subjects = createSubjects({
  user: object({
    userID: string(),
  }),
})

let auth: TestApp

beforeEach(() => {
  setSystemTime(new Date("2024-01-01T00:00:00Z"))
})

afterEach(() => {
  setSystemTime()
})

beforeAll(async () => {
  auth = await createTestAppFromIssuer(
    createIssuer({
      subjects,
      clients: [
        {
          id: "123",
          redirectUris: ["https://client.example.com/callback"],
        },
      ],
      success: (ctx, _value, _req) =>
        ctx.subject("user", {
          userID: "123",
        }),
      ttl: {
        access: 1,
      },
      providers: {
        dummy: DummyProvider({ email: "foo@bar.com" }),
      },
    }),
  )
})

test("code flow", async () => {
  const client = createClient({
    issuer: "https://auth.example.com",
    clientID: "123",
    fetch: (a, b) => Promise.resolve(auth.request(a, b)),
  })
  const [verifier, authorization] = await client.pkce(
    "https://client.example.com/callback",
  )
  let response = await auth.request(authorization!)
  expect(response.status).toBe(302)
  response = await auth.request(response.headers.get("location")!, {
    headers: {
      cookie: response.headers.get("set-cookie")!,
    },
  })
  expect(response.status).toBe(302)
  const location = new URL(response.headers.get("location")!)
  const code = location.searchParams.get("code")
  expect(code).not.toBeNull()
  const exchanged = await client.exchange(
    code!,
    "https://client.example.com/callback",
    verifier,
  )
  if (exchanged.err) throw exchanged.err
  expect(exchanged.tokens.access).toBeTruthy()
  expect(exchanged.tokens.refresh).toBeTruthy()
  const verified = await client.verify(subjects, exchanged.tokens.access)
  if (verified.err) throw verified.err
  expect(verified.subject.type).toBe("user")
  if (verified.subject.type !== "user") throw new Error("Invalid subject")
  expect(verified.subject.properties.userID).toBe("123")
  setSystemTime(Date.now() + 2000)
  const failed = await client.verify(subjects, exchanged.tokens.access)
  expect(failed.err).toBeInstanceOf(Error)
  const next = await client.verify(subjects, exchanged.tokens.access, {
    refresh: exchanged.tokens.refresh,
  })
  if (next.err) throw next.err
  expect(next.tokens?.access).toBeDefined()
  expect(next.tokens?.refresh).toBeDefined()
  expect(next.tokens?.access).not.toEqual(exchanged.tokens.access)
  expect(next.tokens?.refresh).not.toEqual(exchanged.tokens.refresh)
  // biome-ignore lint/suspicious/noNonNullAssertedOptionalChain: test assertion after toBeDefined check
  await client.verify(subjects, next.tokens?.access!)
})
