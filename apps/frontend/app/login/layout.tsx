import { ThemeProvider } from "@/components/theme-provider"

export default function LoginLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <ThemeProvider>{children}</ThemeProvider>
}
