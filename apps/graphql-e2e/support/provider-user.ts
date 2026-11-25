import type { ITestCaseHookParameter } from "@cucumber/cucumber"
import { type Browser, chromium } from "@playwright/test"
import { Option, Schema } from "effect"
import {
  getEffectiveFrontendBaseUrl,
  getEffectiveGraphqlEndpoint,
} from "@pf/frontend-endpoints/port-files"
import {
  type PasskeyUser,
  createPasskeyUser,
} from "../../frontend-e2e/src/steps/passkey-user"
import { runAuthenticate } from "./auth-helpers"
import { withPausedLocalWorker } from "./local-worker-pause"
import { runsInThisEnvironment } from "./scenario-environment"

// Feature-file emails describe grants; registrations always get unique addresses.
const personas: Record<string, { roles: string[]; marker: string }> = {
  "ci@example.com": { roles: ["/Employee"], marker: "CI" },
  "employee@example.com": { roles: ["/Employee"], marker: "Employee" },
  "employee-2@example.com": { roles: ["/Employee"], marker: "Observer" },
  "finance-manager@example.com": {
    roles: ["/finance/Manager"],
    marker: "Finance",
  },
  "procurement-manager@example.com": {
    roles: ["/procurement/Manager"],
    marker: "Procurement",
  },
}
const users = new Map<string, Promise<PasskeyUser>>()
const readerScope = Symbol("worker-owned readers")
const readers = new Map<string, Promise<PasskeyUser>>()
let browser: Promise<Browser> | undefined

const createUser = async (persona: string): Promise<PasskeyUser> => {
  const config = personas[persona]
  if (!config) throw new Error(`Unknown GraphQL user persona: ${persona}`)
  const configuredFrontend = process.env["FRONTEND_BASE_URL"]
  const baseURL =
    configuredFrontend && new URL(configuredFrontend).port
      ? configuredFrontend
      : getEffectiveFrontendBaseUrl()
  browser ??= chromium.launch().catch((error: unknown) => {
    browser = undefined
    throw error
  })
  const activeBrowser = await browser
  const endpoint = getEffectiveGraphqlEndpoint()
  const user = await withPausedLocalWorker(() =>
    createPasskeyUser(activeBrowser, {
      baseURL,
      graphqlEndpoint: endpoint,
      workerIndex: Number(process.env["CUCUMBER_WORKER_ID"] ?? 0),
      invite: async (email) => {
        const machine = await runAuthenticate()
        if (!machine.access_token)
          throw new Error("Invitation setup authentication failed")
        const request = async (
          query: string,
          variables = {},
        ): Promise<unknown> =>
          (
            await fetch(endpoint, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${machine.access_token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ query, variables }),
            })
          ).json()
        const roles = Schema.decodeUnknownSync(
          Schema.Struct({
            data: Schema.Struct({
              allRoles: Schema.Struct({
                items: Schema.Array(
                  Schema.Struct({ id: Schema.String, path: Schema.String }),
                ),
              }),
            }),
          }),
        )(await request("{ allRoles(limit: 100) { items { id path } } }"))
        const paths = [...config.roles, `/GraphQLE2E${config.marker}`]
        const roleIds = paths.map((path) => {
          const role = roles.data.allRoles.items.find(
            (role) => role.path === path,
          )
          if (!role) throw new Error(`Missing GraphQL fixture role: ${path}`)
          return role.id
        })
        const created = Schema.decodeUnknownSync(
          Schema.Struct({
            data: Schema.Struct({
              createInvitation: Schema.Struct({
                invitation: Schema.Struct({ id: Schema.String }),
              }),
            }),
          }),
        )(
          await request(
            `mutation($input: SaveInvitationInput!) {
          createInvitation(input: $input) {
            ... on SaveInvitationSuccess { invitation { id } }
            ... on SaveInvitationFailure { error }
          }
        }`,
            { input: { email, roleIds } },
          ),
        )
        const response = await request(
          `mutation($id: ID!) {
          generateRegistrationLink(invitationId: $id) {
            ... on RegistrationLinkActionSuccess { registrationLinkUrl }
          }
        }`,
          { id: created.data.createInvitation.invitation.id },
        )
        // Do not include the bearer Registration Link in validation errors.
        const link = Schema.decodeUnknownOption(
          Schema.Struct({
            data: Schema.Struct({
              generateRegistrationLink: Schema.Struct({
                registrationLinkUrl: Schema.String,
              }),
            }),
          }),
        )(response)
        if (Option.isNone(link))
          throw new Error("Invitation setup did not return a Registration Link")
        return link.value.data.generateRegistrationLink.registrationLinkUrl
      },
    }),
  )
  return {
    ...user,
    credentials: () => withPausedLocalWorker(user.credentials),
  }
}

interface PlannedUser {
  owner: string | typeof readerScope
  persona: string
  ready?: Promise<PasskeyUser>
}
let pending: PlannedUser[] = []
let currentScenario: string

export const planProviderUsers = (
  scenarios: ITestCaseHookParameter["pickle"][],
) => {
  for (const scenario of scenarios) {
    if (!runsInThisEnvironment(scenario)) continue
    const { id, steps } = scenario
    for (const { text } of steps) {
      const reader = /^I read as provider user "([^"]+)"$/.exec(text)?.[1]
      const owner = reader ? readerScope : id
      const persona =
        reader ??
        /^(?:I am|"[^"]+" is) authenticated as provider user "([^"]+)"$/.exec(
          text,
        )?.[1]
      if (
        persona &&
        !pending.some(
          (slot) => slot.owner === owner && slot.persona === persona,
        )
      ) {
        pending.push({ owner, persona })
      }
    }
  }
}

// Limit the lookahead to four buffered identities. All scenario steps stay serial.
const prepareUpcoming = () => {
  for (const slot of pending.slice(0, 4)) {
    if (slot.ready) continue
    slot.ready = createUser(slot.persona)
    // The owning Given observes the same failure when it reaches this slot.
    void slot.ready.catch(() => {})
  }
}

export const beginProviderScenario = (id: string) => {
  currentScenario = id
  prepareUpcoming()
}

const acquire = async (
  persona: string,
  owner: PlannedUser["owner"],
): Promise<PasskeyUser> => {
  const cache = owner === readerScope ? readers : users
  const existing = cache.get(persona)
  if (existing) return existing
  const index = pending.findIndex(
    (slot) => slot.owner === owner && slot.persona === persona,
  )
  const slot = index < 0 ? undefined : pending.splice(index, 1)[0]
  const ready = slot?.ready ?? createUser(persona)
  cache.set(persona, ready)
  const user = await ready.catch((error: unknown) => {
    cache.delete(persona) // A Cucumber retry can register again after a failed setup.
    throw error
  })
  prepareUpcoming()
  return user
}

export const providerUser = (persona: string) =>
  acquire(persona, currentScenario)

// Only read-only Givens borrow a worker's user. Call credentials() at each
// handoff so an expired session signs back in with its own authenticator.
export const readerCredentials = async (persona: string) => {
  const reader = await acquire(persona, readerScope)
  try {
    return await reader.credentials()
  } catch (error) {
    // Normal login recovery failed; don't lend this session to another scenario.
    readers.delete(persona)
    await reader.dispose()
    throw error
  }
}

const dispose = async (fixtures: (Promise<PasskeyUser> | undefined)[]) => {
  await Promise.all(
    fixtures.map(async (ready) => {
      const user = await ready?.catch(() => undefined)
      await user?.dispose()
    }),
  )
}

export const disposeProviderUsers = async (scenario: string): Promise<void> => {
  const unused = pending.filter((slot) => slot.owner === scenario)
  pending = pending.filter((slot) => slot.owner !== scenario)
  try {
    await dispose([...users.values(), ...unused.map((slot) => slot.ready)])
  } finally {
    users.clear()
    if (pending.length === 0 && readers.size === 0) await stopProviderUsers()
  }
}

export const stopProviderUsers = async (): Promise<void> => {
  try {
    await dispose([...readers.values(), ...pending.map((slot) => slot.ready)])
  } finally {
    readers.clear()
    pending = []
    const closing = browser
    browser = undefined
    await (await closing)?.close()
  }
}
