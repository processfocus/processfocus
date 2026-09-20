import type { LucideIcon } from "lucide-react"
import { Building, Building2, Grid3X3, Users, UsersRound } from "lucide-react"

/**
 * Depth configuration for org chart visualization
 * Provides colors and icons based on organizational depth
 */
interface DepthConfig {
  bgColor: string
  textColor: string
  labelColor: string
  icon: LucideIcon
}

/**
 * Depth-based configuration for org chart nodes
 * Index 0 = depth 1, index 1 = depth 2, etc.
 */
const depthConfigs: DepthConfig[] = [
  {
    bgColor: "bg-purple-100 dark:bg-purple-950/50",
    textColor: "text-purple-900 dark:text-purple-100",
    labelColor: "text-purple-600 dark:text-purple-400",
    icon: Building2,
  },
  {
    bgColor: "bg-blue-100 dark:bg-blue-950/50",
    textColor: "text-blue-900 dark:text-blue-100",
    labelColor: "text-blue-600 dark:text-blue-400",
    icon: Building,
  },
  {
    bgColor: "bg-emerald-100 dark:bg-emerald-950/50",
    textColor: "text-emerald-900 dark:text-emerald-100",
    labelColor: "text-emerald-600 dark:text-emerald-400",
    icon: Grid3X3,
  },
  {
    bgColor: "bg-amber-100 dark:bg-amber-950/50",
    textColor: "text-amber-900 dark:text-amber-100",
    labelColor: "text-amber-600 dark:text-amber-400",
    icon: Users,
  },
  {
    bgColor: "bg-slate-100 dark:bg-slate-800/50",
    textColor: "text-slate-900 dark:text-slate-100",
    labelColor: "text-slate-600 dark:text-slate-400",
    icon: UsersRound,
  },
]

/**
 * Get the depth configuration for a given depth value
 * Safely handles out-of-range depths by clamping to available configs
 */
export const getDepthConfig = (depth: number): DepthConfig => {
  const index = Math.max(0, Math.min(depth - 1, depthConfigs.length - 1))
  const config = depthConfigs[index]

  // Since index is clamped to valid range, config should always exist
  // But provide fallback to last config for safety
  if (!config) {
    const fallback = depthConfigs[depthConfigs.length - 1]
    if (!fallback) {
      throw new Error("Depth configuration is empty")
    }
    return fallback
  }

  return config
}
