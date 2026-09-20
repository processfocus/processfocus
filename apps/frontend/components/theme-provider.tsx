"use client"

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react"
import {
  type ResolvedTheme,
  THEMES,
  THEME_QUERY,
  THEME_STORAGE_KEY,
  type Theme,
  isTheme,
} from "@/lib/theme"

interface ThemeProviderState {
  readonly resolvedTheme: ResolvedTheme
  readonly setTheme: (theme: string) => void
  readonly theme: Theme
  readonly themes: readonly Theme[]
}

const ThemeContext = createContext<ThemeProviderState | null>(null)

const getStoredTheme = (): Theme => {
  if (typeof window === "undefined") {
    return "system"
  }

  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isTheme(storedTheme) ? storedTheme : "system"
  } catch {
    return "system"
  }
}

const getSystemTheme = (): ResolvedTheme => {
  if (typeof window === "undefined") {
    return "light"
  }

  return window.matchMedia(THEME_QUERY).matches ? "dark" : "light"
}

const applyTheme = (theme: Theme, systemTheme: ResolvedTheme): void => {
  const resolvedTheme = theme === "system" ? systemTheme : theme
  const root = document.documentElement

  root.classList.remove("light", "dark")
  root.classList.add(resolvedTheme)
  root.style.colorScheme = resolvedTheme
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme)
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme)

  useLayoutEffect(() => {
    applyTheme(theme, systemTheme)
  }, [theme, systemTheme])

  useEffect(() => {
    const mediaQuery = window.matchMedia(THEME_QUERY)
    const handleChange = () => setSystemTheme(getSystemTheme())

    mediaQuery.addEventListener("change", handleChange)

    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [])

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) {
        return
      }

      setThemeState(isTheme(event.newValue) ? event.newValue : "system")
    }

    window.addEventListener("storage", handleStorage)

    return () => window.removeEventListener("storage", handleStorage)
  }, [])

  const setTheme = useCallback((nextTheme: string) => {
    if (!isTheme(nextTheme)) {
      return
    }

    setThemeState(nextTheme)

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme)
    } catch {
      // Ignore storage failures; the current tab still updates immediately.
    }
  }, [])

  const value = useMemo<ThemeProviderState>(
    () => ({
      resolvedTheme: theme === "system" ? systemTheme : theme,
      setTheme,
      theme,
      themes: THEMES,
    }),
    [setTheme, systemTheme, theme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export const useTheme = (): ThemeProviderState => {
  const context = useContext(ThemeContext)

  if (!context) {
    return {
      resolvedTheme: "light",
      setTheme: () => {},
      theme: "system",
      themes: THEMES,
    }
  }

  return context
}
