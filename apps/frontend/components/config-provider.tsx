// components/config-provider.tsx
"use client"

import { type ReactNode, createContext, useContext } from "react"
import type { RuntimeConfig } from "@/lib/runtime-config"

const ConfigContext = createContext<RuntimeConfig | null>(null)

export function ConfigProvider({
  value,
  children,
}: {
  value: RuntimeConfig
  children: ReactNode
}) {
  return (
    <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>
  )
}

export function useRuntimeConfig(): RuntimeConfig {
  const ctx = useContext(ConfigContext)
  if (!ctx) {
    throw new Error("useRuntimeConfig must be used within <ConfigProvider>")
  }
  return ctx
}
