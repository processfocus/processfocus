"use client"

import { createContext, useContext } from "react"
import type { FrontendManifest } from "@/lib/frontend-manifest"

type PublicFormBranding = FrontendManifest["publicFormBranding"]

const PublicFormBrandingContext = createContext<PublicFormBranding | null>(null)
PublicFormBrandingContext.displayName = "PublicFormBrandingContext"

export function PublicFormBrandingProvider({
  branding,
  children,
}: {
  readonly branding: PublicFormBranding
  readonly children: React.ReactNode
}) {
  return (
    <PublicFormBrandingContext.Provider value={branding}>
      {children}
    </PublicFormBrandingContext.Provider>
  )
}

/** Returns tenant branding for public forms, or null when no branding is configured. */
export const usePublicFormBranding = (): PublicFormBranding | null =>
  useContext(PublicFormBrandingContext)
