import { notFound } from "next/navigation"
import { Suspense } from "react"
import { PublicFormBrandingCard } from "./public-form-branding-card"
import { ExpiredPublicTodoClient, PublicTodoClient } from "./public-todo-client"
import { PublicTodoStateContent } from "./public-todo-state-content"
import type { FrontendManifest } from "@/lib/frontend-manifest"
import { getFrontendManifest } from "@/lib/frontend-manifest-store"
import { publicTodoStateCopy } from "@/lib/public-todo-model"
import {
  PublicTodoConfigurationError,
  fetchPublicTodo,
  isPublicTodoLinkError,
} from "@/lib/public-todo-server"

const StateCard = ({
  title,
  description,
  publicFormBranding,
}: {
  readonly title: string
  readonly description: string
  readonly publicFormBranding: FrontendManifest["publicFormBranding"]
}) => (
  <PublicFormBrandingCard branding={publicFormBranding} className="p-8">
    <PublicTodoStateContent title={title} description={description} />
  </PublicFormBrandingCard>
)

const LoadingCard = ({
  publicFormBranding,
}: {
  readonly publicFormBranding: FrontendManifest["publicFormBranding"]
}) => (
  <PublicFormBrandingCard branding={publicFormBranding} className="p-8">
    <div aria-busy="true" aria-live="polite" className="space-y-4">
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
        Loading form
      </p>
      <div className="h-8 w-2/3 rounded-md bg-slate-200" />
      <div className="space-y-2">
        <div className="h-4 w-full rounded bg-slate-100" />
        <div className="h-4 w-5/6 rounded bg-slate-100" />
      </div>
    </div>
  </PublicFormBrandingCard>
)

export default function PublicTodoPage({
  params,
}: {
  readonly params: Promise<{ token: string }>
}) {
  const publicFormBranding = getFrontendManifest().publicFormBranding

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-2xl">
        <Suspense
          fallback={<LoadingCard publicFormBranding={publicFormBranding} />}
        >
          <PublicTodoContent
            params={params}
            publicFormBranding={publicFormBranding}
          />
        </Suspense>
      </div>
    </main>
  )
}

// Exported so route tests can exercise dynamic token handling without rendering the static shell.
export async function PublicTodoContent({
  params,
  publicFormBranding,
}: {
  readonly params: Promise<{ token: string }>
  readonly publicFormBranding: FrontendManifest["publicFormBranding"]
}) {
  const { token } = await params
  const todo = await fetchPublicTodo(token).catch((error: unknown) => {
    if (error instanceof PublicTodoConfigurationError) {
      throw error
    }

    if (!isPublicTodoLinkError(error)) {
      throw error
    }

    return null
  })

  if (!todo) {
    notFound()
  }

  return (
    <>
      {todo.status === "ACTIVE" && todo.formMetadata ? (
        <PublicFormBrandingCard branding={publicFormBranding}>
          <PublicTodoClient
            token={token}
            todoId={todo.todoId}
            submittedTitle={
              publicFormBranding
                ? todo.formMetadata.processName
                : (todo.organisationName ?? todo.formMetadata.processName)
            }
            formMetadata={todo.formMetadata}
          />
        </PublicFormBrandingCard>
      ) : todo.status === "ACTIVE" ? (
        <StateCard
          title="Temporarily unavailable"
          description="This form is temporarily unavailable. Try again later."
          publicFormBranding={publicFormBranding}
        />
      ) : todo.status === "EXPIRED" ? (
        <PublicFormBrandingCard branding={publicFormBranding} className="p-8">
          <ExpiredPublicTodoClient token={token} />
        </PublicFormBrandingCard>
      ) : (
        <StateCard
          {...publicTodoStateCopy(todo.status)}
          publicFormBranding={publicFormBranding}
        />
      )}
    </>
  )
}
