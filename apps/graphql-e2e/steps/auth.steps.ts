import assert from "node:assert"
import { Given, Then, When } from "@cucumber/cucumber"
import { SignJWT, generateKeyPair } from "jose"
import {
  getEffectiveAuthUrl,
  getEffectiveGraphqlEndpoint,
} from "@pf/frontend-endpoints/port-files"
import {
  runAuthenticate,
  runAuthenticateAsProviderUser,
  runAuthenticateWithRole,
} from "../support/auth-helpers"
import type { TestWorld } from "../support/world"

const getAuthUrl = getEffectiveAuthUrl
const getGraphqlEndpoint = getEffectiveGraphqlEndpoint

/**
 * Create an expired JWT token for testing.
 * Uses a different key than the server (will fail signature verification),
 * and sets expiration 1 hour in the past (will fail expiry check).
 * The server may reject on either condition depending on validation order.
 */
const createExpiredJwt = async (): Promise<string> => {
  const { privateKey } = await generateKeyPair("ES256")

  // Create a token that expired 1 hour ago
  const expiredAt = Math.floor(Date.now() / 1000) - 3600

  return new SignJWT({
    sub: "test-user",
    aud: "graphql-api",
    properties: { userId: "usr-test" },
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuedAt(expiredAt - 3600)
    .setExpirationTime(expiredAt)
    .setIssuer(getAuthUrl())
    .sign(privateKey)
}

/**
 * Create a JWT with an invalid signature for testing.
 * Uses a different key than the server.
 */
const createInvalidSignatureJwt = async (): Promise<string> => {
  const { privateKey } = await generateKeyPair("ES256")

  return new SignJWT({
    sub: "test-user",
    aud: "graphql-api",
    properties: { userId: "usr-test" },
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .setIssuer(getAuthUrl())
    .sign(privateKey)
}

Given(
  "I am authenticated without roles",
  { timeout: 30_000 },
  async function (this: TestWorld) {
    const result = await runAuthenticate()
    if (!result.access_token) {
      throw new Error(`Authentication failed: ${result.error}`)
    }
    this.accessToken = result.access_token
  },
)

Given(
  "I am authenticated as provider user {string}",
  { timeout: 30_000 },
  async function (this: TestWorld, email: string) {
    // Use two-step flow: requestProviderUserPermissions mutation then authenticate with email scope
    const result = await runAuthenticateAsProviderUser(email)
    if (!result.access_token) {
      throw new Error(`Authentication failed: ${result.error}`)
    }
    this.accessToken = result.access_token
  },
)

Given(
  "I am authenticated with the {string} role",
  { timeout: 30_000 },
  async function (this: TestWorld, role: string) {
    // Use two-step flow: requestRole mutation then authenticate with role scope
    // Budget: 3 sequential HTTP calls (base auth + requestRole GraphQL + scoped auth)
    // each ~2-3s via Lambda + Turso, with potential connection re-establishment spikes
    const result = await runAuthenticateWithRole(role)
    if (!result.access_token) {
      throw new Error(`Authentication failed: ${result.error}`)
    }
    this.accessToken = result.access_token
  },
)

When(
  "I authenticate with the {string} role",
  { timeout: 30_000 },
  async function (this: TestWorld, role: string) {
    // Use two-step flow: requestRole mutation then authenticate with role scope
    const result = await runAuthenticateWithRole(role)
    if (result.access_token) {
      this.accessToken = result.access_token
    } else if (result.error) {
      this.authError = {
        error: result.error,
        error_description: result.error_description,
      }
    }
  },
)

When(
  "I authenticate directly with the {string} role scope",
  async function (this: TestWorld, role: string) {
    // Authenticate directly with role scope, skipping the requestRole mutation
    // This should fail because permitted_client_role entry won't exist
    const result = await runAuthenticate(`role:${role}`)
    if (result.access_token) {
      this.accessToken = result.access_token
    } else if (result.error) {
      this.authError = {
        error: result.error,
        error_description: result.error_description,
      }
    }
  },
)

Then("I should receive an invalid_scope error", function (this: TestWorld) {
  assert.ok(this.authError, "Expected an authentication error")
  assert.strictEqual(
    this.authError.error,
    "invalid_scope",
    `Expected invalid_scope error but got: ${this.authError.error}`,
  )
})

// Unauthenticated and invalid token step definitions

Given("I am not authenticated", function (this: TestWorld) {
  this.accessToken = null
})

Given("I have a malformed JWT token", function (this: TestWorld) {
  this.accessToken = "not-a-jwt"
})

Given("I have an expired JWT token", async function (this: TestWorld) {
  this.accessToken = await createExpiredJwt()
})

Given("I have a JWT with invalid signature", async function (this: TestWorld) {
  this.accessToken = await createInvalidSignatureJwt()
})

Then("I should receive an authentication error", function (this: TestWorld) {
  assert.ok(this.graphqlError, "Expected a GraphQL error but none was received")
  // JWT plugin returns errors with specific messages for missing/invalid tokens
  const errorMessage = this.graphqlError.message.toLowerCase()
  const isAuthError =
    errorMessage.includes("unauthenticated") ||
    errorMessage.includes("unauthorized") ||
    errorMessage.includes("token") ||
    errorMessage.includes("jwt") ||
    errorMessage.includes("missing") ||
    errorMessage.includes("invalid")
  assert.ok(
    isAuthError,
    `Expected authentication error but got: ${this.graphqlError.message}`,
  )
})

Then(
  "I should receive an authorization error for {string}",
  function (this: TestWorld, fieldName: string) {
    assert.ok(
      this.graphqlError,
      "Expected a GraphQL error but none was received",
    )
    const errorMessage = this.graphqlError.message
    assert.ok(
      errorMessage.includes("Not authorized") &&
        errorMessage.includes(fieldName),
      `Expected authorization error for ${fieldName} but got: ${errorMessage}`,
    )
  },
)

Then("I should not receive an error", function (this: TestWorld) {
  assert.ok(
    !this.graphqlError,
    `Expected no error but got: ${this.graphqlError?.message}`,
  )
})

// Cookie-based authentication step definitions

When(
  "I query the org using cookie authentication",
  async function (this: TestWorld) {
    const response = await fetch(getGraphqlEndpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Send token in cookie instead of Authorization header
        ...(this.accessToken
          ? { Cookie: `access_token=${this.accessToken}` }
          : {}),
      },
      body: JSON.stringify({
        query: "{ org { name acronym } }",
      }),
    })

    const result = (await response.json()) as {
      data?: { org: { name: string; acronym: string | null } }
      errors?: Array<{ message: string }>
    }

    if (result.errors?.length && result.errors[0]) {
      this.graphqlError = new Error(result.errors[0].message)
    } else if (result.data?.org) {
      this.orgResult = result.data.org
    }
  },
)

// WebSocket authentication step definitions

When("I try to subscribe to todo updates", function (this: TestWorld) {
  // Use trySubscribe which handles connection errors gracefully
  this.trySubscribe(`
    subscription StreamTodo {
      streamTodo {
        documents {
          id
          stepPath
          status
          description
        }
        checkpoint {
          id
          updatedAt
        }
      }
    }
  `)
})

Then(
  "the subscription should have an authentication error",
  async function (this: TestWorld) {
    // Wait a bit for the connection to attempt and fail
    await this.waitForSubscriptionError(5000)

    assert.ok(
      this.subscriptionError,
      "Expected a subscription error but none was received",
    )

    const errorMessage = this.subscriptionError.message.toLowerCase()
    const isAuthError =
      errorMessage.includes("unauthenticated") ||
      errorMessage.includes("unauthorized") ||
      errorMessage.includes("forbidden") ||
      errorMessage.includes("token") ||
      errorMessage.includes("jwt") ||
      errorMessage.includes("4401") || // WebSocket close code for unauthorized
      errorMessage.includes("4403") || // WebSocket close code for forbidden
      errorMessage.includes("401") || // HTTP status code for unauthorized
      errorMessage.includes("403") // HTTP status code for forbidden
    assert.ok(
      isAuthError,
      `Expected authentication error but got: ${this.subscriptionError.message}`,
    )
  },
)
