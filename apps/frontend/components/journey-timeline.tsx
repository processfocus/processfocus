"use client"

import { useMemo } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@pf/shadcn-components"
import { DateTimeDisplay } from "@pf/shadcn-components/date-time-display"
import { cn } from "@/lib/utils"

interface TimelineSegmentData {
  readonly status: string
  readonly startDate: string
  readonly endDate: string | null
}

export interface TimelineItemData {
  readonly id: string
  readonly label: string
  readonly currentStatus: string
  readonly startDate: string
  readonly endDate: string | null
  readonly segments: readonly TimelineSegmentData[]
}

interface JourneyTimelineProps {
  readonly items: readonly TimelineItemData[]
  readonly now: number
}

const statusColors: Record<string, string> = {
  received: "bg-slate-400 dark:bg-slate-500",
  "waiting for parent to book tour": "bg-amber-400 dark:bg-amber-500",
  "tour booked": "bg-sky-500 dark:bg-sky-600",
  "parent cancelled": "bg-stone-400 dark:bg-stone-500",
  "waiting for formal application": "bg-violet-400 dark:bg-violet-500",
  enrolling: "bg-indigo-500 dark:bg-indigo-600",
  testing: "bg-cyan-400 dark:bg-cyan-500",
  enrolled: "bg-emerald-500 dark:bg-emerald-600",
  "not enrolled": "bg-rose-500 dark:bg-rose-600",
  "enrolled at other school": "bg-orange-400 dark:bg-orange-500",
  rejected: "bg-red-600 dark:bg-red-700",
}

const statusLabelColors: Record<string, string> = {
  received: "text-slate-600 dark:text-slate-400",
  "waiting for parent to book tour": "text-amber-600 dark:text-amber-400",
  "tour booked": "text-sky-600 dark:text-sky-400",
  "parent cancelled": "text-stone-600 dark:text-stone-400",
  "waiting for formal application": "text-violet-600 dark:text-violet-400",
  enrolling: "text-indigo-600 dark:text-indigo-400",
  testing: "text-cyan-600 dark:text-cyan-400",
  enrolled: "text-emerald-600 dark:text-emerald-400",
  "not enrolled": "text-rose-600 dark:text-rose-400",
  "enrolled at other school": "text-orange-600 dark:text-orange-400",
  rejected: "text-red-600 dark:text-red-400",
}

function getStatusColor(status: string): string {
  return statusColors[status] ?? "bg-slate-300 dark:bg-slate-600"
}

function getStatusLabelColor(status: string): string {
  return statusLabelColors[status] ?? "text-slate-500 dark:text-slate-400"
}

function formatDuration(ms: number): string {
  const days = Math.floor(ms / (1000 * 60 * 60 * 24))
  if (days >= 1) return `${days}d`
  const hours = Math.floor(ms / (1000 * 60 * 60))
  if (hours >= 1) return `${hours}h`
  const mins = Math.floor(ms / (1000 * 60))
  return `${mins}m`
}

const SegmentDetails = ({
  item,
  segment,
  now,
}: {
  item: TimelineItemData
  segment: TimelineSegmentData
  now: number
}) => {
  const start = new Date(segment.startDate).getTime()
  const end = segment.endDate ? new Date(segment.endDate).getTime() : now
  return (
    <div className="text-xs">
      <div className="font-semibold text-slate-900 dark:text-slate-100">
        {segment.status}
      </div>
      <div className="text-slate-500 dark:text-slate-400">{item.label}</div>
      <div className="mt-1 text-slate-400 dark:text-slate-500">
        <DateTimeDisplay
          kind={
            /^\d{4}-\d{2}-\d{2}$/.test(segment.startDate)
              ? "calendar-date"
              : "timestamp"
          }
          value={segment.startDate}
        />
        {" → "}
        {segment.endDate ? (
          <DateTimeDisplay
            kind={
              /^\d{4}-\d{2}-\d{2}$/.test(segment.endDate)
                ? "calendar-date"
                : "timestamp"
            }
            value={segment.endDate}
          />
        ) : (
          "now"
        )}
        {" · "}
        {formatDuration(end - start)}
      </div>
    </div>
  )
}

export function JourneyTimeline({ items, now }: JourneyTimelineProps) {
  const { globalStart, globalEnd, sortedItems } = useMemo(() => {
    if (items.length === 0) {
      return {
        globalStart: 0,
        globalEnd: 1,
        sortedItems: [],
      }
    }

    let min = Infinity
    let max = -Infinity

    for (const item of items) {
      const s = new Date(item.startDate).getTime()
      if (s < min) min = s
      const e = item.endDate ? new Date(item.endDate).getTime() : now
      if (e > max) max = e
    }

    if (min === max) max = min + 1

    const sorted = [...items].sort(
      (a, b) =>
        new Date(a.startDate).getTime() - new Date(b.startDate).getTime(),
    )

    return { globalStart: min, globalEnd: max, sortedItems: sorted }
  }, [items, now])

  const totalRange = globalEnd - globalStart

  const pct = useMemo(
    () => (time: number) => ((time - globalStart) / totalRange) * 100,
    [globalStart, totalRange],
  )

  const axisMarks = useMemo(() => {
    const marks: { key: string; label: string; pct: number }[] = []
    const start = new Date(globalStart)
    start.setUTCDate(1)
    start.setUTCHours(0, 0, 0, 0)

    const end = new Date(globalEnd)
    const cursor = new Date(start)

    while (cursor.getTime() <= end.getTime()) {
      const t = cursor.getTime()
      if (t >= globalStart) {
        marks.push({
          key: cursor.toISOString(),
          label: cursor.toISOString().slice(0, 10),
          pct: pct(t),
        })
      }
      cursor.setUTCMonth(cursor.getUTCMonth() + 1)
    }
    return marks
  }, [globalStart, globalEnd, pct])

  const legendStatuses = useMemo(() => {
    const seen = new Set<string>()
    for (const item of items) {
      for (const seg of item.segments) {
        seen.add(seg.status)
      }
    }
    return [...seen]
  }, [items])

  if (items.length === 0) {
    return null
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
      <div className="mb-3 flex flex-wrap items-center justify-end gap-3">
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {legendStatuses.map((status) => (
            <div
              key={status}
              className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"
            >
              <span
                className={cn("h-2.5 w-2.5 rounded-sm", getStatusColor(status))}
              />
              <span className="capitalize">{status}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Time axis */}
      <div className="relative ml-44 mb-1 h-5 select-none border-b border-slate-100 dark:border-slate-800">
        {axisMarks.map((mark) => (
          <div
            key={mark.key}
            className="absolute top-0 flex flex-col items-center"
            style={{ left: `${mark.pct}%` }}
          >
            <span className="text-[10px] text-slate-400 dark:text-slate-500">
              <DateTimeDisplay kind="calendar-date" value={mark.label} />
            </span>
            <span className="h-2 w-px bg-slate-200 dark:bg-slate-700" />
          </div>
        ))}
      </div>

      {/* Timeline rows */}
      <div className="space-y-1">
        {sortedItems.map((item) => {
          const itemStart = new Date(item.startDate).getTime()
          const itemEnd = item.endDate ? new Date(item.endDate).getTime() : now
          const leftPct = pct(itemStart)
          const widthPct = Math.max(pct(itemEnd) - leftPct, 0.5)

          return (
            <div key={item.id} className="group flex items-center gap-2">
              {/* Label */}
              <div className="w-42 flex-shrink-0 truncate text-right text-xs text-slate-600 dark:text-slate-400">
                {item.label}
              </div>

              {/* Bar container */}
              <div className="relative h-7 flex-1 overflow-hidden rounded">
                {/* Grid lines */}
                {axisMarks.map((mark) => (
                  <div
                    key={mark.key}
                    className="absolute top-0 h-full w-px bg-slate-50 dark:bg-slate-800/50"
                    style={{ left: `${mark.pct}%` }}
                  />
                ))}

                {/* Bar */}
                <div
                  className="absolute top-1 flex h-5 items-center overflow-hidden rounded"
                  style={{
                    left: `${leftPct}%`,
                    width: `${widthPct}%`,
                  }}
                >
                  {item.segments.map((seg, i) => {
                    const segStart = new Date(seg.startDate).getTime()
                    const segEnd = seg.endDate
                      ? new Date(seg.endDate).getTime()
                      : now
                    const segLeft =
                      ((segStart - itemStart) / (itemEnd - itemStart || 1)) *
                      100
                    const segWidth =
                      ((segEnd - segStart) / (itemEnd - itemStart || 1)) * 100
                    const segKey = `${item.id}-${i}`
                    return (
                      <Popover key={segKey}>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className={cn(
                              "relative h-full transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-500",
                              getStatusColor(seg.status),
                            )}
                            style={{
                              position: "absolute",
                              left: `${segLeft}%`,
                              width: `${Math.max(segWidth, 0.5)}%`,
                            }}
                            aria-label={`${item.label}: ${seg.status} — show dates`}
                          />
                        </PopoverTrigger>
                        <PopoverContent className="w-80 max-w-[calc(100vw-2rem)] p-3">
                          <SegmentDetails item={item} segment={seg} now={now} />
                        </PopoverContent>
                      </Popover>
                    )
                  })}
                </div>
              </div>

              {/* Outcome badge */}
              <div className="w-24 flex-shrink-0 text-right text-xs">
                <span
                  className={cn(
                    "font-medium",
                    getStatusLabelColor(item.currentStatus),
                  )}
                >
                  {item.currentStatus}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Summary stats */}
      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
        {(() => {
          const enrolled = items.filter(
            (i) => i.currentStatus === "enrolled",
          ).length
          const declined = items.filter(
            (i) =>
              i.currentStatus === "not enrolled" ||
              i.currentStatus === "rejected" ||
              i.currentStatus === "enrolled at other school",
          ).length
          const pending = items.length - enrolled - declined

          const completed = items.filter(
            (i) => i.endDate !== null && i.endDate !== undefined,
          )
          const avgDays =
            completed.length > 0
              ? completed.reduce((sum, i) => {
                  const endMs = new Date(i.endDate as string).getTime()
                  const ms = endMs - new Date(i.startDate).getTime()
                  return sum + ms / (1000 * 60 * 60 * 24)
                }, 0) / completed.length
              : 0

          return (
            <>
              <Stat label="Total" value={String(items.length)} />
              <Stat
                label="Enrolled"
                value={String(enrolled)}
                tone="text-emerald-600 dark:text-emerald-400"
              />
              <Stat
                label="Declined"
                value={String(declined)}
                tone="text-rose-600 dark:text-rose-400"
              />
              <Stat label="Pending" value={String(pending)} />
              <Stat
                label="Avg time to outcome"
                value={avgDays > 0 ? `${Math.round(avgDays * 10) / 10}d` : "—"}
              />
            </>
          )
        })()}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: string
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="text-slate-400 dark:text-slate-500">{label}</span>
      <span
        className={cn("font-semibold text-slate-700 dark:text-slate-300", tone)}
      >
        {value}
      </span>
    </div>
  )
}
