export function AuthorizationLoading() {
  return (
    <div
      className="flex min-h-0 flex-1 gap-8 overflow-hidden"
      role="status"
      aria-label="Loading authorisation content"
    >
      <div
        className="w-56 shrink-0 space-y-3 border-r border-slate-200 pr-4 dark:border-slate-800"
        aria-hidden="true"
      >
        <div className="h-3 w-20 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
        <div className="h-8 w-full animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
        <div className="h-8 w-4/5 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
        <div className="h-8 w-11/12 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
      </div>
      <div className="min-w-0 flex-1 space-y-4" aria-hidden="true">
        <div className="h-3 w-32 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
        <div className="h-10 w-72 max-w-full animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
        <div className="h-5 w-full max-w-xl animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
        <div className="h-5 w-4/5 max-w-lg animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
      </div>
    </div>
  )
}
