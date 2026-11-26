const firstEditableControlSelector = [
  'input:not([type="hidden"]):not([disabled]):not([readonly])',
  "textarea:not([disabled]):not([readonly])",
  "select:not([disabled])",
  'button[role="combobox"]:not([disabled])',
  "button[data-calendar-slot-day]:not([disabled])",
].join(",")

export const focusFirstEditableControl = (formElement: HTMLFormElement) => {
  if (formElement.dataset["autofocus"] === "false") return undefined
  if (formElement.contains(document.activeElement)) return undefined

  let timerId: number | undefined
  const frameId = requestAnimationFrame(() => {
    timerId = window.setTimeout(() => {
      if (formElement.contains(document.activeElement)) return

      const control = formElement.querySelector<HTMLElement>(
        firstEditableControlSelector,
      )
      control?.focus()
    }, 0)
  })

  return () => {
    cancelAnimationFrame(frameId)
    if (timerId !== undefined) {
      window.clearTimeout(timerId)
    }
  }
}
