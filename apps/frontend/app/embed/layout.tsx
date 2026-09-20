import "./embedded.css"
import { getFrontendManifest } from "@/lib/frontend-manifest-store"
import { FrontendPlugins } from "@/lib/plugins-client"

export default function EmbedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <FrontendPlugins manifest={getFrontendManifest()}>
      {children}
    </FrontendPlugins>
  )
}
