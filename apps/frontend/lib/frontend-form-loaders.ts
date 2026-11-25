"use client"

import { Schema } from "effect"
import type { BrowserFormSchema } from "@pf/form/effect-schema-form"
import { organisationFormLoaders } from "@/lib/organisation-form-loaders"

const loaded = new Map<string, Promise<BrowserFormSchema>>()

/** The promise is stable so React can suspend on the lazy organisation module. */
export const loadBrowserFormDefinition = (
  stepPath: string,
): Promise<BrowserFormSchema> => {
  const cached = loaded.get(stepPath)
  if (cached) return cached
  const loader = organisationFormLoaders[stepPath]
  if (!loader) throw new Error(`No browser form artifact for ${stepPath}`)
  const promise = loader().then((definition) => {
    if (!Schema.isSchema(definition))
      throw new Error(
        `Browser form ${stepPath} does not export an Effect schema`,
      )
    if (
      !("fields" in definition) ||
      typeof definition.fields !== "object" ||
      definition.fields === null ||
      !Object.values(definition.fields).every(Schema.isSchema)
    ) {
      throw new Error(`Browser form ${stepPath} must export a Schema.Struct`)
    }
    // Executable schemas carry no runtime service witness. The browser binding
    // authoring contract requires portable codecs; validate the module shape here.
    return definition as BrowserFormSchema
  })
  const retryable = promise.catch((error: unknown) => {
    loaded.delete(stepPath)
    throw error
  })
  loaded.set(stepPath, retryable)
  return retryable
}
