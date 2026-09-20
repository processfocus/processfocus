import type React from "react"
import { PublicFormBrandingHtml } from "./public-form-branding-html"
import type { FrontendManifest } from "@/lib/frontend-manifest"
import { cn } from "@/lib/utils"

type PublicFormBranding = FrontendManifest["publicFormBranding"]

interface PublicFormBrandingCardProps {
  readonly branding: PublicFormBranding
  readonly children: React.ReactNode
  readonly className?: string | undefined
}

export function PublicFormBrandingCard({
  branding,
  children,
  className,
}: PublicFormBrandingCardProps) {
  const headerHtml = branding?.headerHtml
  const footerHtml = branding?.footerHtml

  return (
    <section
      className={cn(
        "rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8",
        className,
      )}
    >
      {headerHtml ? (
        <header className="mb-8 border-b border-slate-200 pb-6">
          <PublicFormBrandingHtml html={headerHtml} />
        </header>
      ) : null}
      {children}
      {footerHtml ? (
        <footer className="mt-8 border-t border-slate-200 pt-6 text-sm text-slate-600">
          <PublicFormBrandingHtml html={footerHtml} />
        </footer>
      ) : null}
    </section>
  )
}
