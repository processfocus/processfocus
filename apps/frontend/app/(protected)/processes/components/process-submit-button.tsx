"use client"

import { ChevronDown } from "lucide-react"
import { useRef } from "react"
import { Button } from "@pf/shadcn-components"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const WITHOUT_WAITING_HELP =
  "Skip scheduled waits for this process run. Tasks and automated actions still run normally."

export function ProcessSubmitButton({
  canSkipScheduleWaits,
  isSubmitting,
}: {
  canSkipScheduleWaits: boolean
  isSubmitting: boolean
}) {
  const normal = useRef<HTMLButtonElement>(null)
  const withoutWaiting = useRef<HTMLButtonElement>(null)
  return (
    <div className="flex">
      <Button
        ref={normal}
        type="submit"
        disabled={isSubmitting}
        className={canSkipScheduleWaits ? "rounded-r-none" : undefined}
      >
        {isSubmitting ? "..." : "Submit"}
      </Button>
      {canSkipScheduleWaits && (
        <>
          <button
            ref={withoutWaiting}
            type="submit"
            data-without-waiting="true"
            hidden
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                disabled={isSubmitting}
                className="rounded-l-none border-l border-primary-foreground/30 px-2"
                aria-label="Submission options"
              >
                <ChevronDown className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => {
                  const button = normal.current
                  if (button) button.form?.requestSubmit(button)
                }}
              >
                Submit
              </DropdownMenuItem>
              <DropdownMenuItem
                className="flex max-w-80 flex-col items-start gap-1"
                onSelect={() => {
                  const button = withoutWaiting.current
                  if (button) button.form?.requestSubmit(button)
                }}
              >
                <span>Submit without waiting</span>
                <span className="text-xs text-muted-foreground">
                  {WITHOUT_WAITING_HELP}
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  )
}
