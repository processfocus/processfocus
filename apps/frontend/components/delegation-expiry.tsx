import { DateTimeDisplay } from "@pf/shadcn-components/date-time-display"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./ui/dialog"
import { DropdownMenuItem } from "./ui/dropdown-menu"

export function DelegationExpiryMenuItem({ expiresAt }: { expiresAt: number }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <DropdownMenuItem onSelect={(event) => event.preventDefault()}>
          Access expiry
        </DropdownMenuItem>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Access expiry</DialogTitle>
        <DelegationExpiry expiresAt={expiresAt} />
      </DialogContent>
    </Dialog>
  )
}

export function DelegationExpiry({ expiresAt }: { expiresAt: number }) {
  return (
    <p>
      Expires{" "}
      <DateTimeDisplay
        kind="timestamp"
        value={expiresAt}
        initialMode="browser-local"
      />
    </p>
  )
}
