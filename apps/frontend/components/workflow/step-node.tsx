import { Handle, type NodeProps, Position } from "@xyflow/react"
import { Cog, FileText, User } from "lucide-react"
import {
  DEFAULT_STEP_COLORS,
  SYSTEM_STEP_COLORS,
  getPhaseColors,
} from "@/lib/workflow/constants"
import { canPreviewWorkflowStepForm } from "@/lib/workflow/form-preview"
import type { WorkflowStepData } from "@/lib/workflow/types"

const HANDLE_TOP_BY_SLOT = {
  top: "33.333%",
  middle: "50%",
  bottom: "66.667%",
} as const

const HANDLE_CLASS_NAME =
  "!w-2 !h-2 !-translate-y-1/2 !bg-slate-400 !border-slate-300 dark:!bg-slate-500 dark:!border-slate-600"

/**
 * Step node for workflow visualization.
 * Shows phase badge (or role badge if no phase), step name, and purpose.
 * Uses phase-based color scheme for card background and badge.
 * Green border for start steps.
 * System steps have square corners, a gear icon, and a distinct zinc color scheme.
 */
export function StepNode({ data }: NodeProps) {
  // Safe type assertion: data is guaranteed to be WorkflowStepData based on
  // how step nodes are created with proper typing in layout.ts
  const stepData = data as unknown as WorkflowStepData

  // Get colors based on step type
  const colors = stepData.isSystemStep
    ? SYSTEM_STEP_COLORS
    : stepData.phaseIndex !== undefined
      ? getPhaseColors(stepData.phaseIndex)
      : DEFAULT_STEP_COLORS

  // Build card classes - system steps have square borders, user steps have rounded
  const canPreviewForm = canPreviewWorkflowStepForm(stepData)
  const interactivityClasses = canPreviewForm
    ? "cursor-pointer transition hover:border-blue-400 hover:shadow-md hover:ring-2 hover:ring-blue-400/25 dark:hover:border-blue-300"
    : ""
  const cardClasses = stepData.isSystemStep
    ? `relative w-[280px] min-h-20 rounded-none p-4 flex flex-col gap-1 shadow-sm border ${colors.cardClass}`
    : stepData.phaseName
      ? `relative w-[280px] min-h-20 rounded-2xl p-4 flex flex-col gap-1 shadow-sm ring-1 ring-black/5 backdrop-blur-sm dark:ring-white/5 border ${colors.cardClass} ${interactivityClasses}`
      : `relative w-[280px] min-h-20 rounded-2xl p-4 flex flex-col gap-1 shadow-sm border ${colors.cardClass} ${interactivityClasses}`

  return (
    <div className={cardClasses}>
      {stepData.targetHandleSlots.map((slot) => (
        <Handle
          key={`target-${slot}`}
          id={`target-${slot}`}
          type="target"
          position={Position.Left}
          style={{ top: HANDLE_TOP_BY_SLOT[slot] }}
          className={HANDLE_CLASS_NAME}
        />
      ))}
      <div className="flex items-center justify-between gap-3 mb-1">
        {stepData.isSystemStep ? (
          <span className="flex items-center gap-1.5">
            <Cog className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
            <span
              className={`inline-block px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide rounded-full ${colors.badgeClass}`}
            >
              SYSTEM
            </span>
          </span>
        ) : stepData.phaseName ? (
          <span
            className={`inline-block px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide rounded-full ${colors.badgeClass}`}
          >
            {stepData.phaseName}
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <User className="h-3.5 w-3.5 text-slate-500 dark:text-slate-400" />
            <span
              className={`inline-block px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide rounded-full ${colors.badgeClass}`}
            >
              {stepData.roleName}
            </span>
          </span>
        )}
        {stepData.isStartStep && (
          <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {canPreviewForm ? <FileText className="h-3.5 w-3.5" /> : null}
            Start
          </span>
        )}
        {canPreviewForm && !stepData.isStartStep && (
          <FileText className="h-3.5 w-3.5 text-slate-500 dark:text-slate-400" />
        )}
      </div>
      <p className="text-base font-semibold text-slate-900 dark:text-slate-100">
        {stepData.name}
      </p>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {stepData.purpose}
      </p>
      {stepData.sourceHandleSlots.map((slot) => (
        <Handle
          key={`source-${slot}`}
          id={`source-${slot}`}
          type="source"
          position={Position.Right}
          style={{ top: HANDLE_TOP_BY_SLOT[slot] }}
          className={HANDLE_CLASS_NAME}
        />
      ))}
    </div>
  )
}
