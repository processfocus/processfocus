import { NotFound } from "@mcrovero/effect-nextjs/Navigation"
import { Effect } from "effect"
import Link from "next/link"
import { PublicCompletionCorrectionForm } from "../../components/public-completion-correction-form"
import { BasePage } from "@/lib/effect/runtime"

const CorrectPublicCompletionPage = Effect.fn("CorrectPublicCompletionPage")(
  function* ({
    params,
    searchParams,
  }: {
    params: Promise<{ stepPath: string[] }>
    searchParams: Promise<{ todoId?: string }>
  }) {
    const { stepPath: pathSegments } = yield* Effect.promise(() => params)
    const { todoId } = yield* Effect.promise(() => searchParams)

    if (
      pathSegments.some((segment) => segment.toLowerCase().endsWith(".map"))
    ) {
      return yield* NotFound
    }

    if (pathSegments.length === 0) {
      return yield* NotFound
    }

    const stepName = decodeURIComponent(
      pathSegments[pathSegments.length - 1] ?? "",
    )

    return (
      <div className="flex-1">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
            <div className="mb-6 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <Link
                href="/to-dos"
                prefetch={false}
                className="hover:text-slate-700 dark:hover:text-slate-200"
              >
                To-dos
              </Link>
              <span>/</span>
              <span>Correction</span>
            </div>
            <PublicCompletionCorrectionForm
              todoId={todoId}
              fallbackStepName={stepName}
            />
          </div>
        </div>
      </div>
    )
  },
)

export default BasePage.build(CorrectPublicCompletionPage)
