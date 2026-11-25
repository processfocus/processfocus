"use client"

import { type ReactNode, useEffect, useState } from "react"

// Render real fallback HTML rather than throwing a browser() bailout outside
// the page's instant-validation boundary. Keep browser-only imports lazy too.
export function BrowserOnly({
  children,
  fallback = null,
}: {
  children: ReactNode
  fallback?: ReactNode
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  return mounted ? children : fallback
}
