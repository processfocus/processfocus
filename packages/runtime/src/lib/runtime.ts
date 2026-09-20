import { type Context, Effect, Layer } from "effect"
import type * as EffectLayer from "effect/Layer"
import type { RuntimeArtifactEnvelope } from "./artifact.js"
import { parseRuntimeArtifact } from "./artifact.js"
import type { JobDispatcher } from "./job.js"
import type { RawJob } from "./queue.js"

type AnyLayer = Layer.Layer<never, unknown, unknown>
type LayerServices<T extends AnyLayer> = EffectLayer.Layer.Success<T>
type ClosedLayer<T extends AnyLayer> = T &
  Layer.Layer<LayerServices<T>, EffectLayer.Layer.Error<T>>

export interface RuntimeLogging<LoggingError = never> {
  readonly decorate: <Result, Error>(
    effect: Effect.Effect<Result, Error>,
  ) => Effect.Effect<Result, Error | LoggingError>
}

export interface AuthenticationCapabilities<
  DatabaseLayer extends AnyLayer,
  ConfigurationLayer extends AnyLayer,
  PolicyLayer extends AnyLayer,
  Result,
  ServerError,
  LoggingError,
> {
  readonly database: ClosedLayer<DatabaseLayer>
  readonly configuration: ClosedLayer<ConfigurationLayer>
  readonly policy: ClosedLayer<PolicyLayer>
  readonly server: (
    services: Context.Context<
      | LayerServices<DatabaseLayer>
      | LayerServices<ConfigurationLayer>
      | LayerServices<PolicyLayer>
    >,
  ) => Effect.Effect<Result, ServerError>
  readonly logging: RuntimeLogging<LoggingError>
}

export interface GraphqlCapabilities<
  PersistenceLayer extends AnyLayer,
  QueueLayer extends AnyLayer,
  DocumentStoreLayer extends AnyLayer,
  EventPublisherLayer extends AnyLayer,
  OrganisationLoaderLayer extends AnyLayer,
  AuthorizationLayer extends AnyLayer,
  Result,
  TransportError,
  LoggingError,
> {
  readonly persistence: ClosedLayer<PersistenceLayer>
  readonly queue: ClosedLayer<QueueLayer>
  readonly documentStore: ClosedLayer<DocumentStoreLayer>
  readonly eventPublisher: ClosedLayer<EventPublisherLayer>
  readonly organisationLoader: ClosedLayer<OrganisationLoaderLayer>
  readonly authorization: ClosedLayer<AuthorizationLayer>
  readonly transport: (
    services: Context.Context<
      | LayerServices<PersistenceLayer>
      | LayerServices<QueueLayer>
      | LayerServices<DocumentStoreLayer>
      | LayerServices<EventPublisherLayer>
      | LayerServices<OrganisationLoaderLayer>
      | LayerServices<AuthorizationLayer>
    >,
  ) => Effect.Effect<Result, TransportError>
  readonly logging: RuntimeLogging<LoggingError>
}

export interface PersistencePort<Error, Requirements> {
  readonly transaction: <Result>(
    operation: Effect.Effect<Result, Error, Requirements>,
  ) => Effect.Effect<Result, Error, Requirements>
}

export interface OrganisationLoaderPort<
  Organisation,
  Input,
  Error,
  Requirements,
> {
  readonly load: (
    input: Input,
  ) => Effect.Effect<Organisation, Error, Requirements>
}

export interface OrganisationHydrationPort<Organisation, Error, Requirements> {
  readonly hydrate: (
    organisation: Organisation,
  ) => Effect.Effect<void, Error, Requirements>
}

/**
 * Concrete generic runtime operations. Platform adapters provide mechanics to
 * each operation; orchestration, tracing and contract parsing stay here.
 */
export const Runtime = {
  authentication: <
    DatabaseLayer extends AnyLayer,
    ConfigurationLayer extends AnyLayer,
    PolicyLayer extends AnyLayer,
    Result,
    ServerError,
    LoggingError,
  >(
    capabilities: AuthenticationCapabilities<
      DatabaseLayer,
      ConfigurationLayer,
      PolicyLayer,
      Result,
      ServerError,
      LoggingError
    >,
  ) => {
    const database: Layer.Layer<
      LayerServices<DatabaseLayer>,
      EffectLayer.Layer.Error<DatabaseLayer>
    > = capabilities.database
    const configuration: Layer.Layer<
      LayerServices<ConfigurationLayer>,
      EffectLayer.Layer.Error<ConfigurationLayer>
    > = capabilities.configuration
    const policy: Layer.Layer<
      LayerServices<PolicyLayer>,
      EffectLayer.Layer.Error<PolicyLayer>
    > = capabilities.policy

    return capabilities.logging.decorate(
      Layer.build(Layer.mergeAll(database, configuration, policy)).pipe(
        Effect.flatMap(capabilities.server),
        Effect.scoped,
        Effect.withSpan("runtime.authentication"),
      ),
    )
  },

  graphql: <
    PersistenceLayer extends AnyLayer,
    QueueLayer extends AnyLayer,
    DocumentStoreLayer extends AnyLayer,
    EventPublisherLayer extends AnyLayer,
    OrganisationLoaderLayer extends AnyLayer,
    AuthorizationLayer extends AnyLayer,
    Result,
    TransportError,
    LoggingError,
  >(
    capabilities: GraphqlCapabilities<
      PersistenceLayer,
      QueueLayer,
      DocumentStoreLayer,
      EventPublisherLayer,
      OrganisationLoaderLayer,
      AuthorizationLayer,
      Result,
      TransportError,
      LoggingError
    >,
  ) => {
    const persistence: Layer.Layer<
      LayerServices<PersistenceLayer>,
      EffectLayer.Layer.Error<PersistenceLayer>
    > = capabilities.persistence
    const queue: Layer.Layer<
      LayerServices<QueueLayer>,
      EffectLayer.Layer.Error<QueueLayer>
    > = capabilities.queue
    const documentStore: Layer.Layer<
      LayerServices<DocumentStoreLayer>,
      EffectLayer.Layer.Error<DocumentStoreLayer>
    > = capabilities.documentStore
    const eventPublisher: Layer.Layer<
      LayerServices<EventPublisherLayer>,
      EffectLayer.Layer.Error<EventPublisherLayer>
    > = capabilities.eventPublisher
    const organisationLoader: Layer.Layer<
      LayerServices<OrganisationLoaderLayer>,
      EffectLayer.Layer.Error<OrganisationLoaderLayer>
    > = capabilities.organisationLoader
    const authorization: Layer.Layer<
      LayerServices<AuthorizationLayer>,
      EffectLayer.Layer.Error<AuthorizationLayer>
    > = capabilities.authorization

    return capabilities.logging.decorate(
      Layer.build(
        Layer.mergeAll(
          persistence,
          queue,
          documentStore,
          eventPublisher,
          organisationLoader,
          authorization,
        ),
      ).pipe(
        Effect.flatMap(capabilities.transport),
        Effect.scoped,
        Effect.withSpan("runtime.graphql"),
      ),
    )
  },

  job: <Requirements>(dispatcher: JobDispatcher<Requirements>, job: RawJob) =>
    dispatcher.dispatch(job),

  loadArtifact: (load: Effect.Effect<unknown>) =>
    load.pipe(
      Effect.flatMap(parseRuntimeArtifact),
      Effect.withSpan("runtime.artifact.load"),
    ),

  loadOrganisation: <Organisation, Input, Error, Requirements>(
    port: OrganisationLoaderPort<Organisation, Input, Error, Requirements>,
    input: Input,
  ) => port.load(input).pipe(Effect.withSpan("runtime.organisation.load")),

  hydrateOrganisation: <Organisation, Error, Requirements>(
    port: OrganisationHydrationPort<Organisation, Error, Requirements>,
    persistence: PersistencePort<Error, Requirements>,
    organisation: Organisation,
  ) =>
    persistence
      .transaction(port.hydrate(organisation))
      .pipe(Effect.withSpan("runtime.organisation.hydrate")),
} as const

export type { RuntimeArtifactEnvelope }
