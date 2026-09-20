import type { NodeProps } from "@xyflow/react"
import { Cog } from "lucide-react"
import { ROLE_LABEL_WIDTH } from "@/lib/workflow/constants"
import type { WorkflowSwimlaneData } from "@/lib/workflow/types"

/**
 * Swimlane background node for workflow visualization.
 * Renders a role label in the top-left corner and a gradient background stripe.
 * System swimlane shows a gear icon.
 */
export function SwimlaneNode({ data }: NodeProps) {
  // Safe type assertion: data is guaranteed to be WorkflowSwimlaneData based on
  // how swimlane nodes are created with proper typing in layout.ts
  const swimlaneData = data as unknown as WorkflowSwimlaneData
  return (
    <div
      className="-z-10 flex"
      style={{
        width: `${swimlaneData.width + ROLE_LABEL_WIDTH}px`,
        height: `${swimlaneData.height}px`,
      }}
    >
      {/* Role label box - white background */}
      <div
        className="h-full shrink-0 border border-slate-200/80 bg-white pl-2 pr-4 py-3 dark:border-slate-800/70 dark:bg-slate-950/70"
        style={{ width: ROLE_LABEL_WIDTH }}
      >
        <div className="flex items-center gap-2">
          {swimlaneData.isSystem && (
            <Cog className="h-5 w-5 text-zinc-500 dark:text-zinc-400" />
          )}
          <p className="text-lg font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-200">
            {swimlaneData.roleName}
          </p>
        </div>
        {swimlaneData.responsibility && (
          <p className="mt-1 text-base text-slate-500 leading-tight dark:text-slate-400">
            {swimlaneData.responsibility}
          </p>
        )}
      </div>
      {/* Swimlane area - slate background */}
      <div className="h-full flex-1 border-y border-r border-slate-200/70 bg-gradient-to-r from-slate-50/80 via-slate-50/30 to-transparent dark:border-slate-800/50 dark:from-slate-900/40 dark:via-slate-900/20" />
    </div>
  )
}
