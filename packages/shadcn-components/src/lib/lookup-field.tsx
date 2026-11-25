"use client"

import { useEffect, useEffectEvent, useRef, useState } from "react"
import { useFieldContext, useFormContext } from "./form-context"
import { Button } from "./ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "./ui/field"
import { Input } from "./ui/input"
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover"
import { cn } from "./utils/utils"

export interface LookupFieldItem {
  readonly value: string
  readonly label: string
}

/** Editable lookup for the suggestions API; text is never a selected identity. */
export function LookupField(props: {
  label: string
  descriptionHtml?: string | undefined | null
  items: LookupFieldItem[]
  onSearch: (filter: string) => void
  loading: boolean
  error?: string | undefined
  readOnly?: boolean | undefined
  autoFocus?: boolean | undefined
  allowFreeText?: boolean | undefined
  emptyValue?: "" | null | undefined
  onUnmatchedChange?: ((unmatched: boolean) => void) | undefined
}) {
  const {
    label,
    descriptionHtml,
    items,
    onSearch,
    loading,
    error,
    readOnly,
    autoFocus,
    allowFreeText = false,
    onUnmatchedChange,
  } = props
  // Omitted preserves the public API default; explicit undefined clears optional fields.
  const emptyValue = "emptyValue" in props ? props.emptyValue : ""
  const field = useFieldContext<string | null | undefined>()
  const form = useFormContext()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [editing, setEditing] = useState<string | null>(null)
  const [remembered, setRemembered] = useState<LookupFieldItem>()
  const [previousValue, setPreviousValue] = useState(field.state.value)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedItem = items.find((item) => item.value === field.state.value)
  if (selectedItem && selectedItem !== remembered) setRemembered(selectedItem)
  if (previousValue !== field.state.value) {
    setPreviousValue(field.state.value)
    setEditing(null)
  }
  if (readOnly && open) setOpen(false)
  const text = allowFreeText
    ? (field.state.value ?? "")
    : (editing ??
      selectedItem?.label ??
      (remembered?.value === field.state.value
        ? remembered?.label
        : undefined) ??
      field.state.value ??
      "")
  const errors = field.state.meta.errors.map((issue) =>
    typeof issue === "string" ? { message: issue } : issue,
  )
  const invalid =
    errors.length > 0 &&
    (field.state.meta.isTouched || form.state.submissionAttempts > 0)
  const listId = `${field.name}-choices`
  const errorId = `${field.name}-error`
  const expanded = open && !readOnly
  const selectable = !loading && !error && !readOnly
  const activeIndex = Math.min(active, items.length - 1)
  const clearUnmatched = useEffectEvent(() => onUnmatchedChange?.(false))
  useEffect(() => () => clearUnmatched(), [])
  useEffect(() => {
    if (!expanded) return
    // Close suggestions before an enclosing modal's document dismiss handler.
    const closeSuggestions = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.target !== inputRef.current) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener("keydown", closeSuggestions, true)
    return () => window.removeEventListener("keydown", closeSuggestions, true)
  }, [expanded])
  const search = (filter: string) => {
    onSearch(filter)
    setActive(-1)
    setOpen(true)
  }
  const change = (value: string | null | undefined) => {
    setPreviousValue(value)
    field.handleChange(value)
  }
  const select = (item: LookupFieldItem) => {
    if (!selectable) return
    setRemembered(item)
    setEditing(null)
    onUnmatchedChange?.(false)
    change(item.value)
    setOpen(false)
  }
  return (
    <Field>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Popover open={expanded} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <div className="relative">
            <Input
              ref={inputRef}
              id={field.name}
              name={field.name}
              className="pr-10"
              value={text}
              onChange={(event) => {
                const value = event.target.value
                setEditing(value)
                onUnmatchedChange?.(!allowFreeText && value.length > 0)
                change(allowFreeText ? value : emptyValue)
                search(value)
              }}
              onFocus={() => search(allowFreeText ? text : "")}
              onClick={() => {
                if (!open) search(allowFreeText ? text : "")
              }}
              onBlur={() => {
                setOpen(false)
                field.handleBlur()
              }}
              onKeyDown={(event) => {
                if (event.key === "Tab") setOpen(false)
                else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault()
                  if (!open) search(allowFreeText ? text : "")
                  else if (selectable)
                    setActive((index) =>
                      event.key === "ArrowDown"
                        ? Math.min(index + 1, items.length - 1)
                        : Math.max(index - 1, 0),
                    )
                } else if (event.key === "Enter" && open) {
                  const item = items[activeIndex < 0 ? 0 : activeIndex]
                  if (allowFreeText && (!selectable || !item)) return
                  event.preventDefault()
                  if (item) select(item)
                }
              }}
              placeholder={`${allowFreeText ? "Enter" : "Search"} ${label.toLowerCase()}...`}
              autoFocus={autoFocus}
              disabled={readOnly}
              role="combobox"
              aria-autocomplete="list"
              aria-activedescendant={
                expanded && selectable && activeIndex >= 0
                  ? `${listId}-${activeIndex}`
                  : undefined
              }
              aria-expanded={expanded}
              aria-haspopup="listbox"
              aria-controls={expanded ? listId : undefined}
              aria-invalid={invalid}
              aria-describedby={invalid ? errorId : undefined}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground absolute top-0 right-0 size-9"
              disabled={readOnly}
              aria-label={`Clear ${label}`}
              onClick={() => {
                setEditing(null)
                setRemembered(undefined)
                onUnmatchedChange?.(false)
                change(emptyValue)
                field.handleBlur()
                setOpen(false)
              }}
            >
              <span aria-hidden="true" className="text-xl leading-none">
                ×
              </span>
            </Button>
          </div>
        </PopoverAnchor>
        {expanded && (
          <PopoverContent
            role="presentation"
            className="max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] overflow-y-auto p-1"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => {
              if (event.target === inputRef.current) event.preventDefault()
            }}
          >
            <div
              id={listId}
              role="listbox"
              aria-label={label}
              aria-busy={loading}
              className="max-h-[240px] overflow-y-auto"
            >
              {loading ? (
                <div
                  role="status"
                  className="text-muted-foreground px-2 py-3 text-sm"
                >
                  Loading results…
                </div>
              ) : error ? (
                <div
                  role="alert"
                  className="text-muted-foreground px-2 py-3 text-sm"
                >
                  Failed to load suggestions. Please try again.
                </div>
              ) : items.length === 0 ? (
                <div
                  role="status"
                  className="text-muted-foreground px-2 py-3 text-sm"
                >
                  {allowFreeText
                    ? "No suggestions found."
                    : "No results found."}
                </div>
              ) : (
                items.map((item, index) => (
                  <button
                    key={item.value}
                    id={`${listId}-${index}`}
                    ref={(element) => {
                      if (index === activeIndex)
                        element?.scrollIntoView({ block: "nearest" })
                    }}
                    type="button"
                    role="option"
                    aria-selected={field.state.value === item.value}
                    tabIndex={-1}
                    className={cn(
                      "relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none",
                      index === activeIndex &&
                        "bg-accent text-accent-foreground",
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => select(item)}
                  >
                    {item.label}
                  </button>
                ))
              )}
            </div>
          </PopoverContent>
        )}
      </Popover>
      {error && !readOnly && (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            inputRef.current?.focus()
            search(editing ?? (allowFreeText ? text : ""))
          }}
        >
          Retry
        </Button>
      )}
      {invalid && <FieldError errors={errors} id={errorId} />}
      {descriptionHtml && <FieldDescription trustedHtml={descriptionHtml} />}
    </Field>
  )
}
