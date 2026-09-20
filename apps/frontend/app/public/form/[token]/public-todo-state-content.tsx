import { cn } from "@/lib/utils"

interface PublicTodoStateContentProps {
  readonly eyebrow?: string | undefined
  readonly title: string
  readonly description: string
}

export const PublicTodoStateContent = ({
  eyebrow,
  title,
  description,
}: PublicTodoStateContentProps) => (
  <>
    {eyebrow ? (
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
        {eyebrow}
      </p>
    ) : null}
    <h1
      className={cn("text-3xl font-semibold text-slate-950", eyebrow && "mt-3")}
    >
      {title}
    </h1>
    <p className="mt-3 text-base leading-7 text-slate-600">{description}</p>
  </>
)
