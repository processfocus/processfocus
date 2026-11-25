"use client"

import { useEffect, useRef, useState } from "react"
import type { FormRequestData } from "@pf/form-schema"
import {
  LookupField,
  type LookupFieldItem,
  useFieldContext,
} from "@pf/shadcn-components"
import { type LookupOptions, useLookup } from "./lookup-context"

/** Only the authorized server lookup runs; the shared annotation supplies UI intent. */
export function SchemaLookup({
  stepPath,
  field,
  label,
  disabled,
  allowFreeText,
  binding,
  values,
  options,
  emptyValue,
  onUnmatchedChange,
}: {
  stepPath: string
  field: string
  label: string
  disabled: boolean
  allowFreeText: boolean
  binding: NonNullable<FormRequestData["lookups"]>[string] | undefined
  values: Record<string, unknown>
  options: LookupOptions | undefined
  emptyValue: "" | null | undefined
  onUnmatchedChange: (unmatched: boolean) => void
}) {
  const lookup = useLookup()
  const control = useFieldContext<string | null | undefined>()
  const dependencyValues = Object.fromEntries(
    (binding?.dependencies ?? []).map((name) => [name, values[name] ?? null]),
  )
  const dependencyKey = JSON.stringify(dependencyValues)
  const [search, setSearch] = useState({
    filter: "",
    dependencyKey,
    variables: dependencyValues,
    debounce: true,
  })
  const [result, setResult] = useState<{
    items: LookupFieldItem[]
    loading: boolean
    error?: string
  }>({ items: [], loading: true })
  // A dependency change invalidates the old search before its response can render.
  if (search.dependencyKey !== dependencyKey) {
    setSearch({
      filter: "",
      dependencyKey,
      variables: dependencyValues,
      debounce: false,
    })
    setResult({ items: [], loading: true })
  }
  const unavailable =
    disabled ||
    Object.values(dependencyValues).some(
      (value) => value === "" || value == null,
    )
  const previousDependency = useRef(dependencyKey)
  useEffect(() => {
    if (previousDependency.current !== dependencyKey) {
      previousDependency.current = dependencyKey
      control.handleChange(emptyValue)
      onUnmatchedChange(false)
    }
  }, [dependencyKey, control, emptyValue, onUnmatchedChange])
  const queryName = binding?.dependencies.length ? binding.queryName : undefined
  useEffect(() => {
    if (unavailable) return
    let active = true
    const fetch = () => {
      const request = queryName
        ? lookup.fetchDependentSuggestions(queryName, {
            input: { filter: search.filter, ...search.variables },
            limit: 20,
          })
        : lookup.fetchSuggestions(stepPath, field, search.filter, 20, options)
      request.then(
        (items) => {
          if (active) setResult({ items, loading: false })
        },
        () => {
          if (active)
            setResult({
              items: [],
              loading: false,
              error: "Could not load choices. Please try again.",
            })
        },
      )
    }
    // Dependency changes reload immediately; user searches are debounced.
    const timer = search.debounce ? setTimeout(fetch, 300) : undefined
    if (!search.debounce) fetch()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [lookup, stepPath, field, search, unavailable, queryName, options])
  return (
    <LookupField
      key={dependencyKey}
      emptyValue={emptyValue}
      onUnmatchedChange={onUnmatchedChange}
      label={label}
      readOnly={unavailable}
      allowFreeText={allowFreeText}
      {...result}
      onSearch={(value) => {
        setResult({ items: [], loading: true })
        setSearch({ ...search, filter: value, debounce: true })
      }}
    />
  )
}
