"use client"

import { type ComponentProps, Suspense, use } from "react"
import { EffectSchemaForm } from "@pf/form/effect-schema-form"
import { loadBrowserFormDefinition } from "@/lib/frontend-form-loaders"

type Props = Omit<ComponentProps<typeof EffectSchemaForm>, "schema"> & {
  formPath: string
}

function LoadedListSchemaForm({ formPath, ...props }: Props) {
  const schema = use(loadBrowserFormDefinition(formPath))
  return (
    <EffectSchemaForm
      {...props}
      schema={schema}
      stepPath={formPath.slice(0, formPath.lastIndexOf("/"))}
    />
  )
}

export function ListSchemaForm(props: Props) {
  return (
    <Suspense fallback={<p>Loading form…</p>}>
      <LoadedListSchemaForm {...props} />
    </Suspense>
  )
}
