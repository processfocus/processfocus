export function DashboardSkeleton() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center justify-center py-12">
        <output className="block text-center" aria-live="polite">
          <span
            className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-blue-600 border-r-transparent motion-reduce:animate-[spin_1.5s_linear_infinite]"
            aria-hidden="true"
          />
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
            Loading dashboard...
          </p>
        </output>
      </div>
    </div>
  )
}
