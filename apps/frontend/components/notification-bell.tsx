"use client"

import { Bell, BellOff, BellRing, LoaderCircle } from "lucide-react"
import { useEffect, useState } from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useNotificationPreference } from "@/hooks/use-notification-preference"
import { cn } from "@/lib/utils"

interface NotificationBellProps {
  /** The current user's ID for scoping the preference */
  userId: string
  /** The current org's ID for scoping the preference */
  orgId: string
  /** Optional CSS class for styling */
  className?: string
}

/**
 * Header bell control for desktop notifications.
 *
 * This component provides a self-service toggle for browser-local desktop
 * notifications. The preference is scoped to the current user and org.
 *
 * Features:
 * - Hidden in browsers without Notification API support
 * - Click to request permission and enable
 * - Click again to disable
 * - Shows disabled state when permission is denied
 * - Persists preference in localStorage
 *
 * @example
 * ```tsx
 * <NotificationBell userId={session.userId} orgId={session.orgUnitId} />
 * ```
 */
export function NotificationBell({
  userId,
  orgId,
  className,
}: NotificationBellProps) {
  const [mounted, setMounted] = useState(false)
  const {
    state,
    toggle,
    isSupported,
    isPermissionRequestPending,
    browserPromptHint,
  } = useNotificationPreference(userId, orgId)

  // Avoid hydration mismatch - don't render until client-side
  useEffect(() => {
    setMounted(true)
  }, [])

  // Don't show anything during SSR or in unsupported browsers
  if (!mounted || !isSupported) {
    return null
  }

  const isEnabled = state.isEnabled
  const isDenied = state.permission === "denied"
  const isPending = isPermissionRequestPending

  // Determine icon and tooltip based on state
  const Icon = isPending
    ? LoaderCircle
    : isEnabled
      ? BellRing
      : isDenied
        ? BellOff
        : Bell
  const tooltipContent = browserPromptHint
    ? browserPromptHint
    : isEnabled
      ? "Desktop notifications enabled (click to disable)"
      : isDenied
        ? "Desktop notifications blocked in browser settings"
        : "Enable desktop notifications"

  return (
    <div className="relative">
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggle}
              disabled={isDenied || isPending}
              className={cn(
                "relative flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white shadow-sm transition-colors",
                isEnabled
                  ? "text-blue-600 hover:bg-blue-50 dark:border-slate-700 dark:bg-slate-900 dark:text-blue-400 dark:hover:bg-slate-800"
                  : isDenied || isPending
                    ? "cursor-not-allowed text-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-600"
                    : "text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800",
                className,
              )}
              aria-label={tooltipContent}
              data-testid="notification-bell"
              data-state={
                isPending
                  ? "pending"
                  : isEnabled
                    ? "enabled"
                    : isDenied
                      ? "denied"
                      : "disabled"
              }
            >
              <Icon className={cn("h-5 w-5", isPending && "animate-spin")} />
              {isEnabled && (
                <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-blue-500" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center">
            <p>{tooltipContent}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {browserPromptHint && (
        // Keep the Firefox guidance visible even when the tooltip is closed.
        <div
          className="absolute top-full right-0 z-50 mt-2 w-72 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 shadow-lg dark:border-amber-900/60 dark:bg-slate-900 dark:text-amber-100"
          role="status"
        >
          {browserPromptHint}
        </div>
      )}
    </div>
  )
}
