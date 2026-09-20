import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const help =
  "Skip scheduled waits for this process run. Tasks and automated actions still run normally."

export function WithoutWaitingBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-900 dark:text-indigo-100"
          title={help}
        >
          Without waiting
        </span>
      </TooltipTrigger>
      <TooltipContent>{help}</TooltipContent>
    </Tooltip>
  )
}
