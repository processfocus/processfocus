export type ImportCompletedPayload = {
  readonly processPaths: readonly string[]
}

type Subscriber = {
  readonly send: (payload: ImportCompletedPayload) => void
}

// Dev-only, process-local subscriber registry for the running Next server.
const subscribers = new Set<Subscriber>()

export const addImportCompletedSubscriber = (subscriber: Subscriber) => {
  subscribers.add(subscriber)
  return () => subscribers.delete(subscriber)
}

export const publishImportCompleted = (payload: ImportCompletedPayload) => {
  for (const subscriber of subscribers) {
    subscriber.send(payload)
  }
}
