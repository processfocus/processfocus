import { type CedarTokenKind, tokenizeCedar } from "@/lib/cedar-highlight"
import { cn } from "@/lib/utils"

const TOKEN_CLASS: Record<CedarTokenKind, string> = {
  comment: "text-slate-500 italic",
  string: "text-emerald-700 dark:text-emerald-300",
  keyword: "text-blue-700 dark:text-blue-300",
  entity: "text-violet-700 dark:text-violet-300",
  text: "text-slate-800 dark:text-slate-200",
}

export function CedarSource({
  source,
  empty,
}: {
  source: string
  empty: string
}) {
  if (source.trim() === "") {
    return <p className="text-sm text-slate-500">{empty}</p>
  }

  return (
    <pre className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm leading-6 dark:border-slate-800 dark:bg-slate-950">
      <code>
        {tokenizeCedar(source).map((token) => (
          <span key={token.start} className={cn(TOKEN_CLASS[token.kind])}>
            {token.value}
          </span>
        ))}
      </code>
    </pre>
  )
}
