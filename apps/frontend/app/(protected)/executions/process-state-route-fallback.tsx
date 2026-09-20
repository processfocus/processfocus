export function ProcessStateRouteFallback() {
  return (
    <div className="flex min-h-60 items-center justify-center rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex items-center justify-center py-8">
          <div
            role="status"
            aria-label="Loading process state"
            className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600"
          />
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Loading process state...
        </p>
      </div>
    </div>
  )
}
