"use client"

import { type ReactNode, useState } from "react"
import type { HandbookData } from "./cedar-types"
import { cn } from "@/lib/utils"

const NAV_GROUPS = ["Roles", "Service accounts", "Public"] as const

export function AuthorizationAccess({ handbook }: { handbook: HandbookData }) {
  const [selectedId, setSelectedId] = useState(handbook.roles[0]?.id ?? null)
  const selected = handbook.roles.find((item) => item.id === selectedId)
  const picture = selectedId ? (handbook.pictures[selectedId] ?? null) : null

  return (
    <div className="flex min-h-0 flex-1 gap-8">
      <nav className="w-56 shrink-0 overflow-y-auto border-r border-slate-200 pr-4 dark:border-slate-800">
        {NAV_GROUPS.map((group) => {
          const items = handbook.roles.filter((item) => item.group === group)
          if (items.length === 0) return null
          return (
            <div key={group} className="mb-5">
              <p className="mb-2 text-xs font-semibold tracking-widest text-slate-500 uppercase">
                {group}
              </p>
              <ul className="space-y-1">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(item.id)}
                      className={cn(
                        "w-full rounded-md px-2 py-1.5 text-left text-sm",
                        item.id === selectedId
                          ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                          : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
                      )}
                    >
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </nav>

      <article className="min-w-0 flex-1 overflow-y-auto pb-24">
        <p className="font-serif text-xs tracking-[0.2em] text-slate-500 uppercase">
          How access works here
        </p>
        <h2 className="mt-2 font-serif text-4xl text-slate-900 dark:text-slate-50">
          {selected?.label ?? "Pick a principal"}
        </h2>
        {handbook.error ? (
          <p className="mt-4 text-sm text-rose-700">{handbook.error}</p>
        ) : null}
        {!picture ? (
          <p className="mt-6 font-serif text-lg text-slate-500">
            Click a principal. Answers were computed when this page loaded.
          </p>
        ) : picture.groups.every((group) =>
            group.items.every((item) => !item.allow),
          ) ? (
          <p className="mt-6 font-serif text-lg text-slate-500">
            Nothing in this sketch.
          </p>
        ) : (
          picture.groups
            .map((group) => ({
              ...group,
              items: group.items.filter((item) => item.allow),
            }))
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <Section key={group.title} title={group.title}>
                <ul className="space-y-3">
                  {group.items.map((item) => (
                    <li key={item.label}>
                      <span className="font-medium">{item.label}</span>
                      {item.details.length > 0 ? (
                        <ul className="mt-1 list-disc pl-6 text-slate-600 dark:text-slate-400">
                          {item.details.map((detail) => (
                            <li key={detail}>{detail}</li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Section>
            ))
        )}
      </article>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10 max-w-xl">
      <h3 className="font-serif text-xl text-slate-900 dark:text-slate-50">
        {title}
      </h3>
      <div className="mt-3 font-serif text-base leading-relaxed text-slate-800 dark:text-slate-200">
        {children}
      </div>
    </section>
  )
}
