"use client"

import { createContext, useContext } from "react"
import {
  type FeaturePermissions,
  noFeaturePermissions,
} from "@/lib/feature-permissions"

const FeaturePermissionsContext =
  createContext<FeaturePermissions>(noFeaturePermissions)

export function FeaturePermissionsProvider({
  value,
  children,
}: {
  value: FeaturePermissions
  children: React.ReactNode
}) {
  return (
    <FeaturePermissionsContext.Provider value={value}>
      {children}
    </FeaturePermissionsContext.Provider>
  )
}

export function useFeaturePermissions() {
  return useContext(FeaturePermissionsContext)
}
