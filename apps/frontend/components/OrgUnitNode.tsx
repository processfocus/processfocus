import { Handle, type NodeProps, Position } from "@xyflow/react"
import { memo } from "react"
import { getDepthConfig } from "@/lib/org-chart-depth-config"
import type { OrgUnitNodeData } from "@/lib/org-chart-types"

export const OrgUnitNode = memo(({ data }: NodeProps) => {
  const nodeData = data as OrgUnitNodeData
  const config = getDepthConfig(nodeData.depth ?? 1)
  const Icon = config.icon

  return (
    <div className="relative h-full w-full">
      <Handle type="target" position={Position.Top} className="!bg-slate-400" />

      <div
        className={`flex h-full w-full items-center justify-center gap-3 rounded-xl border border-slate-200 px-6 py-4 shadow-sm transition-shadow hover:shadow-md dark:border-slate-700 ${config.bgColor}`}
      >
        <Icon className={`h-6 w-6 shrink-0 ${config.textColor}`} />

        <div className="flex flex-col items-center text-center">
          <div className={`text-lg font-semibold ${config.textColor}`}>
            {nodeData.name}
          </div>
          <div
            className={`text-sm font-medium capitalize ${config.labelColor}`}
          >
            {nodeData.level}
          </div>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-slate-400"
      />
    </div>
  )
})

OrgUnitNode.displayName = "OrgUnitNode"
