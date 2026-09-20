"use client"
import { createContext, useContext } from "react"

interface OrgSettings {
  startDayOfWeek: number
}

const OrgSettingsContext = createContext<OrgSettings>({ startDayOfWeek: 0 })

export function OrgSettingsProvider({
  startDayOfWeek,
  children,
}: {
  startDayOfWeek: number
  children: React.ReactNode
}) {
  return (
    <OrgSettingsContext.Provider value={{ startDayOfWeek }}>
      {children}
    </OrgSettingsContext.Provider>
  )
}

export function useOrgSettings() {
  return useContext(OrgSettingsContext)
}
