"use client"

import { createContext, useContext, useState } from "react"

interface MocksContextValue {
  showMocks: boolean
  setShowMocks: (show: boolean) => void
}

const MocksContext = createContext<MocksContextValue>({
  showMocks: false,
  setShowMocks: () => {},
})

export function MocksProvider({ children }: { children: React.ReactNode }) {
  const [showMocks, setShowMocks] = useState(false)

  return (
    <MocksContext.Provider value={{ showMocks, setShowMocks }}>
      {children}
    </MocksContext.Provider>
  )
}

export function useMocks() {
  return useContext(MocksContext)
}
