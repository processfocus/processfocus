import { ConfigProvider, Effect } from "effect"
import { localFixtureSecretClients } from "../src"
import { expect, test } from "bun:test"

test("legacy fixture clients are excluded from deployed and malformed issuers", async () => {
  const clients = {
    "ci-pipeline": { secret: "dummy", audience: "graphql-api" },
  }
  for (const issuer of [
    "https://dev.backend.processfocus.com",
    "https://abcde.0000-9999-0000.app.processfocus.com",
    "https://localhost.example.com",
    "http://localhost@remote.example.com",
    "file:///localhost",
    "not-a-url",
  ]) {
    const result = await Effect.runPromise(
      localFixtureSecretClients(clients).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              OAUTH_ISSUER_URL: issuer,
              NODE_ENV: "development",
            }),
          ),
        ),
      ),
    )
    expect(result).toEqual({})
  }
  const productionWithoutIssuer = await Effect.runPromise(
    localFixtureSecretClients(clients).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ NODE_ENV: "production" }),
        ),
      ),
    ),
  )
  expect(productionWithoutIssuer).toEqual({})
})

test("local dummy credentials remain available on loopback issuers", async () => {
  const clients = {
    "ci-pipeline": { secret: "dummy", audience: "graphql-api" },
  }
  for (const issuer of [
    undefined,
    "http://localhost:4020",
    "http://127.0.0.1:4211",
    "http://[::1]:4020",
  ]) {
    const result = await Effect.runPromise(
      localFixtureSecretClients(clients).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              ...(issuer === undefined ? {} : { OAUTH_ISSUER_URL: issuer }),
              NODE_ENV: "development",
            }),
          ),
        ),
      ),
    )
    expect(result).toEqual(clients)
  }
})
