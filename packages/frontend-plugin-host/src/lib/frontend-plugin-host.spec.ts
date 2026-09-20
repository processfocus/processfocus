import type {
  GraphqlRequester,
  OrganisationFrontendPluginHost,
} from "./frontend-plugin-host"
import {
  DuplicatePluginRegistrationError,
  activateOrganisationFrontendPlugin,
  activateOrganisationFrontendPlugins,
  createRegistrationRegistry,
} from "./frontend-plugin-host"
import { describe, expect, test } from "bun:test"

const unusedRequest: GraphqlRequester["request"] = async () => {
  throw new Error("not used")
}

const host = {
  kind: "organisation-plugin-host",
  interfaceVersion: 1,
  analytics: { register: () => () => undefined },
  formRenderers: { register: () => () => undefined },
  executionMenu: { register: () => () => undefined },
  graphql: {
    ClientConsumer: ({ children }) => children({ request: unusedRequest }),
  },
} satisfies OrganisationFrontendPluginHost

describe("organisation frontend plugin registrations", () => {
  test("rejects duplicate identities", () => {
    const registry = createRegistrationRegistry<{ readonly id: string }>(
      (registration) => registration.id,
    )

    registry.register({ id: "analytics" })

    expect(() => registry.register({ id: "analytics" })).toThrow(
      DuplicatePluginRegistrationError,
    )
    expect(registry.list()).toEqual([{ id: "analytics" }])
  })

  test("isolates reset failures, resets remaining plugins, and clears state", () => {
    const registry = createRegistrationRegistry<{ readonly id: string }>(
      (registration) => registration.id,
    )
    const resetIds: string[] = []
    const failedIds: string[] = []
    registry.register({ id: "broken" })
    registry.register({ id: "healthy" })

    registry.reset(
      (registration) => {
        if (registration.id === "broken") throw new Error("reset failed")
        resetIds.push(registration.id)
      },
      (_cause, registration) => failedIds.push(registration.id),
    )

    expect(resetIds).toEqual(["healthy"])
    expect(failedIds).toEqual(["broken"])
    expect(registry.list()).toEqual([])
  })
})

describe("organisation frontend plugin activation", () => {
  test("isolates a failed plugin activation", async () => {
    const activated: string[] = []
    const failures: string[] = []

    await activateOrganisationFrontendPlugins(
      [
        {
          id: "broken",
          activate: () => {
            throw new Error("activation failed")
          },
        },
        {
          id: "healthy",
          activate: () => {
            activated.push("healthy")
          },
        },
      ],
      host,
      (failure) => failures.push(failure.pluginId),
    )

    expect(activated).toEqual(["healthy"])
    expect(failures).toEqual(["broken"])
  })

  test("reports and skips duplicate plugin identities", async () => {
    const activated: string[] = []
    const failures: Array<{ pluginId: string; cause: unknown }> = []

    await activateOrganisationFrontendPlugins(
      [
        {
          id: "analytics",
          activate: () => {
            activated.push("first")
          },
        },
        {
          id: "analytics",
          activate: () => {
            activated.push("duplicate")
          },
        },
      ],
      host,
      (failure) => failures.push(failure),
    )

    expect(activated).toEqual(["first"])
    expect(failures).toHaveLength(1)
    expect(failures[0]?.pluginId).toBe("analytics")
    expect(failures[0]?.cause).toBeInstanceOf(DuplicatePluginRegistrationError)
  })

  test("activates plugins in supplied order", async () => {
    const activationOrder: string[] = []

    await activateOrganisationFrontendPlugins(
      [
        {
          id: "first",
          activate: async () => {
            await Promise.resolve()
            activationOrder.push("first")
          },
        },
        {
          id: "second",
          activate: () => {
            activationOrder.push("second")
          },
        },
      ],
      host,
    )

    expect(activationOrder).toEqual(["first", "second"])
  })

  test("rolls back partial registration before an activation retry", async () => {
    const analytics = createRegistrationRegistry<{ readonly type: string }>(
      (registration) => registration.type,
    )
    const transactionalHost = {
      ...host,
      analytics,
    } satisfies OrganisationFrontendPluginHost
    let shouldFail = true
    const plugin = {
      id: "analytics",
      activate: async (activationHost: OrganisationFrontendPluginHost) => {
        activationHost.analytics.register({
          type: "analytics",
          render: () => null,
        })
        await Promise.resolve()
        if (shouldFail) {
          shouldFail = false
          throw new Error("activation failed")
        }
      },
    }

    await expect(
      activateOrganisationFrontendPlugin(plugin, transactionalHost),
    ).rejects.toThrow("activation failed")
    expect(analytics.list()).toEqual([])

    await activateOrganisationFrontendPlugin(plugin, transactionalHost)
    expect(analytics.list()).toHaveLength(1)
  })

  test("supports a no-plugin host", async () => {
    const failures: string[] = []

    await activateOrganisationFrontendPlugins([], host, (failure) =>
      failures.push(failure.pluginId),
    )

    expect(failures).toEqual([])
  })
})
