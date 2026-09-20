import type { Metadata } from "next"
import { FrontendBootHealth } from "@/lib/frontend-boot-health"
import { getFrontendManifest } from "@/lib/frontend-manifest-store"

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Frontend boot health",
}

/**
 * Stable, unauthenticated, data-free browser health surface. It boots the
 * real organisation frontend plugin composition and exposes a ready marker
 * only after configured browser plugins have loaded and rendered. Only the
 * plugin selection (public plugin config required for the browser boot) is
 * sent to the client; no other organisation data is exposed.
 */
export default function FrontendBootHealthPage() {
  return <FrontendBootHealth plugins={getFrontendManifest().plugins} />
}
