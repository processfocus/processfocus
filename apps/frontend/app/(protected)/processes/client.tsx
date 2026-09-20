"use client"

import dynamic from "next/dynamic"

// Disable SSR for this component because:
// 1. useProcessesQuery uses useSyncExternalStore without getServerSnapshot
// 2. Authentication tokens are only available client-side
const ProcessesPageClient = dynamic(() => import("./processes-client"), {
  ssr: false,
  loading: () => (
    <div className="flex-1 overflow-y-auto">
      <section className="space-y-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <output
                className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-blue-600 border-r-transparent motion-reduce:animate-[spin_1.5s_linear_infinite]"
                aria-label="Loading processes"
              />
              <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
                Loading processes...
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  ),
})

export default function ClientPage() {
  return <ProcessesPageClient />
}
