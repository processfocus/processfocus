import "./public.css"
import "@/lib/organisation-plugin-preparation"
import type { Metadata } from "next"
import { Suspense } from "react"
import { buildAppIconMetadata } from "@/lib/app-icons-metadata"
import { getFrontendManifest } from "@/lib/frontend-manifest-store"
import { THEME_QUERY, THEME_STORAGE_KEY } from "@/lib/theme"

const THEME_BOOTSTRAP_SCRIPT = `
(() => {
  try {
    const html = document.documentElement;
    const isEmbed = location.pathname.startsWith("/embed/");
    const isPublicForm = location.pathname.startsWith("/public/form/");
    const searchParams = isEmbed ? new URLSearchParams(location.search) : null;
    const embedMode = searchParams?.get("mode");
    const embedAlign = searchParams?.get("align");
    const storedTheme = isEmbed || isPublicForm ? null : localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    const theme = storedTheme === "light" || storedTheme === "dark" || storedTheme === "system" ? storedTheme : "system";
    const resolvedTheme = isPublicForm
      ? "light"
      : isEmbed && (embedMode === "light" || embedMode === "dark")
        ? embedMode
        : theme === "dark" || (theme === "system" && matchMedia(${JSON.stringify(THEME_QUERY)}).matches)
          ? "dark"
          : "light";
    html.classList.remove("light", "dark");
    html.classList.add(resolvedTheme);
    html.style.colorScheme = resolvedTheme;
    if (isEmbed) {
      html.dataset.pfEmbed = "true";
      html.dataset.pfEmbedAlign = embedAlign === "left" ? "left" : "center";
    }
  } catch {}
})();`

// Keep these values in sync with the app background and foreground tokens in
// apps/frontend/app/theme.css. They must be available before Tailwind loads.
const CRITICAL_THEME_STYLE = `
html.frontend,
html.frontend body {
  background: oklch(1 0 0);
  color: oklch(0.129 0.042 264.695);
  min-height: 100%;
}

html.frontend body {
  min-height: 100vh;
}

@media (prefers-color-scheme: dark) {
  html.frontend,
  html.frontend body {
    background: oklch(0.129 0.042 264.695);
    color: oklch(0.984 0.003 247.858);
  }
}

html.frontend.light,
html.frontend.light body {
  background: oklch(1 0 0);
  color: oklch(0.129 0.042 264.695);
}

html.frontend.dark,
html.frontend.dark body {
  background: oklch(0.129 0.042 264.695);
  color: oklch(0.984 0.003 247.858);
}

/* Must follow .light/.dark rules so iframe embeds never inherit an opaque canvas. */
html.frontend[data-pf-embed="true"],
html.frontend[data-pf-embed="true"] body {
  background: transparent;
}`

export const generateMetadata = (): Metadata => {
  return buildAppIconMetadata(getFrontendManifest())
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      className="frontend bg-background text-foreground"
      lang="en"
      suppressHydrationWarning
    >
      <head>
        <script id="theme-bootstrap">{THEME_BOOTSTRAP_SCRIPT}</script>
        {/* Keep the document canvas non-white before external CSS loads. */}
        <style id="critical-theme-background">{CRITICAL_THEME_STYLE}</style>
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased transition-colors">
        <Suspense fallback={null}>{children}</Suspense>
      </body>
    </html>
  )
}
