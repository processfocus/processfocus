import type { Metadata } from "next"
import { ThemeProvider } from "@/components/theme-provider"

export const metadata: Metadata = {
  title: "Create a passkey",
  robots: {
    index: false,
    follow: false,
  },
  referrer: "no-referrer",
}

/**
 * Scrubs the Registration Link fragment before React hydrates or third-party
 * scripts run. Stashes the token on window so the client can exchange it even
 * under React Strict Mode remounts (module-level capture on the client).
 */
const FRAGMENT_SCRUB_SCRIPT = `
(() => {
  try {
    const hash = location.hash.startsWith("#")
      ? location.hash.slice(1)
      : location.hash;
    const token = new URLSearchParams(hash).get("token");
    history.replaceState(null, "", location.pathname + location.search);
    if (token && token.trim()) {
      window.__PF_REGISTRATION_LINK_TOKEN = token.trim();
    }
  } catch (_) {}
})();
`

export default function RegisterPasskeyLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Scrub script must stay outside the client ThemeProvider so it runs as a
  // server-rendered early body script during HTML parse, not after client mount.
  return (
    <>
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static inline scrub; no user input
        dangerouslySetInnerHTML={{ __html: FRAGMENT_SCRUB_SCRIPT }}
      />
      <ThemeProvider>{children}</ThemeProvider>
    </>
  )
}
