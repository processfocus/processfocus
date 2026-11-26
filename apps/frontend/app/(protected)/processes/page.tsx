import ClientPage from "./client"

// The authenticated shell can omit this page while checking the session.
export const instant = false

export default function Page() {
  return <ClientPage />
}
