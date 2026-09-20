"use client"

import { ChevronRight, CircleCheckBig, PlayCircle } from "lucide-react"
import Link from "next/link"
import type { ReactNode } from "react"
import type { MobileHomeViewModel } from "@/lib/mobile-home-view-model"

export function MobileHomeSwitchboard({
  viewModel,
}: {
  viewModel: MobileHomeViewModel
}) {
  return (
    <section aria-label={viewModel.title}>
      <div
        className="mx-auto flex w-full max-w-md flex-col gap-4"
        data-testid="mobile-home-switchboard"
      >
        <MobileHomeCard
          href={viewModel.cards.todos.href}
          title={viewModel.cards.todos.title}
          detail={viewModel.cards.todos.detail}
          supportingText={viewModel.cards.todos.supportingText}
          icon={<CircleCheckBig className="h-5 w-5" />}
          accentClassName="bg-blue-600 text-white"
          detailTestId="mobile-home-open-task-count"
          cardTestId="mobile-home-todos-card"
        />
        <MobileHomeCard
          href={viewModel.cards.startProcess.href}
          title={viewModel.cards.startProcess.title}
          detail={viewModel.cards.startProcess.detail}
          supportingText={viewModel.cards.startProcess.supportingText}
          icon={<PlayCircle className="h-5 w-5" />}
          accentClassName="bg-emerald-600 text-white"
          cardTestId="mobile-home-start-process-card"
        />
      </div>
    </section>
  )
}

function MobileHomeCard({
  href,
  title,
  detail,
  supportingText,
  icon,
  accentClassName,
  detailTestId,
  cardTestId,
}: {
  href: string
  title: string
  detail: string
  supportingText: string
  icon: ReactNode
  accentClassName: string
  detailTestId?: string
  cardTestId: string
}) {
  return (
    <Link
      href={href}
      className="group block rounded-3xl border border-slate-200 bg-white p-5 shadow-sm transition-transform duration-150 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md dark:border-slate-800 dark:bg-slate-950 dark:hover:border-slate-700"
      data-testid={cardTestId}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-3">
          <span
            className={`inline-flex h-11 w-11 items-center justify-center rounded-2xl ${accentClassName}`}
            aria-hidden="true"
          >
            {icon}
          </span>
          <div className="space-y-1">
            <h2 className="text-xl font-semibold text-slate-950 dark:text-slate-50">
              {title}
            </h2>
            <p
              className="text-lg font-medium text-slate-900 dark:text-slate-100"
              data-testid={detailTestId}
            >
              {detail}
            </p>
            <p className="max-w-xs text-sm leading-6 text-slate-600 dark:text-slate-400">
              {supportingText}
            </p>
          </div>
        </div>
        <ChevronRight
          className="mt-1 h-5 w-5 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 dark:text-slate-500"
          aria-hidden="true"
        />
      </div>
    </Link>
  )
}
