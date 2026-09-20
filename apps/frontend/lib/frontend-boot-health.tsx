"use client"

/**
 * Unauthenticated frontend boot health surface.
 *
 * Boots the real organisation frontend plugin composition (generated plugin
 * loaders, plugin host, and plugin rendering) without a user session and
 * without exposing organisation data. The DOM ready marker
 * (`data-frontend-boot-health="ready"`) appears only after every configured
 * browser plugin has loaded and rendered successfully. Any plugin import,
 * activation, or render failure keeps the marker in the failed state; the
 * underlying errors remain observable as browser console errors.
 */
import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react"
import { FrontendClientPluginHost } from "@/components/frontend-client-plugin-host"
import { FrontendClientPluginProvider } from "@/components/frontend-client-plugin-provider"
import type { FrontendManifestPlugins } from "@/lib/frontend-manifest"
import {
  type FrontendPluginLoadFailure,
  loadFrontendManifestPlugins,
} from "@/lib/frontend-plugin-loaders"

type LoadFrontendManifestPlugins = typeof loadFrontendManifestPlugins

type FrontendBootHealthPhase = "booting" | "ready" | "failed"

type LoadedAnalyticsPlugins = FrontendManifestPlugins["analytics"]

interface FrontendBootHealthProps {
  readonly loadPlugins?: LoadFrontendManifestPlugins
  // Only the plugin selection crosses the server/client boundary so the
  // unauthenticated surface stays free of other organisation manifest data.
  readonly plugins: FrontendManifestPlugins
}

interface FrontendBootHealthErrorBoundaryProps {
  readonly children: ReactNode
  readonly onFailure: (cause: unknown) => void
}

interface FrontendBootHealthErrorBoundaryState {
  readonly failed: boolean
}

class FrontendBootHealthErrorBoundary extends Component<
  FrontendBootHealthErrorBoundaryProps,
  FrontendBootHealthErrorBoundaryState
> {
  override state: FrontendBootHealthErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): FrontendBootHealthErrorBoundaryState {
    return { failed: true }
  }

  override componentDidCatch(cause: unknown): void {
    console.error("[frontend-boot-health] frontend plugin render failed", cause)
    this.props.onFailure(cause)
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return null
    }

    return this.props.children
  }
}

const BootHealthRenderProbe = ({
  onRendered,
}: {
  readonly onRendered: () => void
}) => {
  useEffect(() => {
    onRendered()
  }, [onRendered])

  return null
}

const FrontendBootHealthStatus = ({
  phase,
}: {
  readonly phase: FrontendBootHealthPhase
}) => (
  <main id="frontend-boot-health" data-frontend-boot-health={phase}>
    <h1>Process Focus frontend boot health</h1>
    <p data-frontend-boot-health-status={phase}>{phase}</p>
  </main>
)

export const FrontendBootHealth = ({
  loadPlugins = loadFrontendManifestPlugins,
  plugins,
}: FrontendBootHealthProps) => {
  const [phase, setPhase] = useState<FrontendBootHealthPhase>("booting")
  const [loadedPlugins, setLoadedPlugins] =
    useState<LoadedAnalyticsPlugins | null>(null)
  const markPluginRendered = useCallback(() => {
    setPhase((current) => (current === "failed" ? current : "ready"))
  }, [])
  const markBootFailed = useCallback(() => {
    setPhase("failed")
  }, [])

  useEffect(() => {
    let isCurrent = true
    const failures: FrontendPluginLoadFailure[] = []

    loadPlugins(plugins, undefined, (failure) => {
      failures.push(failure)
    }).then(
      (plugins) => {
        if (!isCurrent) {
          return
        }

        if (failures.length > 0) {
          setPhase("failed")
          return
        }

        setLoadedPlugins(plugins)
      },
      (error) => {
        console.error(
          "[frontend-boot-health] failed to load frontend plugins",
          error,
        )

        if (isCurrent) {
          setPhase("failed")
        }
      },
    )

    return () => {
      isCurrent = false
    }
  }, [loadPlugins, plugins])

  return (
    <>
      <FrontendBootHealthErrorBoundary onFailure={markBootFailed}>
        {loadedPlugins === null ? null : (
          <FrontendClientPluginProvider plugins={loadedPlugins}>
            <FrontendClientPluginHost plugins={loadedPlugins} />
            <BootHealthRenderProbe onRendered={markPluginRendered} />
          </FrontendClientPluginProvider>
        )}
      </FrontendBootHealthErrorBoundary>
      <FrontendBootHealthStatus phase={phase} />
    </>
  )
}
