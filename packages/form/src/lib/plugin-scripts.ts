// Global map of in-flight script loads keyed by src URL.
// Ensures concurrent renders share a single load promise per script.
const scriptLoadPromises = new Map<string, Promise<void>>()

export function loadScript(src: string, async: boolean): Promise<void> {
  const existing = scriptLoadPromises.get(src)
  if (existing) return existing

  const promise = new Promise<void>((resolve, reject) => {
    // Script may already be in the DOM from a previous page load
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve()
      return
    }

    const el = document.createElement("script")
    el.src = src
    el.async = async
    el.onload = () => resolve()
    el.onerror = () => reject(new Error(`Failed to load script: ${src}`))
    document.head.appendChild(el)
  })

  scriptLoadPromises.set(src, promise)
  return promise
}
