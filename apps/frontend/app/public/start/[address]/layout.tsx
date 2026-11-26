import type { Metadata } from "next"
import type { ReactNode } from "react"
import { AnonymousPageSession } from "./page-client"
import { PublicFormBrandingHtml } from "@/app/public/form/[token]/public-form-branding-html"
import { getFrontendManifest } from "@/lib/frontend-manifest-store"
import { FrontendPlugins } from "@/lib/plugins-client"

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
}

export default function AnonymousPageLayout({
  children,
}: {
  children: ReactNode
}) {
  const manifest = getFrontendManifest()
  const headerHtml = manifest.publicFormBranding?.headerHtml
  return (
    <FrontendPlugins manifest={manifest}>
      <main className="mx-auto max-w-2xl px-4 pt-6 pb-10">
        {headerHtml ? (
          <header className="mb-8">
            <PublicFormBrandingHtml html={headerHtml} />
          </header>
        ) : null}
        <AnonymousPageSession>{children}</AnonymousPageSession>
      </main>
    </FrontendPlugins>
  )
}
