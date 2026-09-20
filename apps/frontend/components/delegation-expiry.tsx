// Fix the display timezone so server and client render the same deadline.
const expiryFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
})

export function DelegationExpiry({ expiresAt }: { expiresAt: number }) {
  return (
    <p>
      Expires{" "}
      <time dateTime={new Date(expiresAt).toISOString()}>
        {expiryFormatter.format(expiresAt)}
      </time>
    </p>
  )
}
