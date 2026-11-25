"use client"

import { useEffect, useMemo, useState } from "react"
import type { FormRequestData } from "@pf/form-schema"
import { useLookup } from "./lookup-context"

export const FormPrefill = ({
  form,
  config,
  value,
  onReady,
}: {
  form: { setFieldValue: (field: string, value: unknown) => void }
  config: NonNullable<FormRequestData["prefill"]>
  value: unknown
  onReady: (value: string | undefined) => void
}) => {
  const { fetchPrefill } = useLookup()
  const fieldsKey = config.fields.join("\0")
  const fields = useMemo(() => fieldsKey.split("\0"), [fieldsKey])
  const queryName = config.queryName
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    typeof value === "string" && value ? "loading" : "ready",
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry deliberately reruns the load without changing the selection.
  useEffect(() => {
    let active = true
    onReady(undefined)
    for (const field of fields) form.setFieldValue(field, undefined)
    if (typeof value !== "string" || !value) {
      setStatus("ready")
      return () => {
        active = false
      }
    }
    setStatus("loading")
    const load = fetchPrefill
    Promise.resolve()
      .then(() => {
        if (!load) throw new Error("Prefill service is unavailable")
        return load(queryName, value)
      })
      .then((result) => {
        if (!active) return
        if (
          typeof result !== "object" ||
          result === null ||
          Array.isArray(result)
        )
          throw new Error("Invalid prefill response")
        for (const field of fields) {
          if (!(field in result)) throw new Error("Missing prefill value")
        }
        for (const [field, loaded] of Object.entries(result)) {
          if (fields.includes(field)) form.setFieldValue(field, loaded)
        }
        onReady(value)
        setStatus("ready")
      })
      .catch(() => {
        if (active) setStatus("error")
      })
    return () => {
      active = false
    }
  }, [form, fields, queryName, value, fetchPrefill, attempt, onReady])
  if (status === "loading") return <p role="status">Loading saved values…</p>
  if (status === "error")
    return (
      <div role="alert">
        Could not load saved values.{" "}
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          Retry
        </button>
      </div>
    )
  return null
}
