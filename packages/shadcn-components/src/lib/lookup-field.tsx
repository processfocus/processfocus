"use client"

import type { StandardSchemaV1Issue } from "@tanstack/react-form"
import { Check, ChevronsUpDown } from "lucide-react"
import { useCallback, useRef, useState } from "react"
import { useFieldContext, useFormContext } from "./form-context"
import { Button } from "./ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command"
import { Field, FieldDescription, FieldError, FieldLabel } from "./ui/field"
import { Input } from "./ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"
import { cn } from "./utils/utils"

export interface LookupFieldItem {
  readonly value: string
  readonly label: string
}

export function LookupField({
  label,
  descriptionHtml,
  items,
  onSearch,
  loading,
  error,
  readOnly,
  autoFocus,
  allowFreeText,
}: {
  label: string
  descriptionHtml?: string | undefined | null
  items: LookupFieldItem[]
  onSearch: (filter: string) => void
  loading: boolean
  error?: string | undefined
  readOnly?: boolean | undefined
  autoFocus?: boolean | undefined
  allowFreeText?: boolean | undefined
}) {
  if (allowFreeText) {
    return (
      <SuggestionLookupField
        label={label}
        descriptionHtml={descriptionHtml}
        items={items}
        onSearch={onSearch}
        loading={loading}
        error={error}
        readOnly={readOnly}
        autoFocus={autoFocus}
      />
    )
  }

  return (
    <SelectLookupField
      label={label}
      descriptionHtml={descriptionHtml}
      items={items}
      onSearch={onSearch}
      loading={loading}
      error={error}
      readOnly={readOnly}
      autoFocus={autoFocus}
    />
  )
}

function useLookupFieldState() {
  const field = useFieldContext<string>()
  const form = useFormContext()
  const validationErrors = field.state.meta
    .errors as unknown as StandardSchemaV1Issue[]
  const serverError = field.state.meta.errorMap?.onSubmit
  const allErrors: Array<{ message?: string }> = [
    ...validationErrors,
    ...(serverError ? [{ message: serverError as string }] : []),
  ]
  const { isTouched, isDefaultValue } = field.state.meta
  const afterSubmission = form.state.submissionAttempts > 0
  const isInvalid =
    (afterSubmission && allErrors.length > 0) ||
    (isTouched && !isDefaultValue && allErrors.length > 0)

  return {
    field,
    isInvalid,
    allErrors,
    errorId: `${field.name}-error`,
  }
}

function SelectLookupField({
  label,
  descriptionHtml,
  items,
  onSearch,
  loading,
  error,
  readOnly,
  autoFocus,
}: {
  label: string
  descriptionHtml?: string | undefined | null
  items: LookupFieldItem[]
  onSearch: (filter: string) => void
  loading: boolean
  error?: string | undefined
  readOnly?: boolean | undefined
  autoFocus?: boolean | undefined
}) {
  const { field, isInvalid, allErrors, errorId } = useLookupFieldState()
  const [open, setOpen] = useState(false)

  const selectedItem = items.find((item) => item.value === field.state.value)
  const displayLabel =
    selectedItem?.label || (field.state.value ? field.state.value : undefined)

  return (
    <Field>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Popover modal open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-invalid={isInvalid}
            aria-describedby={isInvalid ? errorId : undefined}
            className={cn(
              "w-full justify-between font-normal",
              !displayLabel && "text-muted-foreground",
            )}
            disabled={readOnly}
            autoFocus={autoFocus}
          >
            {displayLabel ?? `Select ${label.toLowerCase()}...`}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent>
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={`Search ${label.toLowerCase()}...`}
              onValueChange={(value) => {
                onSearch(value)
              }}
            />
            <CommandList className="max-h-[240px]">
              <CommandEmpty>
                {error
                  ? "Failed to load suggestions. Please try again."
                  : loading
                    ? "Searching..."
                    : "No results found."}
              </CommandEmpty>
              <CommandGroup>
                {items.map((item) => (
                  <CommandItem
                    key={item.value}
                    value={item.value}
                    onSelect={() => {
                      field.handleChange(
                        item.value === field.state.value ? "" : item.value,
                      )
                      setOpen(false)
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        field.state.value === item.value
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                    {item.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {isInvalid && allErrors.length > 0 && (
        <FieldError errors={allErrors} id={errorId} />
      )}
      {descriptionHtml && <FieldDescription trustedHtml={descriptionHtml} />}
    </Field>
  )
}

function SuggestionLookupField({
  label,
  descriptionHtml,
  items,
  onSearch,
  loading,
  error,
  readOnly,
  autoFocus,
}: {
  label: string
  descriptionHtml?: string | undefined | null
  items: LookupFieldItem[]
  onSearch: (filter: string) => void
  loading: boolean
  error?: string | undefined
  readOnly?: boolean | undefined
  autoFocus?: boolean | undefined
}) {
  const { field, isInvalid, allErrors, errorId } = useLookupFieldState()
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const activeOptionRef = useRef<HTMLButtonElement | null>(null)
  const listboxId = `${field.name}-suggestions`
  const clampedActiveIndex = Math.min(
    activeIndex,
    Math.max(0, items.length - 1),
  )
  // Free-text fields should not show an empty popup on focus before the user
  // types; once there is text, the empty state confirms there are no matches.
  const showSuggestions =
    open &&
    !readOnly &&
    (items.length > 0 ||
      loading ||
      error !== undefined ||
      Boolean(field.state.value))
  const activeDescendantId =
    showSuggestions && items[clampedActiveIndex]
      ? `${listboxId}-${clampedActiveIndex}`
      : undefined

  const setActiveOptionRef = useCallback(
    (element: HTMLButtonElement | null) => {
      activeOptionRef.current = element
      element?.scrollIntoView({ block: "nearest" })
    },
    [],
  )

  const closeSuggestions = () => {
    setOpen(false)
    setActiveIndex(0)
  }

  const selectItem = (item: LookupFieldItem) => {
    field.handleChange(item.value)
    closeSuggestions()
  }

  return (
    <Field>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <div
        className="relative"
        onBlurCapture={(event) => {
          if (event.currentTarget.contains(event.relatedTarget)) return
          closeSuggestions()
        }}
      >
        <Input
          id={field.name}
          name={field.name}
          value={field.state.value ?? ""}
          onChange={(event) => {
            const value = event.target.value
            field.handleChange(value)
            onSearch(value)
            setActiveIndex(0)
            setOpen(true)
          }}
          onFocus={() => {
            if (readOnly) return
            setActiveIndex(0)
            onSearch(field.state.value ?? "")
            setOpen(true)
          }}
          onBlur={() => field.handleBlur()}
          onKeyDown={(event) => {
            if (readOnly) return

            if (
              !open &&
              (event.key === "ArrowDown" || event.key === "ArrowUp")
            ) {
              setActiveIndex(0)
              onSearch(field.state.value ?? "")
              setOpen(true)
              return
            }

            if (event.key === "ArrowDown") {
              event.preventDefault()
              setActiveIndex((index) =>
                items.length === 0 ? 0 : Math.min(index + 1, items.length - 1),
              )
              return
            }

            if (event.key === "ArrowUp") {
              event.preventDefault()
              setActiveIndex((index) => Math.max(index - 1, 0))
              return
            }

            if (event.key === "Enter" && open && items[clampedActiveIndex]) {
              event.preventDefault()
              selectItem(items[clampedActiveIndex])
              return
            }

            if (event.key === "Escape") {
              closeSuggestions()
              return
            }

            if (event.key === "Tab") {
              closeSuggestions()
            }
          }}
          placeholder={`Enter ${label.toLowerCase()}...`}
          autoFocus={autoFocus}
          readOnly={readOnly}
          role="combobox"
          aria-autocomplete="list"
          aria-activedescendant={activeDescendantId}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={showSuggestions ? listboxId : undefined}
          aria-invalid={isInvalid}
          aria-describedby={isInvalid ? errorId : undefined}
        />
        {showSuggestions && (
          <div
            id={listboxId}
            role="listbox"
            aria-label={label}
            className="bg-popover text-popover-foreground absolute z-50 mt-1 max-h-[240px] w-full overflow-y-auto rounded-md border p-1 shadow-md"
          >
            {error ? (
              <div className="text-muted-foreground px-2 py-3 text-sm">
                Failed to load suggestions. Please try again.
              </div>
            ) : loading ? (
              <div className="text-muted-foreground px-2 py-3 text-sm">
                Searching...
              </div>
            ) : items.length === 0 ? (
              <div className="text-muted-foreground px-2 py-3 text-sm">
                No suggestions found.
              </div>
            ) : (
              items.map((item, index) => (
                <button
                  key={item.value}
                  id={`${listboxId}-${index}`}
                  ref={index === clampedActiveIndex ? setActiveOptionRef : null}
                  type="button"
                  role="option"
                  aria-selected={index === clampedActiveIndex}
                  tabIndex={-1}
                  className={cn(
                    "relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none",
                    index === clampedActiveIndex &&
                      "bg-accent text-accent-foreground",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => selectItem(item)}
                >
                  {item.label}
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {isInvalid && allErrors.length > 0 && (
        <FieldError errors={allErrors} id={errorId} />
      )}
      {descriptionHtml && <FieldDescription trustedHtml={descriptionHtml} />}
    </Field>
  )
}
