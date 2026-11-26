"use client"

import type { ComponentProps } from "react"
import { Suspense, use } from "react"
import { EffectSchemaForm } from "@pf/form/effect-schema-form"
import { loadBrowserFormDefinition } from "@/lib/frontend-form-loaders"

type Props = Omit<ComponentProps<typeof EffectSchemaForm>, "schema"> & {
  formPath: string
}

function LoadedForm({ formPath, ...props }: Props) {
  const schema = use(loadBrowserFormDefinition(formPath))
  return <EffectSchemaForm {...props} schema={schema} />
}

/** Both anonymous start surfaces use the same lazy organisation artifact and renderer. */
export function AnonymousStartForm(props: Props) {
  return (
    <Suspense fallback={<p role="status">Loading form…</p>}>
      <LoadedForm {...props} />
    </Suspense>
  )
}
