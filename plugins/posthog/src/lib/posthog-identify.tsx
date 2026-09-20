"use client"

import { useLayoutEffect, useRef, useSyncExternalStore } from "react"
import { getInitializedPostHogClient } from "./posthog-client"
import {
  clearPostHogIdentityResetPending,
  markPostHogIdentityResetPending,
} from "./posthog-identity-state"
import {
  getPostHogReadySnapshot,
  subscribeToPostHogReady,
} from "./posthog-ready-store"

export const resetPostHogIdentity = (): void => {
  markPostHogIdentityResetPending()

  const client = getInitializedPostHogClient()

  if (!client) {
    return
  }

  client.reset()
  clearPostHogIdentityResetPending()
}

const buildPersonProperties = ({
  email,
  name,
  username,
}: {
  readonly email: string | undefined
  readonly name: string | undefined
  readonly username: string
}) => ({
  ...(email ? { email } : {}),
  ...(name ? { name } : {}),
  username,
})

export function PostHogIdentify({
  email,
  name,
  userId,
  username,
}: {
  readonly email?: string
  readonly name?: string
  readonly userId: string
  readonly username: string
}) {
  const isReady = useSyncExternalStore(
    subscribeToPostHogReady,
    getPostHogReadySnapshot,
    () => false,
  )
  const lastIdentifiedUserId = useRef<string | null>(null)

  useLayoutEffect(
    () => () => {
      resetPostHogIdentity()
    },
    [],
  )

  useLayoutEffect(() => {
    if (!isReady) {
      return
    }

    const client = getInitializedPostHogClient()

    if (!client) {
      return
    }

    const personProperties = buildPersonProperties({ email, name, username })

    const shouldResetForUserChange =
      lastIdentifiedUserId.current !== null &&
      lastIdentifiedUserId.current !== userId

    if (shouldResetForUserChange) {
      client.reset()
    }

    if (client.get_distinct_id() !== userId) {
      // Reset before identify so public/embed activity stays anonymous.
      if (!shouldResetForUserChange) {
        client.reset()
      }
      client.identify(userId, personProperties)
    } else {
      client.setPersonProperties(personProperties)
    }

    lastIdentifiedUserId.current = userId
  }, [email, isReady, name, userId, username])

  return null
}
