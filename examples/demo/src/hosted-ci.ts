import { Effect } from "effect"

// The standalone demo has no hosted CI identities.
export const hostedCiFields = {}
export const hostedCiPolicyFiles: string[] = []
export const hostedCiClients = Effect.succeed({})
