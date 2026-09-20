"use client"

import { useEffect, useRef, useState } from "react"

/** The protected layout renders only this boundary when live facts outpace its JWT. */
export function SessionReissue() {
  const request = useRef<Promise<boolean> | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    request.current ??= fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
    }).then(async (response) => {
      const data: unknown = response.ok ? await response.json() : null
      return (
        typeof data === "object" &&
        data !== null &&
        "success" in data &&
        data.success === true
      )
    })
    void request.current
      .then((success) => {
        if (cancelled) return
        if (success) {
          window.location.reload()
        } else {
          setFailed(true)
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <div role="status">
      {failed ? (
        <a href="/login">Your session could not be renewed. Log in again.</a>
      ) : (
        "Renewing your session..."
      )}
    </div>
  )
}
