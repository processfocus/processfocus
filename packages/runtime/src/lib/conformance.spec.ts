import { Context, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import type { RuntimeLogging } from "./runtime.js"
import { Runtime } from "./runtime.js"

const capability = <Identifier, Service>(
  tag: Context.Tag<Identifier, Service>,
  service: NoInfer<Service>,
  name: string,
  events: string[],
) =>
  Layer.effect(
    tag,
    Effect.sync(() => {
      events.push(name)
      return service
    }),
  )

const logging = (events: string[]): RuntimeLogging => ({
  decorate: (effect) =>
    Effect.sync(() => events.push("logging")).pipe(Effect.zipRight(effect)),
})

describe("runtime capability composition", () => {
  it("acquires every authentication capability before starting the server", async () => {
    const events: string[] = []
    const Database = Context.GenericTag<{ readonly database: true }>("Database")
    const Configuration = Context.GenericTag<{ readonly configuration: true }>(
      "Configuration",
    )
    const Policy = Context.GenericTag<{ readonly policy: true }>("Policy")

    const result = await Effect.runPromise(
      Runtime.authentication({
        database: capability(Database, { database: true }, "database", events),
        configuration: capability(
          Configuration,
          { configuration: true },
          "configuration",
          events,
        ),
        policy: capability(Policy, { policy: true }, "policy", events),
        server: (services) =>
          Effect.sync(() => {
            Context.get(services, Database)
            Context.get(services, Configuration)
            Context.get(services, Policy)
            events.push("server")
            return "started"
          }),
        logging: logging(events),
      }),
    )

    expect(result).toBe("started")
    expect(events).toEqual([
      "logging",
      "database",
      "configuration",
      "policy",
      "server",
    ])
  })

  it("supplies every GraphQL capability to the transport", async () => {
    const events: string[] = []
    const Persistence = Context.GenericTag<{ readonly persistence: true }>(
      "Persistence",
    )
    const Queue = Context.GenericTag<{ readonly queue: true }>("Queue")
    const DocumentStore = Context.GenericTag<{ readonly documentStore: true }>(
      "DocumentStore",
    )
    const EventPublisher = Context.GenericTag<{
      readonly eventPublisher: true
    }>("EventPublisher")
    const OrganisationLoader = Context.GenericTag<{
      readonly organisationLoader: true
    }>("OrganisationLoader")
    const Authorization = Context.GenericTag<{ readonly authorization: true }>(
      "Authorization",
    )

    const result = await Effect.runPromise(
      Runtime.graphql({
        persistence: capability(
          Persistence,
          { persistence: true },
          "persistence",
          events,
        ),
        queue: capability(Queue, { queue: true }, "queue", events),
        documentStore: capability(
          DocumentStore,
          { documentStore: true },
          "document-store",
          events,
        ),
        eventPublisher: capability(
          EventPublisher,
          { eventPublisher: true },
          "event-publisher",
          events,
        ),
        organisationLoader: capability(
          OrganisationLoader,
          { organisationLoader: true },
          "organisation-loader",
          events,
        ),
        authorization: capability(
          Authorization,
          { authorization: true },
          "authorization",
          events,
        ),
        transport: (services) =>
          Effect.sync(() => {
            Context.get(services, Persistence)
            Context.get(services, Queue)
            Context.get(services, DocumentStore)
            Context.get(services, EventPublisher)
            Context.get(services, OrganisationLoader)
            Context.get(services, Authorization)
            events.push("transport")
            return "started"
          }),
        logging: logging(events),
      }),
    )

    expect(result).toBe("started")
    expect(events).toEqual([
      "logging",
      "persistence",
      "queue",
      "document-store",
      "event-publisher",
      "organisation-loader",
      "authorization",
      "transport",
    ])
  })
})
