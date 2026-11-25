"use client"

import { useEffect, useState } from "react"
import type {
  FormRendererOptions,
  FrontendPluginField,
  FrontendPluginForm,
} from "@pf/frontend-plugin-host"
import { getPluginRegistration } from "./plugin-registry"
import { loadScript } from "./plugin-scripts"

/** Assets belong to the installed renderer, not a serialized schema walker. */
export function RegisteredPluginField({
  form,
  field,
  options,
}: {
  readonly form: FrontendPluginForm
  readonly field: FrontendPluginField
  readonly options: FormRendererOptions
}) {
  const registration = getPluginRegistration(field.pluginType)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    let active = true
    setReady(false)
    setError(undefined)
    Promise.all(
      (registration?.scripts ?? []).map((script) =>
        loadScript(script.src, script.async ?? true),
      ),
    ).then(
      () => {
        if (active) setReady(true)
      },
      (cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Failed to load plugin scripts",
          )
      },
    )
    return () => {
      active = false
    }
  }, [registration])
  if (!registration)
    throw new Error(
      `No renderer registered for plugin type: ${field.pluginType}`,
    )
  if (error) return <p role="alert">{error}</p>
  if (!ready) return <p>Loading plugin...</p>
  return registration.renderer(form, field, false, options)
}
