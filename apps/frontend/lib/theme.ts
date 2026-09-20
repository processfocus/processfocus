export type Theme = "light" | "dark" | "system"
export type ResolvedTheme = "light" | "dark"

export const THEME_STORAGE_KEY = "theme"
export const THEME_QUERY = "(prefers-color-scheme: dark)"
export const THEMES = ["light", "dark", "system"] as const

export const isTheme = (theme: string | null): theme is Theme =>
  theme === "light" || theme === "dark" || theme === "system"
