import { GraphQLClient } from "graphql-request"
import { renderToStaticMarkup } from "react-dom/server"
import type { GraphqlRequester } from "@pf/frontend-plugin-host"
import { ConfigProvider } from "../components/config-provider"
import { GraphqlClientConsumer } from "../lib/graphql/client-consumer"
import { GraphqlClientProvider } from "../lib/graphql/client-provider"
import { describe, expect, test } from "bun:test"

describe("organisation plugin GraphQL consumer", () => {
  test("renders public form plugins without granting authenticated GraphQL access", async () => {
    const requests: Promise<unknown>[] = []
    const html = renderToStaticMarkup(
      <GraphqlClientConsumer>
        {(client) => {
          requests.push(client.request("query { privateData }"))
          return <span>Public plugin field</span>
        }}
      </GraphqlClientConsumer>,
    )
    expect(html).toContain("Public plugin field")
    expect(requests).toHaveLength(1)
    for (const request of requests) {
      await expect(request).rejects.toThrow(
        "Authenticated GraphQL requests are unavailable on this public surface",
      )
    }
  })

  test("uses the real Dashboard provider for authenticated plugin requests", () => {
    const clients: GraphqlRequester[] = []
    renderToStaticMarkup(
      <ConfigProvider
        value={{
          graphqlEndpoint: "https://dashboard.example/graphql",
          wsEndpoint: "",
          appSyncEventsHttpEndpoint: "",
          orgId: "org-a",
          featureFlags: { newDashboard: false },
        }}
      >
        <GraphqlClientProvider>
          <GraphqlClientConsumer>
            {(client) => {
              clients.push(client)
              return null
            }}
          </GraphqlClientConsumer>
          <GraphqlClientConsumer>
            {(client) => {
              clients.push(client)
              return null
            }}
          </GraphqlClientConsumer>
        </GraphqlClientProvider>
      </ConfigProvider>,
    )
    expect(clients).toHaveLength(2)
    expect(clients[0]).toBeInstanceOf(GraphQLClient)
    expect(clients[0]).toBe(clients[1])
  })
})
