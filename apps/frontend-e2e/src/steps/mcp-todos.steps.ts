import { createHash, randomBytes, randomUUID } from "node:crypto"
import { type Page, expect } from "@playwright/test"
import { Schema } from "effect"
import { getEffectiveGraphqlEndpoint } from "@pf/frontend-endpoints/port-files"
import { dashboardAccount, dashboardRegistrationLink } from "./dashboard-user"
import { Then } from "./fixtures"
import type { PasskeyUser, PasskeyUserOptions } from "./passkey-user"
import { journeyFor } from "./todo-completion.steps"

const random = () => randomBytes(32).toString("base64url")
const Registration = Schema.Struct({ client_id: Schema.String })
const Metadata = Schema.Struct({
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.String,
})
const Tokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
  scope: Schema.String,
})
const Result = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({
      hasNextPage: Schema.Boolean,
      nodes: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  }),
})

async function connect({
  page,
  baseURL,
  choice,
  signIn = "Passkey",
  googleAccount = "Continue as test user",
  clientLabel = "MCP Test",
}: {
  page: Page
  baseURL: string
  choice: "View work" | "View and act"
  signIn?: "Passkey" | "Google"
  googleAccount?: string
  clientLabel?: string
}) {
  const resource = new URL("/mcp", baseURL)
  const unauthenticated = await fetch(resource)
  expect(unauthenticated.status).toBe(401)
  expect(unauthenticated.headers.get("www-authenticate")).toContain(
    `${resource.origin}/.well-known/oauth-protected-resource/mcp`,
  )
  const metadata = Schema.decodeUnknownSync(Metadata)(
    await fetch(
      new URL("/.well-known/oauth-authorization-server", resource),
    ).then((response) => response.json()),
  )
  const callback = new URL("http://127.0.0.1:43877/mcp-test-callback")
  const register = async (name: string) => {
    const response = await fetch(metadata.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [callback.href],
        token_endpoint_auth_method: "none",
      }),
    })
    expect(response.status).toBe(201)
    return Schema.decodeUnknownSync(Registration)(await response.json())
      .client_id
  }
  const name = `${clientLabel} ${choice} ${randomBytes(6).toString("hex")}`
  const clientId = await register(name)
  const requestToken = (form: Record<string, string>) =>
    fetch(metadata.token_endpoint, {
      method: "POST",
      body: new URLSearchParams({ client_id: clientId, ...form }),
    })
  const renew = (tokens: typeof Tokens.Type, scope?: string) =>
    requestToken({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      ...(scope ? { scope } : {}),
    })
  const authorizeClient = async ({
    reconnecting = false,
    browserPage = page,
  }: {
    reconnecting?: boolean
    browserPage?: Page
  } = {}) => {
    const verifier = random()
    const state = random()
    const authorize = new URL(metadata.authorization_endpoint)
    authorize.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      redirect_uri: callback.href,
      resource: resource.href,
      state,
    }).toString()
    const isCallback = (url: URL) =>
      url.origin === callback.origin && url.pathname === callback.pathname
    await browserPage.route(isCallback, (route) =>
      route.fulfill({ body: "Connected" }),
    )
    try {
      await browserPage.goto(authorize.href)
      const consent = browserPage.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === "/mcp/consent",
      )
      if (signIn === "Passkey") {
        await browserPage
          .getByRole("button", { name: "Sign in with Passkey", exact: true })
          .click()
      } else {
        await browserPage.getByRole("button", { name: /Google/ }).click()
        await browserPage
          .getByRole("button", { name: googleAccount, exact: true })
          .click()
      }
      expect((await consent).status()).toBe(200)
      await expect(
        browserPage.getByRole("heading", {
          name: `${reconnecting ? "Reconnect" : "Connect"} ${name} to Process Focus?`,
        }),
      ).toBeVisible()
      await expect(
        browserPage.getByText(`Environment: ${resource.origin}`),
      ).toBeVisible()
      if (!reconnecting) {
        await browserPage
          .getByRole("radio", { name: choice, exact: true })
          .check()
      } else {
        await expect(
          browserPage.getByText(`Existing access: ${choice}.`, {
            exact: false,
          }),
        ).toBeVisible()
        await expect(browserPage.getByRole("radio")).toHaveCount(0)
      }
      const submitted = browserPage.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/mcp/consent",
      )
      await browserPage
        .getByRole("button", {
          name: reconnecting ? "Reconnect" : "Allow access",
        })
        .click()
      const response = await submitted
      expect(response.status()).toBe(303)
      const location = response.headers()["location"]
      if (!location) throw new Error("Expected the client callback")
      const returned = new URL(location)
      expect(isCallback(returned)).toBe(true)
      const code = returned.searchParams.get("code")
      if (returned.searchParams.get("state") !== state || !code)
        throw new Error("Expected a state-bound OAuth code")
      return {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: callback.href,
        resource: resource.href,
        client_id: clientId,
      }
    } finally {
      await browserPage.unroute(isCallback)
    }
  }
  const exchange = await authorizeClient()
  return {
    resource,
    name,
    register,
    authorizeClient,
    exchange,
    requestToken,
    renew,
  }
}

const readTokens = async (response: Response) => {
  expect(response.status).toBe(200)
  return Schema.decodeUnknownSync(Tokens)(await response.json())
}

const rpc = (resource: URL, tokens: typeof Tokens.Type, message: object) =>
  fetch(resource, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...message }),
  })

const callTool =
  (resource: URL, tokens: typeof Tokens.Type) => (name: string, args: object) =>
    rpc(resource, tokens, {
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    })

async function initializeMcpTransport(
  { resource, name }: Awaited<ReturnType<typeof connect>>,
  tokens: typeof Tokens.Type,
) {
  const send = (message: object) => rpc(resource, tokens, message)
  const initialized = await send({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      clientInfo: { name, version: "1" },
      capabilities: {},
    },
  })
  expect(initialized.status).toBe(200)
  expect(await initialized.json()).toMatchObject({
    result: { capabilities: { tools: {} } },
  })
  expect((await send({ method: "notifications/initialized" })).status).toBe(202)
  expect(
    await (await send({ id: 2, method: "tools/list" })).json(),
  ).toMatchObject({
    result: {
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "list_my_todos" }),
        expect.objectContaining({ name: "inspect_todo_form" }),
        ...(tokens.scope === "work:read work:act"
          ? [expect.objectContaining({ name: "complete_todo" })]
          : []),
      ]),
    },
  })
  const unknown = await send({
    id: 3,
    method: "tools/call",
    params: { name: "unknown_tool" },
  })
  expect(await unknown.json()).toMatchObject({ result: { isError: true } })
  let id = 3
  return async (name: string, args: object = {}) => {
    const response = await send({
      id: ++id,
      method: "tools/call",
      params: { name, arguments: args },
    })
    expect(response.status).toBe(200)
    return response
  }
}

async function initializeMcp(
  client: Awaited<ReturnType<typeof connect>>,
  tokens: typeof Tokens.Type,
): Promise<(name: string, args?: object) => Promise<unknown>> {
  const call = await initializeMcpTransport(client, tokens)
  return async (name, args) => (await call(name, args)).json()
}

export async function connectMcp(
  options: Parameters<typeof connect>[0],
): Promise<(name: string, args?: object) => Promise<unknown>> {
  const call = await connectMcpTransport(options)
  return async (name, args) => (await call(name, args)).json()
}

export async function connectMcpTransport(
  options: Parameters<typeof connect>[0],
) {
  const client = await connect(options)
  const tokens = await readTokens(await client.requestToken(client.exchange))
  expect(tokens.scope).toBe(
    options.choice === "View work" ? "work:read" : "work:read work:act",
  )
  return initializeMcpTransport(client, tokens)
}

async function discover(
  client: Awaited<ReturnType<typeof connect>>,
  tokens: typeof Tokens.Type,
): Promise<string[]> {
  const call = await initializeMcp(client, tokens)
  const ids: string[] = []
  for (let page = 1; ; page++) {
    const result = Schema.decodeUnknownSync(Result)(
      await call("list_my_todos", { page }),
    ).result.structuredContent
    ids.push(...result.nodes.map((todo) => todo.id))
    if (!result.hasNextPage) return ids
  }
}

Then(
  "MCP renewal and disconnect leave the other client and Dashboard session working",
  async ({ page, baseURL, scenarioState, passkeyUser }) => {
    if (!baseURL) throw new Error("Dashboard URL required")
    const todo = journeyFor(scenarioState).todoId
    const first = await connect({ page, baseURL, choice: "View work" })
    const { resource, exchange, register, requestToken, renew } = first
    const otherClient = await register("Other MCP client")
    expect(
      (await requestToken({ ...exchange, client_id: otherClient })).status,
    ).toBe(400)
    expect(
      (
        await requestToken({
          ...exchange,
          resource: new URL("/other/mcp", baseURL).href,
        })
      ).status,
    ).toBe(400)
    expect(
      (await requestToken({ ...exchange, code_verifier: random() })).status,
    ).toBe(400)
    const tokens = await readTokens(await requestToken(exchange))
    expect((await requestToken(exchange)).status).toBe(400)
    expect((await renew(tokens, "work:read work:act")).status).toBe(400)
    const renewed = await readTokens(await renew(tokens))
    expect(renewed.scope).toBe("work:read")
    expect(await discover(first, renewed)).toContain(todo)
    const read = callTool(resource, renewed)
    expect(
      await (await read("inspect_todo_form", { todoId: todo })).json(),
    ).toMatchObject({
      result: {
        structuredContent: {
          fields: expect.arrayContaining([
            expect.objectContaining({
              name: "check",
              label: "I approve",
              required: true,
            }),
          ]),
          errors: expect.arrayContaining([
            expect.objectContaining({ field: "check" }),
          ]),
        },
      },
    })
    expect(
      await (
        await read("complete_todo", {
          todoId: todo,
          confirmed: true,
          answers: { check: true },
        })
      ).json(),
    ).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("View work") }],
      },
    })
    expect(await discover(first, renewed)).toContain(todo)

    const otherUser = await signInPersona(
      passkeyUser,
      baseURL,
      "employee-2@example.com",
      true,
    )
    const otherExchange = await first.authorizeClient({
      browserPage: otherUser.page,
    })
    const otherTokens = await readTokens(await requestToken(otherExchange))
    expect(await discover(first, otherTokens)).not.toContain(todo)
    const otherActingClient = await connect({
      page: otherUser.page,
      baseURL,
      choice: "View and act",
    })
    const otherActing = callTool(
      otherActingClient.resource,
      await readTokens(
        await otherActingClient.requestToken(otherActingClient.exchange),
      ),
    )
    for (const name of ["inspect_todo_form", "complete_todo"]) {
      expect(
        await (
          await otherActing(name, {
            todoId: todo,
            answers: { check: true },
            ...(name === "complete_todo" ? { confirmed: true } : {}),
          })
        ).json(),
      ).toMatchObject({
        result: {
          isError: true,
          content: [{ text: expect.stringContaining("did not authorize") }],
        },
      })
    }

    const second = await connect({ page, baseURL, choice: "View and act" })
    const secondTokens = await readTokens(
      await second.requestToken(second.exchange),
    )
    await page.goto("/mcp/connections")
    await page
      .getByRole("button", { name: `Disconnect ${first.name}`, exact: true })
      .click()
    await expect(
      page.getByRole("button", {
        name: `Disconnect ${first.name}`,
        exact: true,
      }),
    ).toHaveCount(0)
    const list = { id: 1, method: "tools/list" }
    expect((await rpc(resource, tokens, list)).status).toBe(401)
    expect((await rpc(resource, renewed, list)).status).toBe(401)
    expect(await (await renew(renewed)).json()).toEqual({
      error: "invalid_grant",
    })
    const otherRenewed = await readTokens(await renew(otherTokens))
    expect((await rpc(resource, otherRenewed, list)).status).toBe(200)
    expect(await discover(second, secondTokens)).toContain(todo)
    await page.goto("/processes")
    await expect(
      page.getByRole("heading", { name: "Processes", exact: true }),
    ).toBeVisible()
  },
)

Then(
  "an acting MCP client completes that approval only after confirmation and recovers a lost reply",
  async ({ page, baseURL, scenarioState }) => {
    if (!baseURL) throw new Error("Dashboard URL required")
    const { todoId } = journeyFor(scenarioState)
    const client = await connect({ page, baseURL, choice: "View and act" })
    const tokens = await readTokens(await client.requestToken(client.exchange))
    const act = callTool(client.resource, tokens)
    const submit = { todoId, confirmed: true, answers: { check: true } }
    expect(
      await (
        await act("complete_todo", { todoId, answers: submit.answers })
      ).json(),
    ).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("explicit confirmation") }],
      },
    })

    const invalid = { todoId, confirmed: true, answers: { check: false } }
    expect(await (await act("complete_todo", invalid)).json()).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          status: "rejected",
          errors: expect.arrayContaining([
            expect.objectContaining({ field: "check" }),
          ]),
        },
      },
    })
    expect(await discover(client, tokens)).toContain(todoId)

    const lostReply = await act("complete_todo", submit)
    expect(lostReply.status).toBe(200)
    await lostReply.body?.cancel()
    expect(await discover(client, tokens)).not.toContain(todoId)
    expect(await (await act("complete_todo", invalid)).json()).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("could not confirm") }],
      },
    })
    const recovered = await (await act("complete_todo", submit)).json()
    const receipt = Schema.decodeUnknownSync(
      Schema.Struct({
        result: Schema.Struct({
          structuredContent: Schema.Struct({
            status: Schema.Literal("completed"),
            executionUrl: Schema.String,
            executionId: Schema.String,
          }),
        }),
      }),
    )(recovered).result.structuredContent
    expect(new URL(receipt.executionUrl).pathname).toBe(
      `/executions/${receipt.executionId}`,
    )
    await page.goto("/to-dos")
  },
)

Then(
  "MCP renewal stops at the SSO deadline and fresh sign-in restores the same access",
  async ({ page, baseURL }) => {
    if (!baseURL) throw new Error("Dashboard URL required")
    const client = await connect({
      page,
      baseURL,
      choice: "View and act",
      signIn: "Google",
    })
    const initial = await readTokens(await client.requestToken(client.exchange))
    expect(initial.expires_in).toBeLessThanOrEqual(60)
    const renewalAt = Date.now()
    const renewed = await readTokens(await client.renew(initial))
    const list = { id: 1, method: "tools/list" }
    expect((await rpc(client.resource, renewed, list)).status).toBe(200)
    expect(renewed.expires_in).toBeLessThanOrEqual(initial.expires_in)
    await expect
      .poll(async () => (await rpc(client.resource, renewed, list)).status, {
        timeout: Math.max(
          1,
          renewalAt + (initial.expires_in + 3) * 1000 - Date.now(),
        ),
        intervals: [1000],
      })
      .toBe(401)
    expect(await (await client.renew(renewed)).json()).toEqual({
      error: "invalid_grant",
    })
    const exchange = await client.authorizeClient({ reconnecting: true })
    const reconnected = await readTokens(await client.requestToken(exchange))
    expect(reconnected.scope).toBe(initial.scope)
    expect((await rpc(client.resource, reconnected, list)).status).toBe(200)
  },
)

async function signInPersona(
  passkeyUser: (
    options: Omit<PasskeyUserOptions, "workerIndex">,
  ) => Promise<PasskeyUser>,
  baseURL: string,
  email: string,
  provisionOnly = false,
): Promise<PasskeyUser> {
  const account = dashboardAccount(baseURL, email)
  const user = await passkeyUser({
    baseURL,
    graphqlEndpoint: getEffectiveGraphqlEndpoint(),
    account: account.account,
    saveCredentials: account.save,
    invite: dashboardRegistrationLink,
    provisionOnly,
  })
  account.save(await user.virtualCredentials())
  return user
}

async function startPurchase(user: PasskeyUser): Promise<string> {
  const result = await user.graphql(
    `
    mutation($item: String!) {
      startFinancePurchaseRequest(input: {item: $item, value: "750"}) { executionId }
    }
  `,
    { item: `MCP progress ${randomUUID()}` },
  )
  return Schema.decodeUnknownSync(
    Schema.Struct({
      data: Schema.Struct({
        startFinancePurchaseRequest: Schema.Struct({
          executionId: Schema.String,
        }),
      }),
    }),
  )(result).data.startFinancePurchaseRequest.executionId
}

Then(
  "read-only MCP clients can page and inspect only their visible purchase Executions",
  async ({ passkeyUser, baseURL }) => {
    if (!baseURL) throw new Error("Dashboard URL required")
    const signIn = (email: string) => signInPersona(passkeyUser, baseURL, email)
    const owner = await signIn("employee@example.com")
    const other = await signIn("employee-2@example.com")
    const manager = await signInPersona(
      passkeyUser,
      baseURL,
      "finance-manager@example.com",
      true,
    )
    const first = await startPurchase(owner)
    const hidden = await startPurchase(other)
    const last = await startPurchase(owner)
    const filter = {
      processPath: "/finance/purchase-request",
      status: "Running",
    }

    {
      const call = await connectMcp({
        page: owner.page,
        baseURL,
        choice: "View work",
      })
      const list = async (args: object) =>
        Schema.decodeUnknownSync(Result)(await call("list_executions", args))
          .result.structuredContent
      expect(await list({ ...filter, page: 1, limit: 1 })).toEqual({
        nodes: [{ id: last }],
        hasNextPage: true,
      })
      expect((await list({ ...filter, page: 2, limit: 1 })).nodes).toEqual([
        { id: first },
      ])
      expect(
        (await list({ ...filter, status: "Completed" })).nodes,
      ).not.toContainEqual({ id: last })
      expect(
        (await list({ ...filter, processPath: "/hr/on-boarding" })).nodes,
      ).not.toContainEqual({ id: last })
      const outcome = Schema.decodeUnknownSync(
        Schema.Struct({ result: Schema.Record(Schema.String, Schema.Unknown) }),
      )
      const denied = outcome(await call("get_execution", { id: hidden })).result
      expect(denied).toMatchObject({ isError: true })
      expect(denied).toEqual(
        outcome(await call("get_execution", { id: randomUUID() })).result,
      )
      const detail = () => call("get_execution", { id: last })
      await expect.poll(detail).toMatchObject({
        result: {
          structuredContent: {
            id: last,
            status: "Running",
            currentSteps: [
              expect.objectContaining({
                name: "Approve purchase request",
                status: "Waiting",
              }),
            ],
            link: new URL(`/executions/${last}`, baseURL).href,
          },
        },
      })
      const todos = Schema.decodeUnknownSync(
        Schema.Struct({
          result: Schema.Struct({
            structuredContent: Schema.Struct({
              nodes: Schema.Array(
                Schema.Struct({ processExecutionId: Schema.String }),
              ),
            }),
          }),
        }),
      )(await call("list_my_todos"))
      expect(todos.result.structuredContent.nodes).not.toContainEqual({
        processExecutionId: last,
      })
      expect(
        await owner.graphql(
          `query($id: ID!) { execution(id: $id) { canAbandonExecution canRestartExecution } }`,
          { id: last },
        ),
      ).toMatchObject({
        data: {
          execution: {
            canAbandonExecution: false,
            canRestartExecution: false,
          },
        },
      })
    }

    {
      const call = await connectMcp({
        page: manager.page,
        baseURL,
        choice: "View work",
      })
      dashboardAccount(baseURL, manager.email).save(
        await manager.virtualCredentials(),
      )
      const detail = () => call("get_execution", { id: hidden })
      await expect.poll(detail).toMatchObject({
        result: {
          structuredContent: {
            id: hidden,
            status: "Running",
            timeline: expect.arrayContaining([
              expect.objectContaining({
                name: "Submit purchase request",
                status: "Completed",
                completedAt: expect.any(String),
              }),
              expect.objectContaining({
                name: "Approve purchase request",
                status: "Waiting",
                startedAt: expect.any(String),
              }),
            ]),
          },
        },
      })
      expect(await call("list_executions", filter)).toMatchObject({
        result: {
          structuredContent: {
            nodes: expect.arrayContaining([
              expect.objectContaining({ id: hidden }),
            ]),
          },
        },
      })
    }
  },
)

Then(
  "a read-only MCP client reports the parallel onboarding Steps without an estimate",
  async ({ page, baseURL, scenarioState }) => {
    if (!baseURL) throw new Error("Dashboard URL required")
    const id = Schema.decodeUnknownSync(Schema.String)(
      scenarioState.get("withoutWaitingExecution"),
    )
    const call = await connectMcp({
      page,
      baseURL,
      choice: "View work",
    })
    const detail = () => call("get_execution", { id })
    const result = Schema.Struct({
      result: Schema.Struct({
        structuredContent: Schema.Record(Schema.String, Schema.Unknown),
      }),
    })
    await expect.poll(detail).toMatchObject({
      result: {
        structuredContent: {
          id,
          currentSteps: expect.arrayContaining([
            expect.objectContaining({
              name: "Assign a desk/office",
              status: "Waiting",
            }),
            expect.objectContaining({
              name: "Assign ID badge",
              status: "Waiting",
            }),
          ]),
        },
      },
    })
    expect(
      Schema.decodeUnknownSync(result)(await detail()).result.structuredContent,
    ).not.toHaveProperty("estimatedCompletionAt")
  },
)

async function connectProcessTools(options: Parameters<typeof connect>[0]) {
  return connectMcpTransport({
    ...options,
    clientLabel: "MCP Process Start Test",
  })
}

Then(
  "MCP can inspect, start and recover an authorised Process without duplicating it",
  async ({ page, passkeyUser, baseURL }) => {
    if (!baseURL) throw new Error("Dashboard URL required")
    const view = await connectProcessTools({
      page,
      baseURL,
      choice: "View work",
    })
    const read = async (
      call: Awaited<ReturnType<typeof connectProcessTools>>,
      name: string,
      args: object,
    ) => (await call(name, args)).json()
    const catalog = Schema.decodeUnknownSync(
      Schema.Struct({
        result: Schema.Struct({
          structuredContent: Schema.Struct({
            nodes: Schema.Array(
              Schema.Struct({ path: Schema.String, name: Schema.String }),
            ),
            hasNextPage: Schema.Boolean,
          }),
        }),
      }),
    )(await read(view, "list_startable_processes", {})).result.structuredContent
    expect(catalog.hasNextPage).toBe(false)
    const processPath = catalog.nodes.find(
      (node) => node.name === "Start Request Demo",
    )?.path
    expect(processPath).toBeDefined()
    expect(catalog.nodes.map((node) => node.name)).not.toContain(
      "Hello System Start",
    )

    const form = async (input: object) =>
      read(view, "get_process_start_form", { processPath, input })
    await expect(form({})).resolves.toMatchObject({
      result: {
        structuredContent: {
          defaultValues: { kind: "standard" },
          fields: [
            expect.objectContaining({
              path: ["kind"],
              label: "Request type",
              choices: expect.arrayContaining([
                { value: "exception", label: "Exception request" },
              ]),
            }),
          ],
          errors: [],
        },
      },
    })
    await expect(form({ kind: "exception" })).resolves.toMatchObject({
      result: {
        structuredContent: {
          fields: expect.arrayContaining([
            expect.objectContaining({ path: ["reason"], required: true }),
          ]),
          errors: [expect.objectContaining({ field: "reason" })],
        },
      },
    })

    const executionId = `pex-${randomUUID()}`
    const submission = {
      processPath,
      executionId,
      input: { kind: "exception", reason: "MCP journey" },
    }
    await expect(
      read(view, "start_process", { ...submission, confirmed: true }),
    ).resolves.toMatchObject({
      result: { isError: true },
    })
    const act = await connectProcessTools({
      page,
      baseURL,
      choice: "View and act",
    })
    await expect(read(act, "start_process", submission)).resolves.toMatchObject(
      { result: { isError: true } },
    )
    await expect(
      read(act, "start_process", { ...submission, input: {}, confirmed: true }),
    ).resolves.toMatchObject({
      result: {
        structuredContent: {
          status: "confirmation_required",
          defaultValues: { kind: "standard" },
          unconfirmedDefaults: ["kind"],
        },
      },
    })
    const forbiddenPath = "/operations/hello-system-start"
    await expect(
      read(act, "start_process", {
        ...submission,
        processPath: forbiddenPath,
        input: {},
        confirmed: true,
      }),
    ).resolves.toMatchObject({
      result: { isError: true },
    })
    await expect(
      read(act, "start_process", {
        ...submission,
        input: { kind: "exception" },
        confirmed: true,
      }),
    ).resolves.toMatchObject({
      result: {
        structuredContent: {
          status: "invalid",
          errors: [expect.objectContaining({ field: "reason" })],
        },
      },
    })
    for (const kind of ["region", "optional-region"]) {
      await expect(
        read(act, "start_process", {
          ...submission,
          input: { kind },
          confirmed: true,
        }),
      ).resolves.toMatchObject({
        result: {
          structuredContent: {
            status: "dashboard_required",
            dashboardUrl: `${baseURL}/processes/start${processPath}/Request`,
          },
        },
      })
    }
    await expect(
      read(act, "start_process", {
        ...submission,
        input: { kind: "items" },
        confirmed: true,
      }),
    ).resolves.toMatchObject({
      result: {
        structuredContent: {
          status: "dashboard_required",
          dashboardUrl: `${baseURL}/processes/start${processPath}/Request`,
        },
      },
    })
    await expect(
      read(act, "start_process", {
        ...submission,
        input: { kind: "attachment" },
        confirmed: true,
      }),
    ).resolves.toMatchObject({
      result: { structuredContent: { status: "dashboard_required" } },
    })
    await expect(
      read(act, "start_process", {
        ...submission,
        input: { kind: "attachment", attachment: "invented-file-id" },
        confirmed: true,
      }),
    ).resolves.toMatchObject({
      result: {
        structuredContent: {
          status: "dashboard_required",
          dashboardUrl: `${baseURL}/processes/start${processPath}/Request`,
        },
      },
    })

    const executions = async () => {
      const response = await page.request.post(getEffectiveGraphqlEndpoint(), {
        headers: { Origin: new URL(baseURL).origin },
        data: {
          query:
            "query($path: String!) { executions(processPath: $path) { nodes { id } hasNextPage } }",
          variables: { path: processPath },
        },
      })
      const result = await response.json()
      expect(result).not.toHaveProperty("errors")
      return Schema.decodeUnknownSync(
        Schema.Struct({
          data: Schema.Struct({
            executions: Schema.Struct({
              nodes: Schema.Array(Schema.Struct({ id: Schema.String })),
              hasNextPage: Schema.Boolean,
            }),
          }),
        }),
      )(result).data.executions
    }
    const other = await passkeyUser({
      baseURL,
      graphqlEndpoint: getEffectiveGraphqlEndpoint(),
      account: { kind: "register", email: "mcp-start-peer@example.com" },
      invite: dashboardRegistrationLink,
    })
    const otherAct = await connectProcessTools({
      page: other.page,
      baseURL,
      choice: "View and act",
    })
    expect(await executions()).toMatchObject({ nodes: [], hasNextPage: false })

    // The transport receives headers but drops the body without giving the
    // client the tool result. The client kept the ID and answers before POST.
    const lost = await act("start_process", { ...submission, confirmed: true })
    expect(lost.ok).toBe(true)
    await lost.body?.cancel()
    expect(await executions()).toEqual({
      nodes: [{ id: executionId }],
      hasNextPage: false,
    })

    await expect(
      read(act, "recover_process_start", {
        ...submission,
        input: { kind: "exception", reason: "Different answers" },
      }),
    ).resolves.toMatchObject({
      result: { structuredContent: { status: "unknown" } },
    })
    await expect(
      read(otherAct, "recover_process_start", submission),
    ).resolves.toMatchObject({
      result: { structuredContent: { status: "unknown" } },
    })
    await expect(
      read(act, "recover_process_start", {
        ...submission,
        processPath: processPath?.replace(/^\//, ""),
      }),
    ).resolves.toMatchObject({
      result: {
        structuredContent: {
          status: "started",
          executionId,
          executionUrl: `${baseURL}/executions/${executionId}`,
        },
      },
    })
    expect(await executions()).toEqual({
      nodes: [{ id: executionId }],
      hasNextPage: false,
    })
  },
)
