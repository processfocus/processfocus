/// <reference lib="dom" />

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { type BrowserContext, type Page, chromium } from "@playwright/test"
import { Option, Schema } from "effect"

// Visible interactions and screenshots use agent-browser. CDP is used only for
// the genuine virtual authenticator, reading issued HTTP-only cookies and passive
// observation of real app WebSockets. No network mocks or polling fallback.
const handoffPath = process.argv[2]
const cliMode = process.argv.includes("--cli")
const issuance = process.argv.includes("--issuance")
const repoRoot = resolve(import.meta.dir, "../../..")
let cliChild: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
const evidence = Schema.decodeUnknownSync(Schema.NonEmptyString)(
  process.argv[3],
)
const viewport = Schema.decodeUnknownSync(
  Schema.Literal("both", "desktop", "mobile"),
)(
  process.argv
    .slice(4)
    .find(
      (argument) =>
        !["--cli", "--administration", "--issuance"].includes(argument),
    ) ?? "both",
)
const widths =
  viewport === "mobile" ? [390] : viewport === "desktop" ? [1440] : [1440, 390]
if (!handoffPath)
  throw new Error("Expected private handoff and temporary evidence directory")
const relativeHandoff = relative(
  realpathSync(tmpdir()),
  realpathSync(handoffPath),
)
if (relativeHandoff.startsWith("..") || isAbsolute(relativeHandoff))
  throw new Error("Handoff must be temporary")
const relativeEvidence = relative(realpathSync(tmpdir()), resolve(evidence))
if (relativeEvidence.startsWith("..") || isAbsolute(relativeEvidence))
  throw new Error("Evidence must be temporary")
const handoff = Schema.decodeUnknownSync(
  Schema.Struct({
    registrationUrl: Schema.String,
    issuer: Schema.String,
    frontend: Schema.String,
    graphql: Schema.String,
    frontendJwt: Schema.String,
    policyPath: Schema.String,
    runtimeRoot: Schema.String,
    auditPath: Schema.String,
    reviewerRoleId: Schema.String,
    administratorRegistrationUrl: Schema.optional(Schema.String),
    control: Schema.optional(Schema.String),
    controlToken: Schema.optional(Schema.String),
    issuanceProbe: Schema.optional(Schema.Boolean),
  }),
)(JSON.parse(readFileSync(handoffPath, "utf8")))
for (const url of [
  handoff.registrationUrl,
  handoff.issuer,
  handoff.frontend,
  handoff.graphql,
  ...[handoff.control, handoff.administratorRegistrationUrl].filter(
    (url) => url !== undefined,
  ),
]) {
  if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname))
    throw new Error("Local probe only")
}
mkdirSync(dirname(resolve(evidence)), { recursive: true })
// Fail even for an empty existing directory rather than mixing run evidence.
mkdirSync(evidence)
const cliRoot = mkdtempSync(join(tmpdir(), "pf-delegation-cli-"))
const credentialsPath = join(cliRoot, "credentials.json")
const browserUrlPath = join(cliRoot, "browser-url")
const owner = `wi${cliMode ? 2901 : 2902}-owner-${process.pid}`
const agent = `wi${cliMode ? 2901 : 2902}-agent-${process.pid}`
const administration = process.argv.includes("--administration")
const administrator = `wi2900-administrator-${process.pid}`
const delegatedAdministrator = `wi2900-delegated-administrator-${process.pid}`
const unrelated = `wi2900-unrelated-${process.pid}`
const checks: { check: string; at: string; detail: unknown }[] = []
const listSchema = Schema.Struct({
  owner: Schema.Struct({ userId: Schema.String, email: Schema.String }),
  canIssue: Schema.Boolean,
  issuanceDeadline: Schema.NullOr(Schema.String),
  delegations: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      generationId: Schema.String,
      expiresAt: Schema.String,
      lastUsedAt: Schema.NullOr(Schema.String),
      status: Schema.String,
      allowedActions: Schema.Struct({
        rename: Schema.Boolean,
        replace: Schema.Boolean,
        revoke: Schema.Boolean,
      }),
    }),
  ),
})
const failedHandoffExitCodes: number[] = []
const graphqlHttpFailures = new Set<number>()
let stage = "bootstrap"
let cleanupPromise: Promise<void> | undefined
let activeCommand: Promise<number> | undefined
class ProbeFailure extends Error {}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ProbeFailure(message)
}
function record(check: string, detail: unknown = true) {
  checks.push({ check, at: new Date().toISOString(), detail })
  console.info(`PASS ${check}`)
  writeFileSync(
    join(
      evidence,
      issuance
        ? "issuance-results.json"
        : administration
          ? "administration-results.json"
          : "joined-lifecycle-results.json",
    ),
    JSON.stringify(checks, null, 2),
  )
}
async function ab(session: string, ...commands: string[][]) {
  assert(
    !cleanupPromise || commands.every((command) => command[0] === "close"),
    "Probe is stopping",
  )
  const child = Bun.spawn(
    ["agent-browser", "--session", session, "batch", "--bail", "--json"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  activeCommand = child.exited
  child.stdin.write(JSON.stringify(commands))
  child.stdin.end()
  const output = await new Response(child.stdout).text()
  await new Response(child.stderr).text()
  const exit = await child.exited
  if (exit !== 0) {
    const results = Schema.decodeUnknownOption(
      Schema.Array(Schema.Struct({ success: Schema.Boolean })),
    )(JSON.parse(output))
    if (Option.isSome(results))
      console.error(
        `Failed batch command index: ${results.value.findIndex((result) => !result.success)}`,
      )
  }
  assert(
    exit === 0,
    `agent-browser failed during ${stage}: ${commands.map((c) => c[0]).join(", ")}`,
  )
  // Never print command output: disclosure snapshots and auth URLs are private.
  return output
}
const envelope = Schema.Array(
  Schema.Struct({ success: Schema.Boolean, result: Schema.Unknown }),
)
async function evaluate(session: string, expression: string): Promise<unknown> {
  const results = Schema.decodeUnknownSync(envelope)(
    JSON.parse(await ab(session, ["eval", expression])),
  )
  const data = results[0]?.result
  assert(
    typeof data === "object" && data !== null && "result" in data,
    "Missing browser evaluation",
  )
  return data.result
}
async function shot(session: string, filename: string) {
  if (cliMode) return
  await evaluate(
    session,
    "document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))",
  )
  assert(
    await evaluate(
      session,
      "!document.querySelector('code[data-private]') && ![...document.querySelectorAll('input[type=password]')].some(x => x.value) && !/pfds_[A-Za-z0-9_-]{43}/.test(document.body.innerText)",
    ),
    "Screenshot refused: secret visible",
  )
  await ab(session, ["screenshot", "--full", join(evidence, filename)])
}
async function metadata(delegationId: string, session = owner) {
  return Schema.decodeUnknownSync(
    Schema.Struct({
      id: Schema.String,
      generation: Schema.String,
      created: Schema.String,
      expires: Schema.String,
    }),
  )(
    await evaluate(
      session,
      `(() => { const cards = [...document.querySelectorAll('article')].filter(card => card.dataset.tokenId === ${JSON.stringify(delegationId)}); if (cards.length !== 1) return null; const card = cards[0]; const times = [...card.querySelectorAll('dd time')]; return {id:card.dataset.tokenId,generation:card.dataset.generationId,created:times[0]?.dateTime,expires:times[1]?.dateTime}; })()`,
    ),
  )
}
async function takeSecret(ownerSession = owner) {
  const owner = ownerSession
  await ab(owner, ["wait", "code[data-private]"])
  const secret = await evaluate(
    owner,
    "document.querySelector('code[data-private]').textContent",
  )
  assert(
    typeof secret === "string" && /^pfds_[A-Za-z0-9_-]{43}$/.test(secret),
    "Invalid disclosure",
  )
  try {
    await ab(
      owner,
      ["find", "role", "button", "click", "--name", "Copy secret", "--exact"],
      ["wait", "--text", "Secret copied."],
    )
    assert(
      await evaluate(
        owner,
        "navigator.clipboard.readText().then(value => value === document.querySelector('code[data-private]')?.textContent)",
      ),
      "Clipboard did not match the one-time secret",
    )
    record("One-time secret copied through the real clipboard")
  } finally {
    await evaluate(owner, "navigator.clipboard.writeText('')")
  }
  await ab(owner, [
    "find",
    "role",
    "button",
    "click",
    "--name",
    "I have saved it",
    "--exact",
  ])
  assert(
    await evaluate(owner, "!document.querySelector('code[data-private]')"),
    "Disclosure did not dismiss",
  )
  return secret
}
async function login(secret: string, accepted: boolean, session = agent) {
  await ab(
    session,
    ["open", `${handoff.frontend}/api/auth/logout`],
    ["open", `${handoff.frontend}/login`],
    ["wait", "summary"],
    ["click", "summary"],
  )
  await ab(
    session,
    ["fill", "input[type=password]", secret],
    [
      "find",
      "role",
      "button",
      "click",
      "--name",
      "Log in with a secret",
      "--exact",
    ],
  )
  if (accepted) {
    try {
      await ab(
        session,
        ["wait", "--fn", "location.pathname === '/'"],
        [
          "wait",
          '[data-testid="header-profile-button"][aria-label*="acting on behalf of"]',
        ],
      )
    } catch (error) {
      const chunkError = await evaluate(
        session,
        "document.body.innerText.includes('ChunkLoadError') || !!document.querySelector('nextjs-portal')?.shadowRoot?.textContent.includes('ChunkLoadError')",
      )
      if (!chunkError) throw error
      await ab(
        session,
        ["reload"],
        ["wait", "--fn", "location.pathname === '/'"],
        [
          "wait",
          '[data-testid="header-profile-button"][aria-label*="acting on behalf of"]',
        ],
      )
      record(
        "Recovered Next development chunk reload after successful secret exchange",
      )
    }
  } else {
    await ab(session, ["wait", "--text", "Unable to log in"])
    assert(
      await evaluate(
        session,
        "location.pathname === '/login' && document.querySelector('[role=alert]')?.textContent.includes('Unable to log in')",
      ),
      "Old secret unexpectedly logged in",
    )
    // Clear the password before any screenshot, even though it is masked.
    await ab(session, ["fill", "input[type=password]", ""])
  }
}
async function request(
  path: string,
  body: BodyInit,
  headers: Record<string, string>,
) {
  return fetch(path, { method: "POST", body, headers, redirect: "manual" })
}
const startQuery =
  'mutation { startDelegatedreview(input: {request: "Accepted before owner revocation"}) { executionId } }'
async function api(
  access: string,
  query = "query { pullExecution(limit: 10) { documents { id } } }",
) {
  const response = await request(handoff.graphql, JSON.stringify({ query }), {
    authorization: `Bearer ${access}`,
    "content-type": "application/json",
  })
  const body = Schema.decodeUnknownSync(
    Schema.Struct({
      data: Schema.optional(
        Schema.NullOr(
          Schema.Record({ key: Schema.String, value: Schema.Unknown }),
        ),
      ),
      errors: Schema.optional(
        Schema.Array(Schema.Struct({ message: Schema.String })),
      ),
    }),
  )(await response.json())
  return {
    status: response.status,
    accepted: response.ok && body.data != null && !body.errors,
    ...body,
  }
}
async function issuerRefresh(refresh: string) {
  return request(
    `${handoff.issuer}/oauth/token`,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
    }),
    {
      authorization: `Bearer ${handoff.frontendJwt}`,
      "content-type": "application/x-www-form-urlencoded",
    },
  )
}
const connections: Awaited<ReturnType<typeof chromium.connectOverCDP>>[] = []
async function cliRequest(query: string) {
  const child = Bun.spawn(
    ["bun", join(import.meta.dir, "delegation-cli-request.mjs")],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PFCLI_CREDENTIALS_PATH: credentialsPath,
        PF_RUNTIME_ROOT: handoff.runtimeRoot,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  child.stdin.write(query)
  child.stdin.end()
  const output = await new Response(child.stdout).text()
  assert((await child.exited) === 0, "CLI API subprocess failed")
  return Schema.decodeUnknownSync(
    Schema.Struct({
      data: Schema.optional(Schema.Unknown),
      error: Schema.optional(Schema.String),
    }),
  )(JSON.parse(output))
}
function observe(context: BrowserContext) {
  const events: {
    page: Page
    executionId: string
    todoId: string
    at: number
    binding: string | undefined
  }[] = []
  const pulls: {
    page: Page
    executionId: string
    binding: string | undefined
    at: number
  }[] = []
  const bindings = new Map<Page, string>()
  const subscriptions = new Set<Page>()
  const navigations = new Map<Page, number>()
  const attach = (page: Page) => {
    page.on("request", (request) => {
      // A new document must establish its own subscription. SPA navigation
      // can retain an existing socket, so do not reset on every URL change.
      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        subscriptions.delete(page)
        bindings.delete(page)
      }
    })
    page.on("response", (response) => {
      const endpoint = new URL(response.url())
      if (
        endpoint.port !== new URL(handoff.graphql).port ||
        endpoint.pathname !== "/graphql"
      )
        return
      if (response.status() >= 400) graphqlHttpFailures.add(response.status())
      const encodedBinding = response.request().headers()[
        "x-pf-session-cache-scope"
      ]
      const binding = encodedBinding
        ? decodeURIComponent(encodedBinding)
        : undefined
      void response
        .json()
        .then((body) => {
          const parsed = Schema.decodeUnknownOption(
            Schema.Struct({
              data: Schema.Struct({
                pullTodo: Schema.Struct({
                  documents: Schema.Array(
                    Schema.Struct({ processExecutionId: Schema.String }),
                  ),
                }),
              }),
            }),
          )(body)
          if (Option.isSome(parsed))
            for (const document of parsed.value.data.pullTodo.documents)
              pulls.push({
                page,
                executionId: document.processExecutionId,
                binding,
                at: response.request().timing().startTime,
              })
        })
        .catch(() => {})
    })
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame())
        navigations.set(page, (navigations.get(page) ?? 0) + 1)
    })
    page.on("websocket", (socket) => {
      let socketBinding: string | undefined
      const endpoint = new URL(socket.url())
      if (
        endpoint.port !== new URL(handoff.graphql).port ||
        endpoint.pathname !== "/graphql"
      )
        return
      socket.on("framesent", ({ payload }) => {
        const binding = Schema.decodeUnknownOption(
          Schema.Struct({
            type: Schema.Literal("connection_init"),
            payload: Schema.Struct({
              sessionCacheScope: Schema.NonEmptyString,
            }),
          }),
        )(JSON.parse(String(payload)))
        if (Option.isSome(binding)) {
          socketBinding = binding.value.payload.sessionCacheScope
          bindings.set(page, binding.value.payload.sessionCacheScope)
        }
        const parsed = Schema.decodeUnknownOption(
          Schema.Struct({
            type: Schema.String,
            payload: Schema.optional(Schema.Struct({ query: Schema.String })),
          }),
        )(JSON.parse(String(payload)))
        if (
          Option.isSome(parsed) &&
          parsed.value.type === "subscribe" &&
          parsed.value.payload?.query.includes("streamTodo")
        )
          subscriptions.add(page)
      })
      socket.on("framereceived", ({ payload }) => {
        // Discard all raw frames, credentials and unrelated data immediately.
        const parsed = Schema.decodeUnknownOption(
          Schema.Struct({
            type: Schema.Literal("next"),
            payload: Schema.Struct({
              data: Schema.Struct({
                streamTodo: Schema.Struct({
                  documents: Schema.Array(
                    Schema.Struct({
                      id: Schema.String,
                      processExecutionId: Schema.String,
                    }),
                  ),
                }),
              }),
            }),
          }),
        )(JSON.parse(String(payload)))
        if (Option.isSome(parsed))
          for (const document of parsed.value.payload.data.streamTodo.documents)
            events.push({
              page,
              executionId: document.processExecutionId,
              todoId: document.id,
              at: Date.now(),
              binding: socketBinding,
            })
      })
    })
  }
  context.pages().forEach(attach)
  context.on("page", attach)
  return { events, pulls, bindings, subscriptions, navigations }
}
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 25_000
  // Only observe in-memory browser events; never fetch/poll business state.
  while (!check() && Date.now() < deadline) await Bun.sleep(50)
  assert(check(), message)
}
function cleanup(): Promise<void> {
  cleanupPromise ??= (async () => {
    // Drain the current batch so it cannot reopen a session after close.
    await activeCommand
    cliChild?.kill()
    for (const browser of connections) await browser.close().catch(() => {})
    for (const session of [
      owner,
      agent,
      administrator,
      delegatedAdministrator,
      unrelated,
    ])
      await ab(session, ["close"]).catch(() => {})
    if (cliMode || administration)
      writeFileSync(handoff.policyPath, "// No additional permits.\n")
    rmSync(cliRoot, { recursive: true, force: true })
  })()
  return cleanupPromise
}
process.on("SIGINT", () => void cleanup().then(() => process.exit(130)))
process.on("SIGTERM", () => void cleanup().then(() => process.exit(143)))
async function connect(session: string) {
  assert(!cleanupPromise, "Probe is stopping")
  const child = Bun.spawn(
    ["agent-browser", "--session", session, "get", "cdp-url", "--json"],
    { stdout: "pipe", stderr: "pipe" },
  )
  activeCommand = child.exited
  const result = Schema.decodeUnknownSync(
    Schema.Struct({ data: Schema.Struct({ cdpUrl: Schema.String }) }),
  )(JSON.parse(await new Response(child.stdout).text()))
  const browser = await chromium.connectOverCDP(result.data.cdpUrl)
  connections.push(browser)
  const context = browser.contexts()[0]
  assert(context, "Browser context missing")
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: handoff.frontend,
  })
  return context
}
async function register(owner: string, registrationUrl: string, email: string) {
  await ab(
    owner,
    ["open", `${handoff.frontend}/login`],
    ["set", "viewport", "1440", "1000"],
  )
  const ownerContext = await connect(owner)
  const page = ownerContext
    .pages()
    .find((page) => page.url().startsWith(handoff.frontend))
  assert(page, "Owner page missing")
  const cdp = await ownerContext.newCDPSession(page)
  await cdp.send("WebAuthn.enable")
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
  stage = "registration navigation"
  await ab(
    owner,
    ["open", registrationUrl],
    ["wait", "--text", "Create passkey"],
  )
  stage = "registration ceremony"
  await ab(
    owner,
    ["find", "role", "button", "click", "--name", "Create passkey", "--exact"],
    ["wait", "--fn", "location.pathname === '/'"],
    ["wait", "--text", email],
  )
  record(
    `Genuine Invitation bootstrap and user-verified resident passkey registration: ${email}`,
  )
  return ownerContext
}
try {
  const ownerContext = await register(
    owner,
    handoff.registrationUrl,
    "lifecycle-owner@example.test",
  )
  const ownerLive = observe(ownerContext)
  await ab(agent, ["open", `${handoff.frontend}/login`])
  const agentContext = await connect(agent)
  const agentLive = observe(agentContext)
  const agentPage = Option.getOrThrow(
    Option.fromNullable(
      agentContext
        .pages()
        .find((candidate) => candidate.url().startsWith(handoff.frontend)),
    ),
  )
  // Attach passive CDP listeners before the new page can initiate a socket.
  const existingOwnerPages = new Set(ownerContext.pages())
  await ab(owner, ["tab", "new", "--label", "subscriber", "about:blank"])
  await until(
    () =>
      ownerContext
        .pages()
        .some((candidate) => !existingOwnerPages.has(candidate)),
    "Human subscriber tab missing",
  )
  const subscriberPage = Option.getOrThrow(
    Option.fromNullable(
      ownerContext
        .pages()
        .find((candidate) => !existingOwnerPages.has(candidate)),
    ),
  )
  await ab(
    owner,
    ["open", `${handoff.frontend}/to-dos`],
    ["wait", "--text", "My To-Dos"],
  )
  await until(
    () => ownerLive.subscriptions.has(subscriberPage),
    "Human Todo subscription was not initiated",
  )
  await ab(owner, ["tab", "t1"])
  async function ownerAccess() {
    const access = (await ownerContext.cookies()).find((cookie) =>
      cookie.name.startsWith("access_token"),
    )?.value
    assert(access, "Human access missing")
    return access
  }
  async function start(access: string, label: string) {
    const result = await api(
      access,
      `mutation { startDelegatedreview(input: {request: ${JSON.stringify(label)}}) { executionId } }`,
    )
    assert(result.accepted, "Event-triggering ordinary work rejected")
    return Schema.decodeUnknownSync(
      Schema.Struct({ executionId: Schema.String }),
    )(result.data?.["startDelegatedreview"]).executionId
  }
  async function liveBeforeInvalidation(width: number, label: string) {
    stage = `${width}: ${label} live delivery`
    await ab(
      agent,
      ["open", `${handoff.frontend}/to-dos`],
      ["wait", "--text", "My To-Dos"],
    )
    await until(
      () =>
        agentLive.subscriptions.has(agentPage) &&
        ownerLive.subscriptions.has(subscriberPage),
      "Real Todo subscriptions were not initiated",
    )
    const navigationCount = agentLive.navigations.get(agentPage)
    const humanNavigationCount = ownerLive.navigations.get(subscriberPage)
    const before = await evaluate(
      agent,
      "[...document.querySelectorAll('article')].filter(x => x.innerText.includes('Review request')).length",
    )
    assert(typeof before === "number", "Todo count missing")
    const executionId = await start(
      await ownerAccess(),
      `${width} ${label} live event`,
    )
    await until(
      () =>
        agentLive.events.some(
          (event) =>
            event.page === agentPage && event.executionId === executionId,
        ),
      "Worker-created Todo did not reach the delegated browser WebSocket",
    )
    await until(
      () =>
        ownerLive.events.some(
          (event) =>
            event.page === subscriberPage && event.executionId === executionId,
        ),
      "Worker-created Todo did not reach the human browser WebSocket",
    )
    await ab(agent, [
      "wait",
      "--fn",
      `[...document.querySelectorAll('article')].filter(x => x.innerText.includes('Review request')).length > ${before}`,
    ])
    assert(
      agentLive.navigations.get(agentPage) === navigationCount &&
        ownerLive.navigations.get(subscriberPage) === humanNavigationCount,
      "Live proof navigated or reloaded a subscriber",
    )
    await shot(agent, `joined-live-${label}-${width}.png`)
    record(
      `${width}: ${label} worker Todo delivered over both browser WebSockets and rendered without reload`,
      { executionId },
    )
    return { navigationCount, humanNavigationCount }
  }
  async function ceased(
    width: number,
    label: string,
    since: number,
    baseline: Awaited<ReturnType<typeof liveBeforeInvalidation>>,
  ) {
    // Test delivery after the maximum propagation bound, not just connection
    // flags. Keep both subscriber documents alive throughout the owner's change.
    await Bun.sleep(Math.max(0, since + 60_000 - Date.now()))
    const triggeredAfterMs = Date.now() - since
    const executionId = await start(
      await ownerAccess(),
      `${width} after ${label}`,
    )
    await until(
      () =>
        ownerLive.events.some(
          (event) =>
            event.page === subscriberPage && event.executionId === executionId,
        ),
      "Independent authorized human stopped receiving worker events",
    )
    await Bun.sleep(2_000)
    const humanEvent = ownerLive.events.find(
      (event) =>
        event.page === subscriberPage && event.executionId === executionId,
    )
    assert(humanEvent, "Matching human Todo event missing")
    // Both desktop cards and mobile rows expose the actual Todo ID in the
    // action URL; the fixture's repeated title does not identify new work.
    const todoInDom = `[...document.querySelectorAll('a[href]')].some(link => new URL(link.href).searchParams.get('todoId') === ${JSON.stringify(humanEvent.todoId)})`
    await ab(owner, ["tab", "subscriber"], ["wait", "--fn", todoInDom])
    assert(
      !(await evaluate(agent, todoInDom)),
      "Invalid generation rendered the newly unauthorized Todo",
    )
    assert(
      !agentLive.events.some((event) => event.executionId === executionId),
      "Invalid generation received a newly unauthorized Todo",
    )
    assert(
      !agentLive.pulls.some((pull) => pull.executionId === executionId),
      "Invalid generation received the newly unauthorized Todo over HTTP pull",
    )
    assert(
      agentLive.navigations.get(agentPage) === baseline.navigationCount &&
        ownerLive.navigations.get(subscriberPage) ===
          baseline.humanNavigationCount,
      "Cessation proof navigated or reloaded a subscriber",
    )
    await shot(agent, `joined-ceased-${label}-${width}.png`)
    await shot(owner, `joined-human-continues-${label}-${width}.png`)
    await ab(owner, ["tab", "t1"])
    record(
      `${width}: ${label} new worker event reaches human but not still-open invalid agent`,
      {
        executionId,
        todoId: humanEvent.todoId,
        humanDomPresent: true,
        agentDomPresent: false,
        agentWebsocketReceived: false,
        agentHttpReceived: false,
        triggeredAfterMs,
        observationMs: 2000,
      },
    )
    return executionId
  }
  async function credentials(context = agentContext) {
    const cookies = await context.cookies()
    const access = cookies.find((c) => c.name.startsWith("access_token"))?.value
    const refresh = cookies.find((c) =>
      c.name.startsWith("refresh_token"),
    )?.value
    assert(access && refresh, "Agent credentials missing")
    return {
      access,
      refresh,
      cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    }
  }
  async function exportCli(accepted = true) {
    if (!cliMode && !issuance) return
    stage = "real pfcli browser handoff"
    const before = await credentials()
    rmSync(browserUrlPath, { force: true })
    rmSync(credentialsPath, { force: true })
    const launchDir = join(cliRoot, "bin")
    mkdirSync(launchDir, { mode: 0o700, recursive: true })
    copyFileSync(
      join(import.meta.dir, "cli-browser/xdg-open"),
      join(launchDir, "xdg-open"),
    )
    chmodSync(join(launchDir, "xdg-open"), 0o755)
    cliChild = Bun.spawn(["bun", "cli/pfcli/src/main.ts", "auth", "login"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        BASE_URL: handoff.frontend,
        PFCLI_CREDENTIALS_PATH: credentialsPath,
        PF_RUNTIME_ROOT: handoff.runtimeRoot,
        PF_PROBE_BROWSER_URL: browserUrlPath,
        PATH: `${launchDir}:${process.env["PATH"]}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = new Response(cliChild.stdout).text()
    const errors = new Response(cliChild.stderr).text()
    const deadline = Date.now() + 30_000
    while (
      !existsSync(browserUrlPath) &&
      Date.now() < deadline &&
      cliChild.exitCode === null
    )
      await Bun.sleep(100)
    assert(existsSync(browserUrlPath), "pfcli did not launch browser")
    const url = new URL(readFileSync(browserUrlPath, "utf8"))
    assert(
      url.origin === handoff.frontend &&
        url.pathname === "/cli-auth" &&
        url.searchParams.get("state"),
      "CLI launch lost callback state",
    )
    await ab(
      agent,
      ["open", url.toString()],
      accepted
        ? ["wait", "--text", "Allow delegated CLI access?"]
        : ["wait", "--text", "Login failed. Run pfcli auth login again."],
    )
    if (!accepted) {
      assert(
        !existsSync(credentialsPath),
        "Invalid browser session persisted CLI credentials",
      )
      const exitCode = await cliChild.exited
      failedHandoffExitCodes.push(exitCode)
      assert(
        !(await output).includes("Credentials stored"),
        "Invalid CLI login reported success",
      )
      assert(
        (await errors).includes("Login failed"),
        "CLI did not report callback failure",
      )
      assert(
        await evaluate(
          agent,
          "location.hostname === 'localhost' && location.pathname === '/callback' && !new URL(location.href).searchParams.has('access_token')",
        ),
        "Failed handoff did not reach a token-free localhost callback",
      )
      record(
        "Real pfcli handoff from invalidated browser session completes failure callback, reports failure and stores no credentials",
        { exitCode },
      )
      return
    }
    const unconfirmed = await credentials()
    assert(
      !existsSync(credentialsPath) && cliChild.exitCode === null,
      "GET exported CLI credentials before confirmation",
    )
    assert(
      unconfirmed.access === before.access &&
        unconfirmed.refresh === before.refresh,
      "GET rotated authentication credentials before confirmation",
    )
    assert(
      await evaluate(
        agent,
        "location.pathname === '/cli-auth' && document.querySelector('h1')?.textContent === 'Allow delegated CLI access?'",
      ),
      "Delegated CLI confirmation heading missing",
    )
    record(
      "Delegated CLI GET requires explicit confirmation: no exported or persisted credential and no authentication-cookie rotation",
    )
    await ab(
      agent,
      [
        "find",
        "role",
        "button",
        "click",
        "--name",
        "Allow CLI access",
        "--exact",
      ],
      ["wait", "--text", "Login successful!"],
    )
    assert((await cliChild.exited) === 0, "pfcli login failed")
    assert(
      (await output).includes("Credentials stored"),
      "pfcli did not report persistence",
    )
    await errors
    const persisted = Schema.decodeUnknownSync(
      Schema.Struct({
        accessToken: Schema.String,
        baseUrl: Schema.String,
        expiresAt: Schema.String,
      }),
    )(JSON.parse(readFileSync(credentialsPath, "utf8")))
    const after = await credentials()
    assert(
      after.access !== before.access && after.refresh !== before.refresh,
      "CLI scope did not rotate browser credentials",
    )
    assert(
      persisted.accessToken === after.access &&
        persisted.baseUrl === handoff.frontend,
      "CLI and browser credential mismatch",
    )
    assert(
      (statSync(credentialsPath).mode & 0o777) === 0o600,
      "CLI credential permissions are not private",
    )
    const claims = (token: string) => {
      const payload = token.split(".")[1]
      assert(payload, "JWT payload missing")
      return Schema.decodeUnknownSync(
        Schema.Struct({
          exp: Schema.Number,
          properties: Schema.Record({
            key: Schema.String,
            value: Schema.Unknown,
          }),
        }),
      )(JSON.parse(Buffer.from(payload, "base64url").toString()))
    }
    const original = claims(before.access)
    const exported = claims(after.access)
    assert(
      original.properties["delegation"] &&
        JSON.stringify(original.properties["delegation"]) ===
          JSON.stringify(exported.properties["delegation"]),
      "Export lost delegation lineage",
    )
    assert(
      !exported.properties["humanAuthentication"],
      "Export fabricated human evidence",
    )
    assert(
      original.properties["userId"] === exported.properties["userId"] &&
        original.properties["email"] === exported.properties["email"],
      "Export changed effective owner",
    )
    const generation = Schema.decodeUnknownSync(
      Schema.Struct({ expiresAt: Schema.Number }),
    )(exported.properties["delegation"])
    assert(
      exported.exp * 1000 <= generation.expiresAt,
      "Exported or browser credential exceeds effective deadline",
    )
    assert(
      Number.isFinite(Date.parse(persisted.expiresAt)) &&
        Date.parse(persisted.expiresAt) > Date.now() &&
        Date.parse(persisted.expiresAt) <= exported.exp * 1000,
      "Persisted CLI deadline is expired or exceeds signed JWT expiry",
    )
    assert(
      (await api(persisted.accessToken)).accepted,
      "Exported CLI access rejected",
    )
    assert(
      !(
        await cliRequest(
          "query { pullExecution(limit: 10) { documents { id } } }",
        )
      ).error,
      "Persisted CLI client API read failed",
    )
    record(
      "Real pfcli auth login -> Dashboard cli-auth -> state-protected localhost callback -> mode-0600 persistence -> real CLI HTTP client and Yoga acceptance",
    )
  }
  async function denied(
    saved: Awaited<ReturnType<typeof credentials>>,
    since: number,
    label: string,
    session = agent,
    expired = false,
  ) {
    const apiResult = await api(saved.access)
    if (cliMode || issuance) {
      const replay = await cliRequest(startQuery)
      assert(
        replay.error?.includes("Delegated access is unavailable"),
        "Persisted CLI credential replay was not rejected",
      )
      const exportAgain = await fetch(
        `${handoff.frontend}/cli-auth?port=1&state=invalid-generation-probe`,
        { headers: { cookie: saved.cookie }, redirect: "manual" },
      )
      assert(
        !exportAgain.headers.get("location")?.includes("access_token="),
        "Invalid generation exported usable access",
      )
    }
    assert(apiResult.data == null, "Old API access returned protected data")
    assert(
      (expired && !apiResult.accepted && apiResult.status === 401) ||
        apiResult.errors?.some((e) =>
          e.message.includes("Delegated access is unavailable"),
        ),
      "Expected live-generation denial for old API access",
    )
    const submission = await api(saved.access, startQuery)
    assert(submission.data == null, "Old API submission returned mutation data")
    assert(
      (expired && !submission.accepted && submission.status === 401) ||
        submission.errors?.some((e) =>
          e.message.includes("Delegated access is unavailable"),
        ),
      "Old API submission was not denied by live-generation validity",
    )
    const refreshed = await issuerRefresh(saved.refresh)
    assert(
      refreshed.status === 400 ||
        refreshed.status === 401 ||
        refreshed.status === 403,
      "Old issuer refresh accepted",
    )
    const browserRefresh = await request(
      `${handoff.frontend}/api/auth/refresh`,
      "",
      { cookie: saved.cookie, origin: handoff.frontend },
    )
    const refreshBody: unknown = await browserRefresh.json()
    assert(
      typeof refreshBody === "object" &&
        refreshBody !== null &&
        "success" in refreshBody &&
        refreshBody.success === false,
      "Old Dashboard refresh accepted",
    )
    const protectedPage = await fetch(`${handoff.frontend}/processes`, {
      headers: { cookie: saved.cookie },
      redirect: "manual",
    })
    assert(
      protectedPage.status >= 300 &&
        protectedPage.status < 400 &&
        protectedPage.headers.get("location")?.includes("/login"),
      "Old SSR access accepted",
    )
    const elapsedMs = Date.now() - since
    assert(elapsedMs < 60_000, "Invalidation exceeded one minute")
    record(
      `${label}: previously issued API read/submission, issuer refresh, Dashboard refresh and SSR rejected`,
      {
        elapsedMs,
        apiStatus: apiResult.status,
        apiError:
          expired && apiResult.status === 401
            ? "Expired signed API credential rejected"
            : "Delegated access is unavailable",
        issuerRefreshStatus: refreshed.status,
        ssrStatus: protectedPage.status,
      },
    )
    if (cliMode) await exportCli(false)
    if (administration)
      await ab(
        session,
        ["open", `${handoff.frontend}/processes`],
        ["wait", "--url", "**/login**"],
      )
  }
  if (issuance) {
    assert(
      handoff.issuanceProbe && handoff.control && handoff.controlToken,
      "Start a fresh fixture with DELEGATION_PROBE_ISSUANCE=true",
    )
    const issuerSession = delegatedAdministrator
    await ab(issuerSession, ["open", `${handoff.frontend}/login`])
    const issuerContext = await connect(issuerSession)
    async function control(body: unknown) {
      const response = await request(
        `${handoff.control}`,
        JSON.stringify(body),
        {
          authorization: `Bearer ${handoff.controlToken}`,
          "content-type": "application/json",
        },
      )
      assert(response.ok, "Private issuance fixture control rejected")
      return response.json()
    }
    async function management(access: string, method = "GET", body?: unknown) {
      return fetch(`${handoff.issuer}/delegations`, {
        method,
        redirect: "manual",
        headers: {
          authorization: `Bearer ${access}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    }
    async function list(access: string) {
      const response = await management(access)
      assert(response.ok, "Issuance metadata denied")
      return Schema.decodeUnknownSync(listSchema)(await response.json())
    }
    async function create(
      session: string,
      name: string,
      deadline: string | null,
    ) {
      await ab(
        session,
        ["open", `${handoff.frontend}/act-on-behalf`],
        ["wait", "summary"],
        ["focus", "details:not([open]) > summary"],
        ["press", "Enter"],
        ["fill", "#delegation-name", name],
      )
      for (const days of [1, 7, 14]) {
        await ab(session, [
          "check",
          `form:has(#delegation-name) input[value='${days}']`,
        ])
        assert(
          await evaluate(
            session,
            "(() => { const text = document.querySelector('form:has(#delegation-name) fieldset')?.textContent ?? ''; return text.includes('Estimated expiry:') && text.includes('Confirmed when created.') && text.includes('UTC') && !text.includes('If issued now'); })()",
          ),
          "Creation preview does not qualify its timestamp-anchored estimate",
        )
        if (deadline !== null) {
          assert(
            await evaluate(
              session,
              `document.querySelector('form:has(#delegation-name) time')?.dateTime === ${JSON.stringify(deadline)} && document.body.innerText.includes('Limited by your current access')`,
            ),
            "Preview overrides sub-day ancestor deadline",
          )
        }
      }
      await shot(session, `issuance-permitted-${name}.png`)
      await ab(session, [
        "find",
        "role",
        "button",
        "click",
        "--name",
        "Create secret",
        "--exact",
      ])
      const secret = await takeSecret(session)
      const token = (
        await list(
          (
            await credentials(
              session === owner
                ? ownerContext
                : session === agent
                  ? agentContext
                  : issuerContext,
            )
          ).access,
        )
      ).delegations.find((token) => token.name === name)
      assert(token, "Issued identity missing")
      if (deadline !== null) {
        assert(
          token.expiresAt === deadline,
          "Issued secret exceeds displayed ancestor deadline",
        )
        assert(
          (await metadata(token.id, session)).expires === deadline,
          "Displayed final deadline differs from storage/API",
        )
      }
      return { secret, token }
    }
    for (const width of widths) {
      for (const session of [owner, agent, issuerSession])
        await ab(session, [
          "set",
          "viewport",
          String(width),
          width === 390 ? "844" : "1000",
        ])
      for (const invalidation of ["replacement", "revocation"] as const) {
        const label = `${width}-${invalidation}`
        stage = `${label}: human parent issuance`
        await ab(
          owner,
          ["tab", "t1"],
          ["open", `${handoff.frontend}/act-on-behalf`],
          ["wait", "--text", "Authenticate again with Passkey"],
          [
            "find",
            "role",
            "button",
            "click",
            "--name",
            "Authenticate again with Passkey",
            "--exact",
          ],
          ["wait", "summary"],
        )
        const parent = await create(owner, `parent-${label}`, null)
        const shortened = Schema.decodeUnknownSync(
          Schema.Struct({ expiresAt: Schema.Number }),
        )(
          await control({
            operation: "expire",
            generationId: parent.token.generationId,
            remainingSeconds: 43_200,
          }),
        )
        const deadline = new Date(shortened.expiresAt).toISOString()
        await control({ operation: "issuance-policy", permitted: false })
        await login(parent.secret, true, issuerSession)
        const parentCredentials = await credentials(issuerContext)
        const deniedPolicy = await list(parentCredentials.access)
        assert(
          !deniedPolicy.canIssue &&
            deniedPolicy.delegations.every(
              (token) => !token.allowedActions.replace,
            ),
          "Default policy permits delegated issuance",
        )
        await ab(
          issuerSession,
          ["open", `${handoff.frontend}/act-on-behalf`],
          ["wait", "--text", parent.token.name],
        )
        assert(
          await evaluate(
            issuerSession,
            "![...document.querySelectorAll('button')].some(button => ['Create secret', 'Regenerate', 'Authenticate again with Passkey'].includes(button.textContent.trim()))",
          ),
          "Default-denied delegated screen exposes issuance controls",
        )
        assert(
          (
            await management(parentCredentials.access, "POST", {
              name: `denied-${label}`,
              lifetimeDays: 1,
            })
          ).status === 403,
          "Default API create accepted",
        )
        assert(
          (
            await management(parentCredentials.access, "PATCH", {
              operation: "replace",
              id: parent.token.id,
              generationId: parent.token.generationId,
              expectedName: parent.token.name,
              name: parent.token.name,
              lifetimeDays: 1,
            })
          ).status === 403,
          "Default API replacement accepted",
        )
        await shot(issuerSession, `issuance-default-denied-${label}.png`)
        record(
          `${label}: real Cedar default issuance/replacement deny in browser and API`,
        )
        await control({ operation: "issuance-policy", permitted: true })
        const policyDeadline = Date.now() + 10_000
        let permitted = await list(parentCredentials.access)
        while (!permitted.canIssue && Date.now() < policyDeadline) {
          await Bun.sleep(100)
          permitted = await list(parentCredentials.access)
        }
        record(`${label}: issuance policy and deadline observed`, {
          canIssue: permitted.canIssue,
          issuanceDeadline: permitted.issuanceDeadline,
          expectedDeadline: deadline,
        })
        assert(
          permitted.canIssue && permitted.issuanceDeadline === deadline,
          "Explicit Cedar issuance grant or effective deadline missing",
        )
        stage = `${label}: delegated child issuance and replacement`
        const child = await create(issuerSession, `child-${label}`, deadline)
        await login(child.secret, true)
        const originalChildCredentials = await credentials()
        assert(
          (await api(originalChildCredentials.access)).accepted,
          "Issued child API use rejected",
        )
        const cycle = await management(
          originalChildCredentials.access,
          "PATCH",
          {
            operation: "replace",
            id: parent.token.id,
            generationId: parent.token.generationId,
            expectedName: parent.token.name,
            name: parent.token.name,
            lifetimeDays: 1,
          },
        )
        assert(
          cycle.status === 403 &&
            Schema.decodeUnknownSync(Schema.Struct({ error: Schema.String }))(
              await cycle.json(),
            ).error === "operation_denied",
          "Ancestor replacement did not return the cycle/operation denial",
        )
        const controls = `xpath=//button[@aria-controls=${JSON.stringify(`manage-${child.token.id}`)}]`
        const form = `form[id=${JSON.stringify(`manage-${child.token.id}`)}]`
        await ab(
          issuerSession,
          ["focus", `${controls}[normalize-space(.)="Regenerate"]`],
          ["press", "Enter"],
          ["check", `${form} input[value='7']`],
        )
        assert(
          await evaluate(
            issuerSession,
            `(() => { const fieldset = document.querySelector(${JSON.stringify(`${form} fieldset`)}); const text = fieldset?.textContent ?? ''; return fieldset?.querySelector('time')?.dateTime === ${JSON.stringify(deadline)} && text.includes('Estimated expiry:') && text.includes('Confirmed when created.') && text.includes('Limited by your current access') && !text.includes('If issued now'); })()`,
          ),
          "Replacement preview exceeds ancestor",
        )
        await shot(issuerSession, `issuance-replacement-preview-${label}.png`)
        await ab(issuerSession, [
          "find",
          "role",
          "button",
          "click",
          "--name",
          "Regenerate secret",
          "--exact",
        ])
        const childReplacementSecret = await takeSecret(issuerSession)
        const replacedChild = await metadata(child.token.id, issuerSession)
        assert(
          childReplacementSecret !== child.secret &&
            replacedChild.generation !== child.token.generationId &&
            replacedChild.expires === deadline,
          "Child replacement lost identity/deadline or reused a generation",
        )
        assert(
          !(await api(originalChildCredentials.access)).accepted,
          "Replaced child credential still accepted",
        )
        await login(child.secret, false)
        await login(childReplacementSecret, true)
        const childCredentials = await credentials()
        const grandchild = await create(agent, `grandchild-${label}`, deadline)
        await login(grandchild.secret, true)
        await exportCli()
        const saved = await credentials()
        assert((await api(saved.access)).accepted, "Grandchild API rejected")
        record(
          `${label}: delegated child create/replace and grandchild login retain sub-day deadline; ancestor cycle and old secret rejected`,
          {
            ancestorGeneration: parent.token.generationId,
            childGeneration: replacedChild.generation,
            grandchildGeneration: grandchild.token.generationId,
            deadline,
          },
        )
        stage = `${label}: descendant browser work`
        await ab(
          agent,
          ["open", `${handoff.frontend}/processes`],
          ["wait", "--text", "Delegated Review"],
          width === 390
            ? ["find", "text", "Start", "click", "--exact"]
            : [
                "find",
                "role",
                "link",
                "click",
                "--name",
                "Start process",
                "--exact",
              ],
          ["wait", "input[name=request]"],
          ["fill", "input[name=request]", `grandchild ordinary work ${label}`],
          ["find", "role", "button", "click", "--name", "Submit", "--exact"],
          ["wait", "--url", "**/processes"],
        )
        const baseline = await liveBeforeInvalidation(
          width,
          `ancestor-${invalidation}`,
        )
        await ab(
          owner,
          ["tab", "t1"],
          ["open", `${handoff.frontend}/act-on-behalf`],
          ["wait", "--text", parent.token.name],
        )
        const parentControls = `xpath=//button[@aria-controls=${JSON.stringify(`manage-${parent.token.id}`)}]`
        await ab(
          owner,
          [
            "click",
            `${parentControls}[normalize-space(.)=${JSON.stringify(invalidation === "replacement" ? "Regenerate" : "Revoke")}]`,
          ],
          [
            "find",
            "role",
            "button",
            "click",
            "--name",
            invalidation === "replacement"
              ? "Regenerate secret"
              : "Confirm revocation",
            "--exact",
          ],
        )
        const invalidatedAt = Date.now()
        const newParentSecret =
          invalidation === "replacement" ? await takeSecret(owner) : null
        if (invalidation === "revocation")
          await ab(owner, ["wait", "--text", "Token revoked."])
        await denied(
          saved,
          invalidatedAt,
          `${label}: grandchild ancestor invalidation`,
        )
        assert(
          !(await api(childCredentials.access)).accepted,
          "Child survived ancestor invalidation",
        )
        await ceased(width, `ancestor-${invalidation}`, invalidatedAt, baseline)
        await ab(
          agent,
          ["open", `${handoff.frontend}/processes`],
          ["wait", "--url", "**/login**"],
        )
        await shot(agent, `issuance-descendant-rejected-${label}.png`)
        await login(grandchild.secret, false)
        await login(childReplacementSecret, false)
        if (newParentSecret !== null) {
          await login(newParentSecret, true, issuerSession)
          assert(
            !(await api(saved.access)).accepted,
            "New ancestor generation revived grandchild",
          )
        }
        await shot(owner, `issuance-owner-after-${label}.png`)
        record(
          `${label}: ancestor invalidation rejects child/grandchild secrets, retained browser/API/refresh/CLI access and already-open realtime; replacement does not revive descendants`,
        )
      }
    }
  } else if (administration) {
    // The token-only fixture needs the same human user-administration grant as
    // a configured organisation to exercise navigation through the user editor.
    writeFileSync(
      handoff.policyPath,
      `permit (principal is PF::ProviderUser in PF::Role::"/Administrator", action == PF::Action::"administerUsers", resource);\n`,
    )
    assert(
      handoff.administratorRegistrationUrl &&
        handoff.control &&
        handoff.controlToken,
      "Administration fixture missing",
    )
    for (const width of widths) {
      await ab(
        owner,
        ["set", "viewport", String(width), width === 390 ? "844" : "1000"],
        ["open", `${handoff.frontend}/act-on-behalf`],
        ["wait", "--text", "You have no tokens yet"],
      )
      assert(
        await evaluate(
          owner,
          "!document.querySelector('[name=ownerUserId]') && !document.querySelector('details[open]') && !document.body.innerText.includes('Owner:') && document.documentElement.scrollWidth <= innerWidth",
        ),
        "Personal empty state exposes owner controls or overflows",
      )
      await shot(owner, `personal-empty-${width}.png`)
      await ab(owner, ["focus", "summary"], ["press", "Enter"])
      assert(
        await evaluate(
          owner,
          "document.querySelector('details')?.open === true",
        ),
        "Create token does not open from the keyboard",
      )
      record(
        `${width}: personal empty state and keyboard-operated Create token`,
      )
    }
    const adminContext = await register(
      administrator,
      handoff.administratorRegistrationUrl,
      "administration-admin@example.test",
    )
    await ab(delegatedAdministrator, ["open", `${handoff.frontend}/login`])
    const delegatedContext = await connect(delegatedAdministrator)
    await ab(unrelated, ["open", `${handoff.frontend}/login`])
    const unrelatedContext = await connect(unrelated)
    async function management(
      access: string,
      method = "GET",
      ownerUserId?: string,
      body?: unknown,
    ) {
      return fetch(
        `${handoff.issuer}/delegations${ownerUserId ? `?${new URLSearchParams({ ownerUserId })}` : ""}`,
        {
          method,
          redirect: "manual",
          headers: {
            authorization: `Bearer ${access}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      )
    }
    async function list(access: string, ownerUserId?: string) {
      const response = await management(access, "GET", ownerUserId)
      assert(response.status === 200, "Metadata request rejected")
      const text = await response.text()
      assert(
        !/pfds_|verifier|"secret"/i.test(text),
        "Metadata exposes credential material",
      )
      return Schema.decodeUnknownSync(listSchema)(JSON.parse(text))
    }
    async function create(session: string, name: string) {
      stage = `create ${name}`
      await ab(
        session,
        ["open", `${handoff.frontend}/act-on-behalf`],
        ["wait", "--load", "networkidle"],
      )
      if (
        await evaluate(
          session,
          "document.body.innerText.includes('ChunkLoadError') || !!document.querySelector('nextjs-portal')?.shadowRoot?.textContent.includes('ChunkLoadError')",
        )
      ) {
        await ab(session, ["reload"], ["wait", "summary"])
        record(
          "Recovered Next development chunk reload before issuing credentials",
        )
      }
      if (
        await evaluate(
          session,
          "document.body.innerText.includes('Authenticate again with Passkey')",
        )
      ) {
        await ab(
          session,
          [
            "find",
            "role",
            "button",
            "click",
            "--name",
            "Authenticate again with Passkey",
            "--exact",
          ],
          ["wait", "--url", "**/act-on-behalf"],
          ["wait", "--load", "networkidle"],
        )
      }
      await ab(
        session,
        ["focus", "details:not([open]) > summary"],
        ["press", "Enter"],
        ["fill", "#delegation-name", name],
      )
      if (name.startsWith("admin-target-")) {
        assert(
          await evaluate(
            session,
            "document.documentElement.scrollWidth <= innerWidth",
          ),
          "Creation form overflows",
        )
        await shot(session, `personal-create-${name}.png`)
      }
      await ab(session, [
        "find",
        "role",
        "button",
        "click",
        "--name",
        "Create secret",
        "--exact",
      ])
      return takeSecret(session)
    }
    async function inspect(session: string, userId: string, name: string) {
      const path = `/settings/users/${encodeURIComponent(userId)}/tokens`
      if (session !== administrator) {
        // These actors lack general user editing; exercise the protected route directly.
        await ab(
          session,
          ["open", `${handoff.frontend}${path}`],
          [
            "wait",
            "--fn",
            `Array.from(document.querySelectorAll('h1')).some(heading => heading.textContent === 'User tokens' && heading.checkVisibility()) && document.body.innerText.includes(${JSON.stringify(name)})`,
          ],
        )
      } else {
        await ab(
          session,
          [
            "open",
            `${handoff.frontend}/settings/users/${encodeURIComponent(userId)}`,
          ],
          ["click", `a[href="${path}"]`],
          [
            "wait",
            "--fn",
            `Array.from(document.querySelectorAll('h1')).some(heading => heading.textContent === 'User tokens' && heading.checkVisibility()) && document.body.innerText.includes(${JSON.stringify(name)})`,
          ],
          ["wait", "--load", "networkidle"],
        )
      }
      assert(
        await evaluate(
          session,
          `location.pathname === ${JSON.stringify(path)}`,
        ),
        "Selected user token route missing",
      )
      await ab(
        session,
        [
          "open",
          `${handoff.frontend}/act-on-behalf?${new URLSearchParams({ ownerUserId: userId })}`,
        ],
        ["wait", "--load", "networkidle"],
        [
          "wait",
          "--fn",
          `Array.from(document.querySelectorAll('h1')).some(heading => heading.textContent === 'User tokens' && heading.checkVisibility()) && document.body.innerText.includes(${JSON.stringify(name)})`,
        ],
      )
      assert(
        await evaluate(
          session,
          `location.pathname === ${JSON.stringify(path)} && !document.querySelector('[name="ownerUserId"]')`,
        ),
        "Legacy owner selection did not redirect",
      )
    }
    async function assertRenderedMetadata(
      session: string,
      access: string,
      userId: string,
      target: (typeof listSchema.Type.delegations)[number],
      status: "active" | "revoked",
      label: string,
    ) {
      const renderedSchema = Schema.NullOr(
        Schema.Struct({
          id: Schema.String,
          status: Schema.String,
          expiresAt: Schema.String,
          lastUsedAt: Schema.String,
        }),
      )
      const startedAt = Date.now()
      do {
        const current = (await list(access, userId)).delegations.find(
          (d) => d.id === target.id,
        )
        assert(current, "Target missing from current list API")
        const rendered = Schema.decodeUnknownSync(renderedSchema)(
          await evaluate(
            session,
            `(() => {
              const cards = [...document.querySelectorAll('article')].filter(card => card.querySelector('h3')?.innerText === ${JSON.stringify(target.name)});
              if (cards.length !== 1) return null;
              const card = cards[0];
              const visible = element => element?.checkVisibility({checkOpacity: true, checkVisibilityCSS: true});
              const field = label => {
                const term = [...card.querySelectorAll('dt')].find(dt => dt.innerText === label);
                const value = term?.nextElementSibling;
                return visible(term) && visible(value) ? (value.querySelector('time')?.dateTime ?? value.innerText) : null;
              };
              const badge = card.querySelector('h3')?.nextElementSibling;
              const values = {id: card.dataset.tokenId, status: visible(badge) ? badge.innerText : null, expiresAt: field('Secret expires'), lastUsedAt: field('Last used')};
              return visible(card.querySelector('h3')) && Object.values(values).every(value => typeof value === 'string') ? values : null;
            })()`,
          ),
        )
        // Target background traffic can advance last-use while the UI polls.
        // Require a stable API bracket, never an old fixture timestamp or tolerance.
        const after = (await list(access, userId)).delegations.find(
          (d) => d.id === target.id,
        )
        if (
          current.status === status &&
          current.generationId === target.generationId &&
          current.lastUsedAt !== null &&
          after?.generationId === current.generationId &&
          after.status === current.status &&
          after.expiresAt === current.expiresAt &&
          after.lastUsedAt === current.lastUsedAt &&
          rendered?.id === current.id &&
          rendered.status === (status === "active" ? "Active" : "Revoked") &&
          rendered.expiresAt === current.expiresAt &&
          rendered.lastUsedAt === current.lastUsedAt
        ) {
          record(
            `${label}: target visible status/expiry/last-use match current list API`,
            {
              name: target.name,
              api: {
                id: current.id,
                generationId: current.generationId,
                status: current.status,
                expiresAt: current.expiresAt,
                lastUsedAt: current.lastUsedAt,
              },
              rendered,
              elapsedMs: Date.now() - startedAt,
            },
          )
          return
        }
        await Bun.sleep(500)
      } while (Date.now() - startedAt < 25_000)
      assert(
        false,
        `${label}: target visible metadata did not match stable current list API`,
      )
    }
    async function revoke(session: string, name: string) {
      const tokenId = await evaluate(
        session,
        `Array.from(document.querySelectorAll('article')).find(card => card.checkVisibility() && card.querySelector('h3')?.textContent === ${JSON.stringify(name)})?.dataset.tokenId`,
      )
      assert(typeof tokenId === "string", "Target revocation control missing")
      const startedAt = Date.now()
      await ab(
        session,
        [
          "focus",
          `xpath=//article[@data-token-id=${JSON.stringify(tokenId)}]//button[normalize-space(.)="Revoke"]`,
        ],
        ["press", "Enter"],
        ["focus", `form[id="manage-${tokenId}"] button[type="submit"]`],
        ["press", "Enter"],
        ["wait", "--text", "Token revoked."],
      )
      return startedAt
    }
    async function control(body: unknown) {
      assert(handoff.control, "Control URL missing")
      const response = await request(handoff.control, JSON.stringify(body), {
        authorization: `Bearer ${handoff.controlToken}`,
        "content-type": "application/json",
      })
      assert(response.ok, "Private fixture control rejected")
      const text = await response.text()
      assert(
        !/pfds_|verifier|"secret"/i.test(text),
        "Fixture history exposes credential material",
      )
      return JSON.parse(text)
    }
    const idleFailures: number[] = []
    async function idleCleared(
      since: number,
      width: number,
      ownerEmail: string,
    ) {
      // Only observe: no operator/probe navigation, reload, or triggered poll.
      // An automatic login redirect is a valid idle invalidation outcome.
      const stateSchema = Schema.Struct({
        cleared: Schema.Boolean,
        pathname: Schema.String,
        managementRequestsAfterInvalidation: Schema.Number,
      })
      let state: typeof stateSchema.Type
      do {
        state = Schema.decodeUnknownSync(stateSchema)(
          await evaluate(
            delegatedAdministrator,
            `({
            cleared: !Array.from(document.querySelectorAll('article')).some(element => element.checkVisibility()) && !document.body.innerText.includes(${JSON.stringify(ownerEmail)}) && !Array.from(document.querySelectorAll('button')).some(button => button.checkVisibility() && ['Revoke','Confirm revocation','Create secret','Regenerate'].includes(button.textContent.trim())) && (location.pathname === '/login' || document.body.innerText.includes('Your session is unavailable or has expired. Log in again.')),
            pathname: location.pathname,
            managementRequestsAfterInvalidation: performance.getEntriesByType('resource').filter(entry => entry.initiatorType === 'fetch' && new URL(entry.name).pathname === '/act-on-behalf' && performance.timeOrigin + entry.startTime >= ${since}).length
          })`,
          ),
        )
        if (state.cleared) break
        await Bun.sleep(500)
      } while (Date.now() - since < 45_000)
      if (!state.cleared) {
        await shot(
          delegatedAdministrator,
          `administration-idle-failure-${width}.png`,
        )
        writeFileSync(
          join(evidence, "administration-idle-failure.json"),
          JSON.stringify(
            { since, observedAt: Date.now(), width, ...state },
            null,
            2,
          ),
        )
        idleFailures.push(width)
        console.error(
          `FAIL ${width}: idle administrator retained visible management after 45 seconds; continuing credential checks`,
        )
        return
      }
      assert(
        state.cleared,
        "Idle invalid administrator retained visible owner metadata or mutation controls",
      )
      assert(
        state.pathname === "/login" ||
          state.managementRequestsAfterInvalidation > 0,
        "Idle denial had no observed management poll",
      )
      const elapsedMs = Date.now() - since
      await shot(
        delegatedAdministrator,
        `administration-idle-cleared-${width}.png`,
      )
      record(
        `${width}: idle delegated administrator metadata/actions removed without operator/probe navigation or reload`,
        { elapsedMs, ...state },
      )
    }
    const ownerSaved = await credentials(ownerContext)
    const adminSaved = await credentials(adminContext)
    const ownerInfo = (await list(ownerSaved.access)).owner
    const adminInfo = (await list(adminSaved.access)).owner
    assert(
      ownerInfo.userId !== adminInfo.userId,
      "Owner and administrator must be independent humans",
    )
    record(
      "Independent owner and administrator sessions identify distinct real Provider Users",
      { owner: ownerInfo, administrator: adminInfo },
    )
    const survivorSecret = await create(owner, "unrelated-survivor")
    await login(survivorSecret, true, unrelated)
    const survivorSaved = await credentials(unrelatedContext)
    for (const width of widths) {
      stage = `${width}: administrator fixtures`
      for (const session of [
        owner,
        administrator,
        agent,
        delegatedAdministrator,
        unrelated,
      ])
        await ab(session, [
          "set",
          "viewport",
          String(width),
          width === 390 ? "844" : "1000",
        ])
      const targetName = `admin-target-${width}`
      const targetSecret = await create(owner, targetName)
      await login(targetSecret, true)
      const targetSaved = await credentials()
      assert(
        (await api(targetSaved.access)).accepted,
        "Target API not initially valid",
      )
      const adminSecret = await create(
        administrator,
        `delegated-administrator-${width}`,
      )
      await login(adminSecret, true, delegatedAdministrator)
      const delegateSaved = await credentials(delegatedContext)
      const ownAdmin = await list((await credentials(adminContext)).access)
      const adminToken = ownAdmin.delegations.find(
        (d) => d.name === `delegated-administrator-${width}`,
      )
      assert(adminToken, "Administrator token missing")
      const inspected = await list(adminSaved.access, ownerInfo.userId)
      const target = inspected.delegations.find((d) => d.name === targetName)
      assert(
        target?.lastUsedAt && target.status === "active",
        "Active target last-use metadata missing",
      )
      assert(
        !inspected.canIssue &&
          target.allowedActions.revoke &&
          !target.allowedActions.replace &&
          !target.allowedActions.rename,
        "Default administrator capabilities incorrect",
      )
      const guard = {
        id: target.id,
        generationId: target.generationId,
        expectedName: target.name,
      }
      const adminGuard = {
        id: adminToken.id,
        generationId: adminToken.generationId,
        expectedName: adminToken.name,
      }
      stage = `${width}: direct API negatives`
      for (const [method, body] of [
        ["GET", undefined],
        ["PATCH", { operation: "revoke", ...adminGuard }],
        ["PATCH", { operation: "rename", ...adminGuard, name: "unauthorized" }],
        [
          "PATCH",
          {
            operation: "replace",
            ...adminGuard,
            name: adminToken.name,
            lifetimeDays: 1,
          },
        ],
        ["POST", { name: "unauthorized", lifetimeDays: 1 }],
      ] as const)
        assert(
          (await management(ownerSaved.access, method, adminInfo.userId, body))
            .status === 403,
          `Ordinary owner cross-owner ${method} accepted`,
        )
      for (const access of [adminSaved.access, delegateSaved.access]) {
        for (const [method, body] of [
          ["POST", { name: "unauthorized", lifetimeDays: 1 }],
          [
            "PATCH",
            {
              operation: "replace",
              ...guard,
              name: target.name,
              lifetimeDays: 1,
            },
          ],
        ] as const)
          assert(
            (await management(access, method, ownerInfo.userId, body))
              .status === 403,
            "Administrator cross-owner issuance/replacement accepted",
          )
      }
      assert(
        (await management(targetSaved.access, "GET", adminInfo.userId))
          .status === 403,
        "Ungranted Delegation can inspect administrator",
      )
      record(
        `${width}: direct API owner cross-owner metadata/rename/revoke/issue/replace denied; human and delegated admin cross-owner issue/replace denied; ungranted Delegation denied`,
      )
      await inspect(owner, adminInfo.userId, "not permitted")
      await shot(owner, `administration-owner-denied-${width}.png`)
      stage = `${width}: human administrator inspection and revocation`
      await inspect(administrator, ownerInfo.userId, targetName)
      await ab(administrator, [
        "wait",
        "--fn",
        "document.body.innerText.includes('lifecycle-owner@example.test') && ![...document.querySelectorAll('button')].some(b => b.checkVisibility() && ['Create secret','Regenerate'].includes(b.textContent.trim())) && document.documentElement.scrollWidth <= innerWidth",
      ])
      await assertRenderedMetadata(
        administrator,
        adminSaved.access,
        ownerInfo.userId,
        target,
        "active",
        `${width}: human administrator before revoke`,
      )
      await shot(administrator, `administration-inspect-${width}.png`)
      const revokedAt = await revoke(administrator, targetName)
      await denied(
        targetSaved,
        revokedAt,
        `${width}: administrator target revocation`,
      )
      await login(targetSecret, false)
      await shot(agent, `administration-agent-rejected-${width}.png`)
      await ab(administrator, ["reload"], ["wait", "--text", "Revoked"])
      await assertRenderedMetadata(
        administrator,
        adminSaved.access,
        ownerInfo.userId,
        target,
        "revoked",
        `${width}: human administrator after revoke`,
      )
      await shot(administrator, `administration-revoked-${width}.png`)
      record(
        `${width}: human administrator inspect via user administration and legacy redirect and revoke, target secret rejected`,
        { delegationId: target.id, generationId: target.generationId },
      )
      stage = `${width}: explicitly granted delegated administrator`
      const secondName = `delegated-admin-target-${width}`
      const secondSecret = await create(owner, secondName)
      await login(secondSecret, true)
      const secondSaved = await credentials()
      const delegatedList = await list(delegateSaved.access, ownerInfo.userId)
      const second = delegatedList.delegations.find(
        (d) => d.name === secondName,
      )
      assert(
        second?.allowedActions.revoke &&
          !delegatedList.canIssue &&
          !second.allowedActions.replace,
        "Explicit delegated grant not reflected",
      )
      await inspect(delegatedAdministrator, ownerInfo.userId, secondName)
      await ab(delegatedAdministrator, [
        "wait",
        "--fn",
        "document.body.innerText.includes('lifecycle-owner@example.test') && document.documentElement.scrollWidth <= innerWidth && ![...document.querySelectorAll('button')].some(b => b.checkVisibility() && ['Create secret','Regenerate'].includes(b.textContent.trim()))",
      ])
      await assertRenderedMetadata(
        delegatedAdministrator,
        delegateSaved.access,
        ownerInfo.userId,
        second,
        "active",
        `${width}: delegated administrator before revoke`,
      )
      await shot(
        delegatedAdministrator,
        `administration-delegated-inspect-${width}.png`,
      )
      const secondRevokedAt = await revoke(delegatedAdministrator, secondName)
      await denied(
        secondSaved,
        secondRevokedAt,
        `${width}: delegated administrator target revocation`,
      )
      await login(secondSecret, false)
      await assertRenderedMetadata(
        delegatedAdministrator,
        delegateSaved.access,
        ownerInfo.userId,
        second,
        "revoked",
        `${width}: delegated administrator after revoke`,
      )
      await shot(
        delegatedAdministrator,
        `administration-delegated-revoked-${width}.png`,
      )
      record(
        `${width}: explicit Cedar Delegation permit drives cross-owner metadata and browser revocation`,
        { delegationId: second.id, generationId: second.generationId },
      )
      stage = `${width}: administrator actor validity`
      let invalidSaved = delegateSaved
      let invalidSecret = adminSecret
      if (width === 1440) {
        invalidSecret = await create(administrator, "expiry-administrator")
        const expiryToken = (
          await list((await credentials(adminContext)).access)
        ).delegations.find((d) => d.name === "expiry-administrator")
        assert(expiryToken, "Expiry administrator missing")
        const expiry = Schema.decodeUnknownSync(
          Schema.Struct({ expiresAt: Schema.Number }),
        )(
          await control({
            operation: "expire",
            generationId: expiryToken.generationId,
          }),
        )
        await login(invalidSecret, true, delegatedAdministrator)
        invalidSaved = await credentials(delegatedContext)
        await inspect(
          delegatedAdministrator,
          ownerInfo.userId,
          "unrelated-survivor",
        )
        assert(
          await evaluate(
            delegatedAdministrator,
            "document.visibilityState === 'visible' && !!document.querySelector('article') && Array.from(document.querySelectorAll('article button')).some(button => button.textContent.trim() === 'Revoke')",
          ),
          "Idle expiry positive UI control missing",
        )
        assert(
          (await list(invalidSaved.access, ownerInfo.userId)).delegations.some(
            (d) => d.allowedActions.revoke,
          ),
          "Short-lived administrator not valid before expiry",
        )
        assert(
          Date.now() < expiry.expiresAt,
          "Expiry fixture deadline passed before positive control",
        )
        record(
          "Delegated administrator with shortened real deadline can inspect/revoke before expiry",
          { expiresAt: expiry.expiresAt },
        )
        await Bun.sleep(Math.max(0, expiry.expiresAt - Date.now()) + 100)
        await idleCleared(expiry.expiresAt, width, ownerInfo.email)
        await denied(
          invalidSaved,
          expiry.expiresAt,
          `${width}: delegated administrator own expiry`,
          delegatedAdministrator,
          true,
        )
        await ab(
          administrator,
          ["open", `${handoff.frontend}/act-on-behalf`],
          ["wait", "--text", expiryToken.name],
        )
        const expiredCard = `article[data-token-id="${expiryToken.id}"]`
        assert(
          await evaluate(
            administrator,
            `document.querySelector('${expiredCard} span')?.textContent === 'Expired'`,
          ),
          "Expired token missing before replacement",
        )
        await ab(
          administrator,
          [
            "click",
            `${expiredCard} button[aria-controls="manage-${expiryToken.id}"]:nth-of-type(2)`,
          ],
          ["check", `${expiredCard} form input[value="7"]`],
          ["click", `${expiredCard} form button[type="submit"]`],
        )
        await takeSecret(administrator)
        const replaced = (
          await list((await credentials(adminContext)).access)
        ).delegations.find((token) => token.id === expiryToken.id)
        assert(
          replaced?.status === "active" &&
            replaced.generationId !== expiryToken.generationId,
          "Expired replacement did not produce a new active generation",
        )
        await shot(administrator, "personal-expired-replaced-1440.png")
        record(
          "Expired token replaced through the real browser while retaining its identity",
        )
      } else {
        assert(
          await evaluate(
            delegatedAdministrator,
            "document.visibilityState === 'visible' && !!document.querySelector('article') && Array.from(document.querySelectorAll('article button')).some(button => button.textContent.trim() === 'Revoke')",
          ),
          "Idle revocation positive UI control missing",
        )
        await ab(
          administrator,
          ["open", `${handoff.frontend}/act-on-behalf`],
          ["wait", "--text", adminToken.name],
        )
        const actorRevokedAt = await revoke(administrator, adminToken.name)
        await idleCleared(actorRevokedAt, width, ownerInfo.email)
        await denied(
          delegateSaved,
          actorRevokedAt,
          `${width}: delegated administrator own revocation`,
          delegatedAdministrator,
        )
      }
      assert(
        (await management(invalidSaved.access, "GET", ownerInfo.userId))
          .status === 401,
        "Invalid delegated administrator can inspect",
      )
      assert(
        (
          await management(invalidSaved.access, "PATCH", ownerInfo.userId, {
            operation: "revoke",
            ...guard,
          })
        ).status === 401,
        "Invalid delegated administrator can mutate",
      )
      await login(invalidSecret, false, delegatedAdministrator)
      await shot(
        delegatedAdministrator,
        `administration-delegated-invalid-${width}.png`,
      )
      assert(
        (await api(ownerSaved.access)).accepted &&
          (await api(adminSaved.access)).accepted &&
          (await api(survivorSaved.access)).accepted,
        "Unrelated valid credentials invalidated",
      )
      await ab(
        unrelated,
        ["open", `${handoff.frontend}/processes`],
        ["wait", "--text", "Delegated Review"],
      )
      await shot(unrelated, `administration-survivor-${width}.png`)
      const persisted = Schema.decodeUnknownSync(
        Schema.Struct({
          history: Schema.Array(
            Schema.Struct({
              delegationId: Schema.String,
              secretGenerationId: Schema.String,
              delegationEvent: Schema.String,
              actorProviderUserId: Schema.String,
              actorDelegationId: Schema.NullOr(Schema.String),
              actorSecretGenerationId: Schema.NullOr(Schema.String),
            }),
          ),
          owners: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              userId: Schema.String,
              email: Schema.String,
            }),
          ),
          delegations: Schema.Array(
            Schema.Struct({ id: Schema.String, ownerId: Schema.String }),
          ),
        }),
      )(await control({ operation: "history" }))
      const actorId = persisted.owners.find(
        (o) => o.userId === adminInfo.userId,
      )?.id
      const ownerId = persisted.owners.find(
        (o) => o.userId === ownerInfo.userId,
      )?.id
      assert(
        actorId && ownerId && actorId !== ownerId,
        "History actors not distinct",
      )
      for (const [affected, actorDelegationId, actorSecretGenerationId] of [
        [target, null, null],
        [second, adminToken.id, adminToken.generationId],
      ] as const) {
        const event = persisted.history.find(
          (e) =>
            e.delegationId === affected.id && e.delegationEvent === "revoked",
        )
        assert(
          event?.actorProviderUserId === actorId &&
            event.secretGenerationId === affected.generationId &&
            event.actorDelegationId === actorDelegationId &&
            event.actorSecretGenerationId === actorSecretGenerationId,
          "Revocation history attribution incorrect",
        )
        assert(
          persisted.delegations.find((d) => d.id === affected.id)?.ownerId ===
            ownerId,
          "Affected owner history relationship incorrect",
        )
      }
      record(
        `${width}: persisted human/delegated revoker identity is distinct from affected owner and generation; owner/admin/unrelated Delegation remain usable`,
        persisted,
      )
      stage = `${width}: personal token lifecycle`
      const personalName = `personal-${width}`
      const oldSecret = await create(owner, personalName)
      const personal = (
        await list((await credentials(ownerContext)).access)
      ).delegations.find((token) => token.name === personalName)
      assert(personal, "Personal token missing")
      const before = await metadata(personal.id)
      const controls = `xpath=//button[@aria-controls=${JSON.stringify(`manage-${personal.id}`)}]`
      const form = `form[id=${JSON.stringify(`manage-${personal.id}`)}]`
      const renamedName = `${personalName}-renamed`
      await ab(
        owner,
        ["focus", `${controls}[normalize-space(.)="Rename"]`],
        ["press", "Enter"],
        ["fill", `${form} input[name=name]`, renamedName],
        ["click", `${form} button[type=submit]`],
        ["wait", "--text", "Token renamed."],
      )
      assert(
        JSON.stringify(await metadata(personal.id)) === JSON.stringify(before),
        "Rename changed the personal token's identity or generation",
      )
      await shot(owner, `personal-renamed-${width}.png`)
      await ab(
        owner,
        ["focus", `${controls}[normalize-space(.)="Regenerate"]`],
        ["press", "Enter"],
        ["check", `${form} input[value="${width === 390 ? 14 : 7}"]`],
        ["click", `${form} button[type=submit]`],
      )
      const newSecret = await takeSecret(owner)
      assert(
        (await metadata(personal.id)).generation !== before.generation,
        "Replacement retained the old generation",
      )
      await shot(owner, `personal-replaced-${width}.png`)
      await login(oldSecret, false)
      await login(newSecret, true)
      await revoke(owner, renamedName)
      await login(newSecret, false)
      await ab(
        owner,
        ["reload"],
        [
          "wait",
          "--fn",
          `document.querySelector('article[data-token-id="${personal.id}"]')?.checkVisibility() === true`,
        ],
      )
      assert(
        await evaluate(
          owner,
          `!document.querySelector('code[data-private]') && document.querySelector('article[data-token-id="${personal.id}"] span')?.textContent === 'Revoked' && document.documentElement.scrollWidth <= innerWidth`,
        ),
        "Personal revoked metadata was not retained safely",
      )
      await shot(owner, `personal-revoked-${width}.png`)
      record(
        `${width}: personal create/copy, rename, replace, old/new secret login, revoke, and reload without redisclosure`,
      )
    }
    record(
      "Requested viewports: direct API and navigated browser administration acceptance complete",
    )
    assert(
      idleFailures.length === 0,
      `Idle administrator clearing failed at viewport widths: ${idleFailures.join(", ")}`,
    )
    record("Requested viewports: idle administration acceptance complete")
  } else {
    for (const width of cliMode ? [1440] : widths) {
      const initialName = `joined-${width}-${"long-token-name-".repeat(6)}agent`
      stage = `${width}: create`
      await ab(agent, [
        "set",
        "viewport",
        String(width),
        width === 390 ? "844" : "1000",
      ])
      await ab(
        owner,
        ["set", "viewport", String(width), width === 390 ? "844" : "1000"],
        ["open", `${handoff.frontend}/act-on-behalf`],
        ["wait", "--text", "Authenticate again with Passkey"],
        [
          "find",
          "role",
          "button",
          "click",
          "--name",
          "Authenticate again with Passkey",
          "--exact",
        ],
        ["wait", "--url", "**/act-on-behalf"],
        ["wait", "--load", "networkidle"],
      )
      await ab(
        owner,
        ["focus", "details:not([open]) > summary"],
        ["press", "Enter"],
        ["wait", "#delegation-name", "--timeout", "60000"],
        ["fill", "#delegation-name", initialName],
        [
          "find",
          "role",
          "button",
          "click",
          "--name",
          "Create secret",
          "--exact",
        ],
      )
      const originalSecret = await takeSecret()
      const [delegationId] = Schema.decodeUnknownSync(
        Schema.Tuple(Schema.String),
      )(
        await evaluate(
          owner,
          `Array.from(document.querySelectorAll('article')).filter(card => card.querySelector('h3')?.textContent === ${JSON.stringify(initialName)}).map(card => card.dataset.tokenId)`,
        ),
      )
      const controls = `xpath=//button[@aria-controls=${JSON.stringify(`manage-${delegationId}`)}]`
      const form = `form[id=${JSON.stringify(`manage-${delegationId}`)}]`
      const original = await metadata(delegationId)
      await login(originalSecret, true)
      await ab(agent, ["wait", "--load", "networkidle"])
      assert(
        await evaluate(
          agent,
          `document.querySelector('[data-testid="header-profile-button"]')?.textContent.includes(${JSON.stringify(initialName)}) && !document.querySelector('header')?.previousElementSibling && document.documentElement.scrollWidth <= innerWidth`,
        ),
        "Delegated trigger identity, banner removal or viewport layout failed",
      )
      await shot(agent, `profile-delegated-closed-${width}.png`)
      await ab(
        agent,
        ["click", '[data-testid="header-profile-button"]'],
        ["wait", '[role="menu"]'],
      )
      assert(
        await evaluate(
          agent,
          `(() => { const menu = document.querySelector('[role=menu]'); return menu?.textContent.includes(${JSON.stringify(initialName)}) && menu.textContent.includes('Acting on behalf of') && menu.textContent.includes('lifecycle-owner@example.test') && menu.querySelector('time')?.dateTime === ${JSON.stringify(original.expires)} && menu.querySelector('time')?.textContent.includes('UTC'); })()`,
        ),
        "Profile owner or effective expiry differs from issued metadata",
      )
      await shot(agent, `profile-delegated-open-${width}.png`)
      await agentContext.grantPermissions(["clipboard-read", "clipboard-write"])
      await ab(agent, ["press", "Home"], ["press", "Enter"])
      assert(
        await evaluate(
          agent,
          "navigator.clipboard.readText().then(value => value === 'lifecycle-owner@example.test')",
        ),
        "Keyboard copy did not copy only the owner email",
      )
      await ab(agent, ["press", "Escape"])
      record(
        `${width}: delegated profile trigger, owner, effective expiry, absent banner and responsive menu`,
      )

      await exportCli()
      const beforeRename = await credentials()
      assert(
        (await api(beforeRename.access)).accepted,
        "Initial API credential rejected",
      )
      record(
        `${width}: independent agent secret login and real Yoga/Cedar API acceptance`,
      )
      stage = `${width}: delegated browser work`
      await ab(
        agent,
        ["open", `${handoff.frontend}/processes`],
        ["wait", "--text", "Delegated Review"],
        width === 390
          ? ["find", "text", "Start", "click", "--exact"]
          : [
              "find",
              "role",
              "link",
              "click",
              "--name",
              "Start process",
              "--exact",
            ],
        ["wait", "input[name=request]"],
        [
          "fill",
          "input[name=request]",
          `${width} genuine delegated browser submission`,
        ],
        ["find", "role", "button", "click", "--name", "Submit", "--exact"],
        ["wait", "--url", "**/processes"],
      )
      record(
        `${width}: delegated user submitted ordinary process form through the real Dashboard`,
      )
      await ab(
        agent,
        ["open", `${handoff.frontend}/to-dos`],
        ["wait", "--text", "Review request"],
      )
      const todoSnapshot = Schema.decodeUnknownSync(
        Schema.Array(
          Schema.Struct({
            result: Schema.Struct({
              refs: Schema.Record({
                key: Schema.String,
                value: Schema.Struct({
                  role: Schema.String,
                  name: Schema.String,
                }),
              }),
            }),
          }),
        ),
      )(JSON.parse(await ab(agent, ["snapshot", "-i"])))
      const doRef = Object.entries(todoSnapshot[0]?.result.refs ?? {}).find(
        ([, ref]) =>
          ref.role === "link" &&
          (ref.name === "Do" || ref.name === "Do Review request"),
      )?.[0]
      assert(doRef, "No accessible Todo Do link")
      await ab(
        agent,
        ["click", `@${doRef}`],
        ["wait", "input[name=decision]"],
        [
          "fill",
          "input[name=decision]",
          `${width} reviewed by delegated browser`,
        ],
        ["find", "role", "button", "click", "--name", "Done", "--exact"],
        ["wait", "--url", "**/to-dos"],
      )
      record(
        `${width}: delegated user completed a worker-created Todo through the real Dashboard`,
      )
      stage = `${width}: rename`
      await ab(
        owner,
        [
          "wait",
          "--fn",
          `document.querySelector('article[data-token-id="${delegationId}"]')?.checkVisibility() === true`,
        ],
        ["focus", `${controls}[normalize-space(.)="Rename"]`],
        ["press", "Enter"],
        ["fill", `${form} input[name=name]`, `renamed-${width}`],
        ["find", "role", "button", "click", "--name", "Save name", "--exact"],
        ["wait", "--text", "Token renamed."],
      )
      const renamed = await metadata(delegationId)
      assert(
        JSON.stringify(original) === JSON.stringify(renamed),
        "Rename changed identity, generation or deadline",
      )
      assert(
        (await api(beforeRename.access)).accepted,
        "Rename invalidated original access",
      )
      const unchangedSecret = await request(
        `${handoff.issuer}/oauth/delegation`,
        JSON.stringify({ secret: originalSecret }),
        {
          authorization: `Bearer ${handoff.frontendJwt}`,
          "content-type": "application/json",
        },
      )
      assert(
        unchangedSecret.status === 200,
        "Rename invalidated original secret exchange",
      )
      await shot(owner, `joined-owner-renamed-${width}.png`)
      record(
        `${width}: rename preserves identity, generation, timestamps and existing API access`,
        renamed,
      )
      const beforeReplacementLive = await liveBeforeInvalidation(
        width,
        "replacement",
      )
      stage = `${width}: replace`
      await ab(owner, ["click", `${controls}[normalize-space(.)="Regenerate"]`])
      await ab(
        owner,
        [
          "check",
          `${form} input[name=lifetimeDays][value='${width === 390 ? 14 : 7}']`,
        ],
        [
          "find",
          "role",
          "button",
          "click",
          "--name",
          "Regenerate secret",
          "--exact",
        ],
      )
      const replacedAt = Date.now()
      const replacementSecret = await takeSecret()
      const replacement = await metadata(delegationId)
      assert(
        replacementSecret !== originalSecret &&
          replacement.id === original.id &&
          replacement.generation !== original.generation,
        "Replacement lineage incorrect",
      )
      assert(
        Date.parse(replacement.expires) - Date.parse(replacement.created) ===
          (width === 390 ? 14 : 7) * 86_400_000,
        "Replacement duration incorrect",
      )
      await denied(beforeRename, replacedAt, `${width}: replacement`)
      await ceased(width, "replacement", replacedAt, beforeReplacementLive)
      await login(originalSecret, false)
      await shot(agent, `joined-old-secret-denied-${width}.png`)
      await login(replacementSecret, true)
      await exportCli()
      const beforeRevoke = await credentials()
      assert(
        (await api(beforeRevoke.access)).accepted,
        "New API credential rejected",
      )
      if (cliMode) {
        stage = "CLI Cedar administration deny and explicit permit"
        const adminQuery = `mutation { createInvitation(input: {email: "cli-invited@example.test", roleIds: [${JSON.stringify(handoff.reviewerRoleId)}]}) { __typename ... on SaveInvitationSuccess { invitation { id } } ... on SaveInvitationFailure { error } } }`
        const deniedAdmin = await cliRequest(adminQuery)
        assert(
          deniedAdmin.error?.includes("administerUsers"),
          "Default Cedar did not deny CLI administration",
        )
        record(
          "Persisted CLI credential: human-only administerUsers denied by real Cedar",
        )
        writeFileSync(
          handoff.policyPath,
          'permit(principal is PF::Delegation, action == PF::Action::"administerUsers", resource is PF::Application);\n',
        )
        const until = Date.now() + 10_000
        let permitted = await cliRequest(adminQuery)
        while (
          permitted.error?.includes("administerUsers") &&
          Date.now() < until
        ) {
          await Bun.sleep(100)
          permitted = await cliRequest(adminQuery)
        }
        const adminData = Schema.decodeUnknownSync(
          Schema.Struct({
            createInvitation: Schema.Struct({ __typename: Schema.String }),
          }),
        )(permitted.data)
        assert(
          !permitted.error &&
            adminData.createInvitation.__typename === "SaveInvitationSuccess",
          "Explicit Cedar permit did not authorize persisted CLI administration",
        )
        record(
          "Explicit organisation Cedar permit: real CLI createInvitation persisted successfully",
        )
        writeFileSync(handoff.policyPath, "// No additional permits.\n")
      }
      await ab(
        agent,
        ["open", `${handoff.frontend}/processes`],
        ["wait", "--text", "Delegated Review"],
      )
      await ab(agent, [
        "wait",
        "--fn",
        "document.documentElement.scrollWidth <= innerWidth",
      ])
      await shot(agent, `joined-new-agent-session-${width}.png`)
      await shot(owner, `joined-owner-replaced-${width}.png`)
      record(
        `${width}: old secret login denied, distinct replacement login and API accepted`,
        replacement,
      )
      await ab(
        agent,
        ["open", `${handoff.frontend}/to-dos`],
        ["wait", "--text", "My To-Dos"],
      )
      await until(
        () => agentLive.subscriptions.has(agentPage),
        "Delegated subscriber missing before transition",
      )
      stage = `${width}: same-browser human transition`
      const existingPages = new Set(ownerContext.pages())
      await ab(owner, ["tab", "new", "--label", "restricted", "about:blank"])
      await until(
        () =>
          ownerContext
            .pages()
            .some((candidate) => !existingPages.has(candidate)),
        "Restricted tab missing",
      )
      const restrictedPage = Option.getOrThrow(
        Option.fromNullable(
          ownerContext
            .pages()
            .find((candidate) => !existingPages.has(candidate)),
        ),
      )
      await ab(owner, [
        "set",
        "viewport",
        String(width),
        width === 390 ? "844" : "1000",
      ])
      await ab(owner, ["open", handoff.frontend])
      assert(
        await evaluate(
          owner,
          "fetch('/api/auth/logout', {method: 'POST'}).then(response => response.ok)",
        ),
        "Server logout before delegated login failed",
      )
      await login(replacementSecret, true, owner)
      await ab(
        owner,
        ["open", `${handoff.frontend}/to-dos`],
        ["wait", "--text", "My To-Dos"],
      )
      await until(
        () => ownerLive.subscriptions.has(restrictedPage),
        "Restricted same-browser Todo subscription missing",
      )
      const restrictedBinding = ownerLive.bindings.get(restrictedPage)
      assert(
        restrictedBinding &&
          restrictedBinding === agentLive.bindings.get(agentPage),
        "Restricted tab did not retain the delegated session binding",
      )
      const transitionBaselineId = await start(
        beforeRevoke.access,
        `${width} same-browser delegated baseline`,
      )
      await until(
        () =>
          ownerLive.events.some(
            (event) =>
              event.page === restrictedPage &&
              event.executionId === transitionBaselineId,
          ),
        "Restricted tab was not live before human login",
      )
      const restrictedNavigationCount =
        ownerLive.navigations.get(restrictedPage)
      const restrictedDocument = await evaluate(owner, "performance.timeOrigin")
      await shot(owner, `joined-transition-delegated-${width}.png`)
      await ab(owner, ["tab", "t1"])
      assert(
        await evaluate(
          owner,
          "fetch('/api/auth/logout', {method: 'POST'}).then(response => response.ok)",
        ),
        "Server logout before human login failed",
      )
      await ab(
        owner,
        ["open", `${handoff.frontend}/login`],
        [
          "find",
          "role",
          "button",
          "click",
          "--name",
          "Sign in with Passkey",
          "--exact",
        ],
        ["wait", "--fn", "location.pathname === '/'"],
        ["wait", '[data-testid="header-profile-button"]'],
      )
      assert(
        await evaluate(
          owner,
          `!document.querySelector('[data-testid="header-profile-button"]')?.getAttribute('aria-label')?.includes('acting on behalf of')`,
        ),
        "Human passkey login retained delegated identity",
      )
      await shot(owner, `joined-transition-human-${width}.png`)
      await ab(
        owner,
        ["open", `${handoff.frontend}/act-on-behalf`],
        ["wait", "--text", `renamed-${width}`],
      )
      record(
        `${width}: genuine passkey login replaces shared browser cookies after a live delegated-tab baseline`,
      )
      // Cookie transitions can legitimately re-enter the human tab's auth
      // boundary. Establish its independent human subscription before revocation.
      await ab(
        owner,
        ["tab", "subscriber"],
        ["open", `${handoff.frontend}/to-dos`],
        ["wait", "--text", "My To-Dos"],
      )
      await until(
        () => ownerLive.subscriptions.has(subscriberPage),
        "Human subscriber missing after transition",
      )
      await ab(owner, ["tab", "t1"])
      const beforeRevocationLive = await liveBeforeInvalidation(
        width,
        "revocation",
      )
      stage = `${width}: revoke`
      const submitted = cliMode
        ? await (async () => {
            const result = await cliRequest(startQuery)
            return {
              accepted: !result.error,
              data: Schema.decodeUnknownSync(
                Schema.Record({ key: Schema.String, value: Schema.Unknown }),
              )(result.data),
            }
          })()
        : await api(beforeRevoke.access, startQuery)
      assert(submitted.accepted, "Valid generation could not submit work")
      const { executionId } = Schema.decodeUnknownSync(
        Schema.Struct({ executionId: Schema.String }),
      )(submitted.data?.["startDelegatedreview"])
      await ab(
        owner,
        ["focus", `${controls}[normalize-space(.)="Revoke"]`],
        ["press", "Enter"],
        ["wait", form],
        [
          "find",
          "role",
          "button",
          "click",
          "--name",
          "Confirm revocation",
          "--exact",
        ],
        ["wait", "--text", "Token revoked."],
      )
      const revokedAt = Date.now()
      await denied(beforeRevoke, revokedAt, `${width}: revocation`)
      const afterRevocationId = await ceased(
        width,
        "revocation",
        revokedAt,
        beforeRevocationLive,
      )
      const currentDocument = await restrictedPage.evaluate(
        () => performance.timeOrigin,
      )
      const reentered = currentDocument !== restrictedDocument
      const humanBinding = ownerLive.bindings.get(subscriberPage)
      assert(
        humanBinding && humanBinding !== restrictedBinding,
        "Independent subscriber did not retain a distinct human binding",
      )
      // Re-entry and delivery are observations, not required outcomes: staying
      // delegated without receiving the new event is also valid.
      writeFileSync(
        join(evidence, `joined-transition-diagnostics-${width}.json`),
        JSON.stringify(
          {
            initialNavigations: restrictedNavigationCount,
            currentNavigations: ownerLive.navigations.get(restrictedPage),
            sameBinding:
              ownerLive.bindings.get(restrictedPage) === restrictedBinding,
            explicitDocumentReentry: reentered,
            websocketReceived: ownerLive.events.some(
              (event) =>
                event.page === restrictedPage &&
                event.executionId === afterRevocationId,
            ),
            httpReceived: ownerLive.pulls.some(
              (pull) =>
                pull.page === restrictedPage &&
                pull.executionId === afterRevocationId,
            ),
            path: new URL(restrictedPage.url()).pathname,
          },
          null,
          2,
        ),
      )
      assert(
        !ownerLive.events.some(
          (event) =>
            event.page === restrictedPage &&
            (!reentered ||
              event.binding !== humanBinding ||
              event.at < currentDocument) &&
            event.executionId === afterRevocationId,
        ) &&
          !ownerLive.pulls.some(
            (pull) =>
              pull.page === restrictedPage &&
              (!reentered ||
                pull.binding !== humanBinding ||
                pull.at < currentDocument) &&
              pull.executionId === afterRevocationId,
          ),
        "Old restricted binding or unchanged document received data through the human cookie jar",
      )
      assert(
        reentered ||
          ownerLive.navigations.get(restrictedPage) ===
            restrictedNavigationCount,
        "Restricted tab changed navigation without an explicit document re-entry",
      )
      assert(
        ownerLive.bindings.get(restrictedPage) ===
          (reentered ? humanBinding : restrictedBinding),
        "Restricted tab did not preserve its binding or explicitly re-enter the human scope",
      )
      await ab(owner, ["tab", "restricted"])
      assert(
        await evaluate(
          owner,
          `Boolean(document.querySelector('[data-testid="header-profile-button"]')?.getAttribute('aria-label')?.includes(${JSON.stringify(`renamed-${width}`)})) === ${!reentered}`,
        ),
        "Old restricted view silently became human",
      )
      await shot(owner, `joined-transition-no-broad-data-${width}.png`)
      await ab(owner, ["tab", "close", "restricted"], ["tab", "t1"])
      record(
        `${width}: after human login in another tab, no new revoked-generation data enters the old delegated binding or unchanged document`,
        { executionId: afterRevocationId, explicitDocumentReentry: reentered },
      )
      await login(replacementSecret, false)
      await ab(
        owner,
        ["reload"],
        [
          "wait",
          "--fn",
          `Array.from(document.querySelectorAll('article')).some(card => card.dataset.tokenId === ${JSON.stringify(delegationId)} && card.querySelector('span')?.textContent === 'Revoked')`,
        ],
      )
      assert(
        await evaluate(
          owner,
          "document.documentElement.scrollWidth <= innerWidth",
        ),
        "Management overflows viewport",
      )
      await shot(owner, `joined-owner-revoked-${width}.png`)
      await shot(agent, `joined-revoked-agent-${width}.png`)
      record(
        `${width}: revoked secret login denied and persisted revoked metadata has no disclosure or horizontal overflow`,
      )
      await ab(
        owner,
        ["open", `${handoff.frontend}/executions/${executionId}`],
        ["wait", "--text", `lifecycle-owner@example.test via renamed-${width}`],
      )
      assert(
        await evaluate(
          owner,
          `document.body.innerText.includes('lifecycle-owner@example.test via renamed-${width}') && document.body.innerText.includes('Review request')`,
        ),
        "Accepted work or initiating attribution missing after revocation",
      )
      await shot(owner, `joined-accepted-work-after-revocation-${width}.png`)
      record(
        `${width}: accepted process and worker-created Review request survive revocation with delegated initiation attribution`,
        { executionId },
      )
      if (cliMode) {
        const audit = Schema.decodeUnknownSync(
          Schema.Array(
            Schema.Struct({
              id: Schema.String,
              actor: Schema.NullOr(
                Schema.Struct({
                  delegationId: Schema.String,
                  generationId: Schema.String,
                }),
              ),
            }),
          ),
        )(JSON.parse(readFileSync(handoff.auditPath, "utf8")))
        const initiated = audit.find((row) => row.id === executionId)
        assert(
          initiated?.actor?.delegationId === replacement.id &&
            initiated.actor.generationId === replacement.generation,
          "SQLite CLI audit lost delegation or generation",
        )
        record(
          "Persisted SQLite ordinary-work audit retains exported Delegation ID and Secret Generation after revocation",
          {
            executionId,
            delegationId: replacement.id,
            generationId: replacement.generation,
          },
        )
      }
    }
    assert(
      failedHandoffExitCodes.every((code) => code !== 0),
      "CLI failure callbacks must exit unsuccessfully",
    )
    record(
      cliMode
        ? "Joined browser/CLI lifecycle complete"
        : "Joined local WebSocket lifecycle complete; no managed AppSync claim",
      { widths },
    )
  }
} catch (error) {
  // Do not print upstream errors, commands, snapshots, URLs or credential values.
  console.error(
    `FAIL during ${stage}; completed checks are in the evidence directory`,
  )
  if (error instanceof ProbeFailure) console.error(error.message)
  if (administration) {
    for (const session of [owner, administrator]) {
      if (
        await evaluate(
          session,
          "location.pathname === '/act-on-behalf' || location.pathname.endsWith('/tokens')",
        ).catch(() => false)
      )
        await shot(
          session,
          `administration-failure-${session === owner ? "owner" : "administrator"}.png`,
        ).catch(() => {})
    }
    writeFileSync(
      join(evidence, "administration-failure.json"),
      JSON.stringify(
        {
          stage,
          error:
            error instanceof ProbeFailure
              ? error.message
              : "Upstream error withheld to protect credentials",
          completedChecks: checks.length,
        },
        null,
        2,
      ),
    )
  }
  writeFileSync(
    join(evidence, "joined-failure-results.json"),
    JSON.stringify(
      { stage, graphqlHttpFailures: [...graphqlHttpFailures] },
      null,
      2,
    ),
  )
  await shot(agent, "joined-failure.png").catch(() => {})
  await shot(owner, "joined-owner-failure.png").catch(() => {})
  process.exitCode = 1
} finally {
  await cleanup()
}
