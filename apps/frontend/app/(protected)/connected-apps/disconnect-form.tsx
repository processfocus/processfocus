"use client"

import { useActionState, useId } from "react"
import { Button } from "@pf/shadcn-components"
import { DateTimeDisplay } from "@pf/shadcn-components/date-time-display"

export function DisconnectForm({
  action,
  name,
  access,
  authorisedAt,
  clientId,
  grantId,
}: {
  action: (previous: string | null, form: FormData) => Promise<string | null>
  name: string
  access: string
  authorisedAt: number
  clientId: string
  grantId: string
}) {
  const nameId = useId()
  const [error, submit, pending] = useActionState(action, null)
  return (
    <form action={submit} aria-labelledby={nameId} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <p id={nameId} className="font-medium">
            {name}
          </p>
          <p className="text-sm text-muted-foreground">{access}</p>
          <p className="text-sm text-muted-foreground">
            Authorised on{" "}
            <DateTimeDisplay
              kind="timestamp"
              value={authorisedAt}
              initialMode="browser-local"
              seconds="milliseconds"
            />
          </p>
        </div>
        <input type="hidden" name="client" value={clientId} />
        <input type="hidden" name="grant" value={grantId} />
        <Button
          type="submit"
          variant="outline"
          disabled={pending}
          aria-busy={pending}
          aria-label={`Disconnect ${name}`}
        >
          Disconnect
        </Button>
      </div>
      <div role="status">{error}</div>
    </form>
  )
}
