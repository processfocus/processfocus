import Link from "next/link"

export default function Loading() {
  return (
    <section className="space-y-6" aria-label="Workflow information">
      <Link
        href="/processes"
        className="text-sm font-medium text-blue-500 hover:text-blue-600"
      >
        &larr; Back to processes
      </Link>
      <div className="rounded-2xl border border-slate-200 p-6 dark:border-slate-800">
        <h1 className="text-2xl font-semibold">Workflow information</h1>
        <p role="status" className="mt-2 text-sm text-slate-500">
          Loading workflow and documentation…
        </p>
      </div>
    </section>
  )
}
