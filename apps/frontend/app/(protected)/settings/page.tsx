import { SettingsPage } from "./settings-page"

// The authenticated layout can omit this page while checking the session.
export const instant = false

export default function Page() {
  return <SettingsPage />
}
