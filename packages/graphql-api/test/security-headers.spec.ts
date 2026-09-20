import { DateTime } from "effect"
import { createSchema, createYoga } from "graphql-yoga"
import {
  type ServerContext,
  type UserContext,
  securityHeadersPlugin,
} from "../src/lib/graphql-api"
import { describe, expect, it } from "bun:test"

const testSchema = createSchema<UserContext>({
  typeDefs: /* GraphQL */ `
    type Query {
      ping: String!
    }
  `,
  resolvers: {
    Query: {
      ping: () => "pong",
    },
  },
})

const createTestContext = (): UserContext => ({
  _requestTime: DateTime.unsafeMake(Date.now()),
  _userDetails: { by: "test", id: "usr-test" },
  jwt: undefined,
  userId: undefined,
})

const createGraphqlRequest = (): Request =>
  new Request("http://localhost/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: "{ ping }" }),
  })

describe("security headers plugin", () => {
  it("adds default headers to every response", async () => {
    const yoga = createYoga<ServerContext, UserContext>({
      schema: testSchema,
      plugins: [securityHeadersPlugin],
      graphqlEndpoint: "/graphql",
      context: (initialContext) => ({
        ...initialContext,
        ...createTestContext(),
      }),
    })

    const response = await yoga.handle(createGraphqlRequest())

    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer")
    expect(response.headers.get("X-Frame-Options")).toBe("DENY")
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com/@graphql-yoga/; connect-src 'self' ws: wss: https://unpkg.com/@graphql-yoga/; style-src 'self' 'unsafe-inline' https://unpkg.com/@graphql-yoga/; font-src 'self' data:; img-src 'self' https://raw.githubusercontent.com/graphql-hive/graphql-yoga/; worker-src 'self' blob:;",
    )
  })

  it("respects Content-Security-Policy but overrides other security headers", async () => {
    const presetHeaderPlugin = {
      onResponse: ({ response }: { response: Response }) => {
        response.headers.set("Referrer-Policy", "strict-origin")
      },
    }

    const yoga = createYoga<ServerContext, UserContext>({
      schema: testSchema,
      plugins: [presetHeaderPlugin, securityHeadersPlugin],
      graphqlEndpoint: "/graphql",
      context: (initialContext) => ({
        ...initialContext,
        ...createTestContext(),
      }),
    })

    const response = await yoga.handle(createGraphqlRequest())

    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer")
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com/@graphql-yoga/; connect-src 'self' ws: wss: https://unpkg.com/@graphql-yoga/; style-src 'self' 'unsafe-inline' https://unpkg.com/@graphql-yoga/; font-src 'self' data:; img-src 'self' https://raw.githubusercontent.com/graphql-hive/graphql-yoga/; worker-src 'self' blob:;",
    )
  })
})
