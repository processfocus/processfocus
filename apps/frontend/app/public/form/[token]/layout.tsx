import { PublicFormBrandingProvider } from "./public-form-branding-context"
import type { FrontendManifest } from "@/lib/frontend-manifest"
import {
  disabledFrontendManifest,
  getFrontendManifest,
} from "@/lib/frontend-manifest-store"
import { FrontendPlugins } from "@/lib/plugins-client"

const publicFormAnalyticsManifest = (
  manifest: FrontendManifest,
): FrontendManifest => ({
  ...disabledFrontendManifest,
  organisation: manifest.organisation,
  // Branding is rendered by the page shell; this layout only narrows plugins.
  plugins: {
    analytics: manifest.plugins.analytics,
    formComponents: [],
  },
})

export default function PublicFormLayout({
  children,
}: {
  readonly children: React.ReactNode
}) {
  const frontendManifest = getFrontendManifest()
  const manifest = publicFormAnalyticsManifest(frontendManifest)

  return (
    <PublicFormBrandingProvider branding={frontendManifest.publicFormBranding}>
      <FrontendPlugins manifest={manifest}>{children}</FrontendPlugins>
    </PublicFormBrandingProvider>
  )
}
