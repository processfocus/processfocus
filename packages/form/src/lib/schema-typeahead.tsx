"use client"

import { useEffect, useEffectEvent, useRef, useState } from "react"
import { type FormRequestData, searchLookupItems } from "@pf/form-schema"
import {
  Button,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Popover,
  PopoverAnchor,
  PopoverContent,
  useFieldContext,
  useFormContext,
} from "@pf/shadcn-components"
import {
  type LookupOptions,
  type LookupSuggestion,
  useLookup,
} from "./lookup-context"

type Result = { items: LookupSuggestion[] } & (
  | { status: "idle" | "loading" | "error" | "overflow" }
  | { status: "ready"; hasMore: boolean }
)

export type LocalLookupCache = Map<
  string,
  { items: LookupSuggestion[]; revision: number; dependencyKey: string }
>

/** Both modes keep editing text separate from the submitted identity. */
export function SchemaTypeahead({
  stepPath,
  field,
  label,
  disabled,
  options,
  binding,
  values,
  emptyValue,
  onUnmatchedChange,
  local,
}: {
  stepPath: string
  field: string
  label: string
  disabled: boolean
  options: LookupOptions | undefined
  binding: NonNullable<FormRequestData["lookups"]>[string] | undefined
  values: Record<string, unknown>
  emptyValue: "" | null | undefined
  onUnmatchedChange: (unmatched: boolean) => void
  local?:
    | {
        maxItems: number
        cache: LocalLookupCache
        revision: number
      }
    | undefined
}) {
  const service = useLookup()
  const control = useFieldContext<string | null | undefined>()
  const cacheKey = control.name
  const form = useFormContext()
  const [text, setText] = useState("")
  const [resolution, setResolution] = useState<
    "idle" | "loading" | "unavailable"
  >(control.state.value ? "loading" : "idle")
  const selected = useRef<string | null>(null)
  const resolutionGeneration = useRef(0)
  const selectedValue = control.state.value
  const markUnmatched = useEffectEvent(onUnmatchedChange)
  useEffect(() => {
    if (!selectedValue || selected.current === selectedValue) return
    let live = true
    const version = ++resolutionGeneration.current
    setText("")
    setResolution("loading")
    markUnmatched(true)
    const request = service.resolveSelection
      ? service.resolveSelection(stepPath, field, selectedValue, options)
      : Promise.resolve(null)
    const finish = (item: LookupSuggestion | null) => {
      if (!live || version !== resolutionGeneration.current) return
      if (item?.value === selectedValue) {
        selected.current = item.value
        setText(item.label)
        setResolution("idle")
        markUnmatched(false)
      } else {
        setResolution("unavailable")
        markUnmatched(true)
      }
    }
    request.then(finish, () => finish(null))
    return () => {
      live = false
    }
  }, [selectedValue, service, stepPath, field, options])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [request, setRequest] = useState<{
    filter: string
    immediate: boolean
    version: number
  } | null>(null)
  const [result, setResult] = useState<Result>({ status: "idle", items: [] })
  const generation = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const [visibleDependency, setVisibleDependency] = useState<string | null>(
    null,
  )
  const [retry, setRetry] = useState(0)
  const [localFilter, setLocalFilter] = useState("")
  const completedAttempt = useRef("")
  const maxItems = local?.maxItems
  const cache = local?.cache
  const revision = local?.revision ?? 0
  const dependencyKey = JSON.stringify(
    Object.fromEntries(
      (binding?.dependencies ?? []).map((name) => [name, values[name] ?? null]),
    ),
  )
  const dependencyMissing = (binding?.dependencies ?? []).some(
    (name) => values[name] == null || values[name] === "",
  )
  const unavailable = disabled || dependencyMissing
  const [previousDependency, setPreviousDependency] = useState(dependencyKey)
  if (previousDependency !== dependencyKey) {
    setPreviousDependency(dependencyKey)
    setText("")
    setLocalFilter("")
    setResult({ status: "idle", items: [] })
    setActive(-1)
    setRequest(null)
    setOpen(false)
    setResolution("idle")
    setVisibleDependency(null)
  }
  const resetDependency = useEffectEvent(() => {
    generation.current += 1
    resolutionGeneration.current += 1
    selected.current = null
    control.handleChange(emptyValue)
    onUnmatchedChange(false)
  })
  const lastDependency = useRef(dependencyKey)
  useEffect(() => {
    if (lastDependency.current === dependencyKey) return
    lastDependency.current = dependencyKey
    cache?.delete(cacheKey)
    completedAttempt.current = ""
    resetDependency()
  }, [dependencyKey, cache, cacheKey])
  useEffect(() => {
    if (maxItems === undefined || !inputRef.current) return
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      setVisibleDependency(dependencyKey)
      observer.disconnect()
    })
    observer.observe(inputRef.current)
    return () => observer.disconnect()
  }, [maxItems, dependencyKey])
  const loadLocal = useEffectEvent(() => {
    if (!local) return Promise.reject(new Error("Local lookup unavailable"))
    return binding?.dependencies.length
      ? service.fetchDependentSuggestions(binding.queryName, {
          input: {
            filter: "",
            ...Object.fromEntries(
              binding.dependencies.map((name) => [name, values[name]]),
            ),
          },
          limit: local.maxItems + 1,
        })
      : service.fetchSuggestions(
          stepPath,
          field,
          "",
          local.maxItems + 1,
          options?.todoId ? { todoId: options.todoId } : undefined,
        )
  })
  useEffect(() => {
    if (
      maxItems === undefined ||
      !cache ||
      visibleDependency !== dependencyKey ||
      unavailable
    )
      return
    const saved = cache.get(cacheKey)
    if (saved?.dependencyKey === dependencyKey && saved.revision === revision) {
      setResult({ status: "ready", items: saved.items, hasMore: false })
      return
    }
    const attempt = JSON.stringify([dependencyKey, revision, retry])
    if (completedAttempt.current === attempt) return
    let live = true
    setResult((previous) => ({
      status: "loading",
      items:
        saved?.dependencyKey === dependencyKey ? saved.items : previous.items,
    }))
    loadLocal().then(
      (items) => {
        if (!live) return
        completedAttempt.current = attempt
        if (items.length > maxItems) {
          setResult((previous) => ({
            status: "overflow",
            items: previous.items,
          }))
          return
        }
        cache.set(cacheKey, { items, revision, dependencyKey })
        setResult({ status: "ready", items, hasMore: false })
      },
      () => {
        if (live) {
          completedAttempt.current = attempt
          setResult((previous) => ({ status: "error", items: previous.items }))
        }
      },
    )
    return () => {
      live = false
    }
  }, [
    maxItems,
    cache,
    visibleDependency,
    unavailable,
    cacheKey,
    dependencyKey,
    revision,
    retry,
  ])
  const clearUnmatched = useEffectEvent(() => onUnmatchedChange(false))
  useEffect(() => () => clearUnmatched(), [])
  useEffect(() => {
    if (!open) return
    // Modal dismiss layers listen on document before React's input handler.
    // Consume Escape first, only while this input owns an open suggestion list.
    const closeSuggestions = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.target !== inputRef.current) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener("keydown", closeSuggestions, true)
    return () => window.removeEventListener("keydown", closeSuggestions, true)
  }, [open])
  const listId = `${control.name}-choices`
  const errorId = `${control.name}-error`
  const selectable =
    (maxItems !== undefined || result.status === "ready") && !unavailable
  const items =
    maxItems === undefined
      ? result.items
      : searchLookupItems(result.items, localFilter, result.items.length)
  const errors = control.state.meta.errors.map((error) =>
    typeof error === "string" ? { message: error } : error,
  )
  const invalid =
    errors.length > 0 &&
    (control.state.meta.isTouched || form.state.submissionAttempts > 0)

  const search = (filter: string, immediate: boolean) => {
    if (maxItems !== undefined) {
      setLocalFilter(filter)
      setActive(-1)
      setOpen(true)
      return
    }
    generation.current += 1
    setRequest({ filter, immediate, version: generation.current })
    setResult((previous) => ({ status: "loading", items: previous.items }))
    setActive(-1)
    setOpen(true)
  }

  const searchServer = useEffectEvent((filter: string) => {
    if (binding?.dependencies.length)
      return service
        .fetchDependentSuggestions(binding.queryName, {
          input: {
            filter,
            ...Object.fromEntries(
              binding.dependencies.map((name) => [name, values[name]]),
            ),
          },
          limit: 21,
        })
        .then((items) => ({
          items: items.slice(0, 20),
          hasMore: items.length > 20,
        }))
    return service.search
      ? service.search(stepPath, field, filter, 20, options)
      : Promise.reject(new Error("Server lookup is unavailable"))
  })
  useEffect(() => {
    if (!request || unavailable) return
    let live = true
    const timer = setTimeout(
      () => {
        const run = searchServer(request.filter)
        run.then(
          (response) => {
            if (live && generation.current === request.version)
              setResult({ status: "ready", ...response })
          },
          () => {
            if (live && generation.current === request.version)
              setResult((previous) => ({
                status: "error",
                items: previous.items,
              }))
          },
        )
      },
      request.immediate ? 0 : 250,
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [request, unavailable])

  const select = (item: LookupSuggestion) => {
    if (!selectable) return
    resolutionGeneration.current += 1
    selected.current = item.value
    setResolution("idle")
    onUnmatchedChange(false)
    setText(item.label)
    control.handleChange(item.value)
    setOpen(false)
  }

  return (
    <Field>
      <FieldLabel htmlFor={control.name}>{label}</FieldLabel>
      <Popover open={open && !unavailable} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <div className="relative">
            <Input
              ref={inputRef}
              className="pr-10"
              id={control.name}
              name={control.name}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open && !unavailable}
              aria-controls={open && !unavailable ? listId : undefined}
              aria-activedescendant={
                open && selectable && active >= 0
                  ? `${listId}-${active}`
                  : undefined
              }
              aria-invalid={invalid}
              aria-describedby={invalid ? errorId : undefined}
              disabled={unavailable}
              value={text}
              placeholder={
                resolution === "loading"
                  ? "Loading selection…"
                  : resolution === "unavailable"
                    ? "Selection unavailable"
                    : undefined
              }
              onFocus={() => search("", true)}
              onChange={(event) => {
                const value = event.target.value
                resolutionGeneration.current += 1
                selected.current = null
                setResolution("idle")
                onUnmatchedChange(value.length > 0)
                setText(value)
                control.handleChange(emptyValue)
                search(value, false)
              }}
              onBlur={() => {
                setOpen(false)
                control.handleBlur()
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  if (open) {
                    event.preventDefault()
                    event.stopPropagation()
                  }
                  setOpen(false)
                } else if (event.key === "Tab") setOpen(false)
                else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault()
                  if (!open) search(text, true)
                  else if (selectable)
                    setActive((index) =>
                      event.key === "ArrowDown"
                        ? Math.min(index + 1, items.length - 1)
                        : Math.max(index - 1, 0),
                    )
                } else if (event.key === "Enter" && open) {
                  event.preventDefault()
                  const item = items[active < 0 ? 0 : active]
                  if (item) select(item)
                }
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground absolute top-0 right-0 size-9"
              disabled={unavailable}
              aria-label={`Clear ${label}`}
              onClick={() => {
                resolutionGeneration.current += 1
                selected.current = null
                setResolution("idle")
                onUnmatchedChange(false)
                setText("")
                control.handleChange(emptyValue)
                control.handleBlur()
                setOpen(false)
              }}
            >
              <span aria-hidden="true" className="text-xl leading-none">
                ×
              </span>
            </Button>
          </div>
        </PopoverAnchor>
        {resolution !== "idle" && (
          <div role="status">
            {resolution === "loading"
              ? "Loading selection…"
              : "Selection unavailable"}
          </div>
        )}
        {(result.status === "error" || result.status === "overflow") &&
          !unavailable && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                inputRef.current?.focus()
                if (maxItems !== undefined) {
                  const saved = cache?.get(cacheKey)
                  if (saved) saved.revision = -1
                  setRetry((value) => value + 1)
                  search(text, true)
                } else search(request?.filter ?? "", true)
              }}
            >
              Retry
            </Button>
          )}
        {open && !unavailable && (
          <PopoverContent
            role="presentation"
            className="max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] overflow-y-auto p-1"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => {
              if (event.target === inputRef.current) event.preventDefault()
            }}
          >
            <div role="status" className="text-muted-foreground px-2 text-sm">
              {result.status === "overflow"
                ? "Choices couldn't be loaded. Please contact the form owner."
                : result.status === "loading" || result.status === "idle"
                  ? "Loading results…"
                  : result.status === "error"
                    ? "Couldn't load choices"
                    : result.status === "ready" && items.length === 0
                      ? "No matches"
                      : result.status === "ready" && result.hasMore
                        ? "More matches—keep typing"
                        : ""}
            </div>
            <div
              id={listId}
              role="listbox"
              aria-label={label}
              aria-busy={result.status === "loading"}
              className="max-h-[240px] overflow-y-auto"
            >
              {items.map((item, index) => (
                <button
                  key={item.value}
                  id={`${listId}-${index}`}
                  ref={(element) => {
                    if (index === active)
                      element?.scrollIntoView({ block: "nearest" })
                  }}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={control.state.value === item.value}
                  disabled={!selectable}
                  className={`w-full rounded-sm px-2 py-1.5 text-left text-sm disabled:opacity-50 ${active === index ? "bg-accent text-accent-foreground" : ""}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => select(item)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </PopoverContent>
        )}
      </Popover>
      {invalid && <FieldError id={errorId} errors={errors} />}
    </Field>
  )
}
