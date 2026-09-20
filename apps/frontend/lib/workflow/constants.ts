/**
 * Shared layout constants for workflow visualization.
 */

/** Width of the role label column on the left side of swimlanes */
export const ROLE_LABEL_WIDTH = 200

/**
 * Phase color scheme for workflow visualization.
 * Colors are assigned based on phase index (order of appearance).
 */
interface PhaseColors {
  /** Background color for step cards */
  cardClass: string
  /** Badge background and text colors */
  badgeClass: string
  /** Accent color for legend dots and minimap */
  accent: string
}

/**
 * Color palette for phases, cycled through based on phase index.
 * Matches the mock design color scheme.
 */
const PHASE_COLOR_PALETTE: readonly PhaseColors[] = [
  {
    // Indigo - first phase
    cardClass:
      "bg-indigo-50/80 border-indigo-200/70 dark:bg-indigo-950/40 dark:border-indigo-500/40",
    badgeClass:
      "bg-indigo-100/80 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-100",
    accent: "#818cf8",
  },
  {
    // Amber - second phase
    cardClass:
      "bg-amber-50/80 border-amber-200/70 dark:bg-amber-950/40 dark:border-amber-500/40",
    badgeClass:
      "bg-amber-100/90 text-amber-700 dark:bg-amber-500/20 dark:text-amber-100",
    accent: "#f59e0b",
  },
  {
    // Sky - third phase
    cardClass:
      "bg-sky-50/80 border-sky-200/70 dark:bg-sky-950/40 dark:border-sky-500/40",
    badgeClass:
      "bg-sky-100/90 text-sky-700 dark:bg-sky-500/20 dark:text-sky-100",
    accent: "#0ea5e9",
  },
  {
    // Emerald - fourth phase
    cardClass:
      "bg-emerald-50/80 border-emerald-200/70 dark:bg-emerald-950/40 dark:border-emerald-500/40",
    badgeClass:
      "bg-emerald-100/90 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-100",
    accent: "#10b981",
  },
  {
    // Violet - fifth phase
    cardClass:
      "bg-violet-50/80 border-violet-200/70 dark:bg-violet-950/40 dark:border-violet-500/40",
    badgeClass:
      "bg-violet-100/90 text-violet-700 dark:bg-violet-500/20 dark:text-violet-100",
    accent: "#8b5cf6",
  },
  {
    // Rose - sixth phase (for additional phases)
    cardClass:
      "bg-rose-50/80 border-rose-200/70 dark:bg-rose-950/40 dark:border-rose-500/40",
    badgeClass:
      "bg-rose-100/90 text-rose-700 dark:bg-rose-500/20 dark:text-rose-100",
    accent: "#f43f5e",
  },
  {
    // Teal - seventh phase
    cardClass:
      "bg-teal-50/80 border-teal-200/70 dark:bg-teal-950/40 dark:border-teal-500/40",
    badgeClass:
      "bg-teal-100/90 text-teal-700 dark:bg-teal-500/20 dark:text-teal-100",
    accent: "#14b8a6",
  },
]

/**
 * Default colors for steps without a phase.
 */
export const DEFAULT_STEP_COLORS: PhaseColors = {
  cardClass:
    "bg-slate-50/80 border-slate-200/70 dark:bg-slate-950/40 dark:border-slate-500/40",
  badgeClass:
    "bg-slate-100/90 text-slate-700 dark:bg-slate-500/20 dark:text-slate-100",
  accent: "#64748b",
}

/**
 * Colors for system steps (NodeSteps) in the SYSTEM swimlane.
 * Distinct zinc/gray palette to distinguish from user tasks.
 */
export const SYSTEM_STEP_COLORS: PhaseColors = {
  cardClass:
    "bg-zinc-100/80 border-zinc-300/80 dark:bg-zinc-900/50 dark:border-zinc-600/50",
  badgeClass:
    "bg-zinc-200/90 text-zinc-700 dark:bg-zinc-600/30 dark:text-zinc-300",
  accent: "#a1a1aa",
}

/**
 * Get phase colors by index (cycles through palette).
 */
export function getPhaseColors(phaseIndex: number): PhaseColors {
  const index = phaseIndex % PHASE_COLOR_PALETTE.length
  const colors = PHASE_COLOR_PALETTE[index]
  // Palette is non-empty and index is always valid due to modulo
  if (!colors) {
    return DEFAULT_STEP_COLORS
  }
  return colors
}
