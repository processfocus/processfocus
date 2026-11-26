import { Effect } from "effect"
import { notFound } from "next/navigation"

export const NotFound: Effect.Effect<never> = Effect.sync(notFound)
