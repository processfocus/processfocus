"use client"

import * as Tooltip from "@radix-ui/react-tooltip"
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useState,
} from "react"
import { cn } from "./utils/utils"

export type DateTimeDisplayMode =
  | "relative"
  | "browser-local"
  | "event-local"
  | "utc"
export type DateTimeDisplayProps = { className?: string } & (
  | { kind: "calendar-date"; value: string }
  | {
      kind: "timestamp"
      value: string | Date | number
      initialMode?: DateTimeDisplayMode
      eventTimeZone?: string
      seconds?: boolean | "milliseconds"
    }
)

type DisplayEnvironment = {
  now: number
  locale: string
  timeZone: string
  hydrated: boolean
}
const Environment = createContext<DisplayEnvironment | null>(null)

/** Serialize one server reference with the tree, rather than reading two clocks during hydration. */
export function DateTimeDisplayProvider({
  initialNow,
  children,
}: {
  initialNow: number
  children: ReactNode
}) {
  const [environment, setEnvironment] = useState<DisplayEnvironment>({
    now: initialNow,
    locale: "en-US",
    timeZone: "UTC",
    hydrated: false,
  })
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "hidden") return
      const { locale, timeZone } = new Intl.DateTimeFormat().resolvedOptions()
      setEnvironment({ now: Date.now(), locale, timeZone, hydrated: true })
    }
    refresh()
    const timer = setInterval(refresh, 10_000)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [])
  return (
    <Environment value={environment}>
      <Tooltip.Provider delayDuration={0}>{children}</Tooltip.Provider>
    </Environment>
  )
}

function calendarDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? date
    : null
}

function parseValue(props: DateTimeDisplayProps): Date | null {
  if (props.kind === "calendar-date") return calendarDate(props.value)
  // Strings must identify an instant, not rely on the server/viewer's local zone.
  if (
    typeof props.value === "string" &&
    (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
      props.value,
    ) ||
      !calendarDate(props.value.slice(0, 10)))
  )
    return null
  const date = new Date(props.value)
  return Number.isFinite(date.getTime()) ? date : null
}

function validatedZone(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions()
      .timeZone
  } catch {
    return null
  }
}

// Modern Intl preserves supplied aliases in resolvedOptions. Generic names
// identify equivalent zone displays without conflating UTC with winter London.
function zoneKey(zone: string, date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    timeZoneName: "longGeneric",
    hour: "numeric",
    minute: "numeric",
  }).format(date)
}

function absolute(
  date: Date,
  locale: string,
  timeZone: string,
  seconds: boolean | "milliseconds",
  calendar = false,
) {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone,
    ...(calendar
      ? {}
      : ({
          hour: "numeric",
          minute: "2-digit",
          ...(seconds ? { second: "2-digit" } : {}),
          ...(seconds === "milliseconds" ? { fractionalSecondDigits: 3 } : {}),
          timeZoneName: "short",
        } satisfies Intl.DateTimeFormatOptions)),
  }).format(date)
}

function relative(date: Date, now: number, locale: string) {
  const seconds = (date.getTime() - now) / 1000
  if (Math.abs(seconds) < 10) return "just now"
  const units: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ]
  const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size) ?? [
    "second",
    1,
  ]
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(
    Math.round(seconds / size),
    unit,
  )
}

const modeNames: Record<DateTimeDisplayMode, string> = {
  relative: "Relative time",
  "browser-local": "Browser-local time",
  "event-local": "Event-local time",
  utc: "UTC",
}

export function DateTimeDisplay(props: DateTimeDisplayProps) {
  const environment = useContext(Environment)
  const [mode, setMode] = useState<DateTimeDisplayMode>(
    props.kind === "timestamp" ? (props.initialMode ?? "relative") : "relative",
  )
  const date = parseValue(props)
  const eventZone =
    props.kind === "timestamp" && props.eventTimeZone !== undefined
      ? validatedZone(props.eventTimeZone)
      : undefined
  const invalid = !date || eventZone === null
  useEffect(() => {
    if (!invalid) return
    const error = new Error(
      `DateTimeDisplay: Invalid date (${props.kind}, ${eventZone === null ? "invalid-time-zone" : "invalid-value"})`,
    )
    // The browser error channel is collected by the host's error-reporting plugin.
    if (typeof globalThis.reportError === "function")
      globalThis.reportError(error)
    else console.error(error)
  }, [invalid, props.kind, eventZone])
  if (!environment)
    throw new Error(
      "DateTimeDisplay requires DateTimeDisplayProvider with a serialized initialNow",
    )
  if (invalid || !date)
    return <span className={props.className}>Invalid date</span>
  const { locale, timeZone, now, hydrated } = environment
  if (props.kind === "calendar-date") {
    return (
      <time className={props.className} dateTime={props.value}>
        {absolute(date, locale, "UTC", false, true)}
      </time>
    )
  }

  const zones: Record<DateTimeDisplayMode, string> = {
    relative: timeZone,
    "browser-local": timeZone,
    "event-local": eventZone ?? timeZone,
    utc: "UTC",
  }
  const cycle: DateTimeDisplayMode[] = ["relative", "browser-local"]
  const seen = new Set([zoneKey(timeZone, date)])
  if (eventZone && !seen.has(zoneKey(eventZone, date))) {
    cycle.push("event-local")
    seen.add(zoneKey(eventZone, date))
  }
  if (!seen.has(zoneKey("UTC", date))) cycle.push("utc")
  const current = cycle.includes(mode)
    ? mode
    : (cycle.find(
        (candidate) =>
          candidate !== "relative" &&
          zoneKey(zones[candidate], date) === zoneKey(zones[mode], date),
      ) ?? "browser-local")
  const next = cycle[(cycle.indexOf(current) + 1) % cycle.length] ?? "relative"
  const seconds = props.seconds ?? false
  const text =
    current === "relative"
      ? relative(date, now, locale)
      : absolute(date, locale, zones[current], seconds)
  const exact = absolute(date, locale, timeZone, seconds)
  const currentName =
    current === "browser-local" && !hydrated
      ? "UTC (browser-local time pending)"
      : modeNames[current]
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          className={cn(
            "rounded-sm text-left underline decoration-dotted underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            props.className,
          )}
          aria-label={`${text}. ${currentName}. Show ${modeNames[next]}.`}
          onClick={(event) => {
            event.stopPropagation()
            setMode(next)
          }}
          onKeyDown={(event) => {
            event.stopPropagation()
          }}
          onKeyUp={(event) => {
            event.stopPropagation()
          }}
        >
          <time dateTime={date.toISOString()}>{text}</time>
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="top"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 max-w-[min(20rem,var(--radix-tooltip-content-available-width))] rounded-md bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md"
        >
          {hydrated ? "Browser-local" : "UTC (browser-local time pending)"}:{" "}
          {exact}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
