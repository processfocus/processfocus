;(() => {
  const currentScript = document.currentScript

  if (
    window.ProcessFocusEmbed &&
    typeof window.ProcessFocusEmbed.__bootstrapFromScript === "function"
  ) {
    window.ProcessFocusEmbed.__bootstrapFromScript(currentScript)
    return
  }

  const EMBED_EVENT_SOURCE = "processfocus-embed"
  const EMBED_HOST_REQUEST_SOURCE = "processfocus-embed-host"
  const EMBED_HOST_REQUEST_VERSION = 1
  const initializedIframes = new WeakSet()
  const loadingStates = new WeakMap()
  let autoEmbedCount = 0
  const helperOrigin = (() => {
    if (!(currentScript instanceof HTMLScriptElement) || !currentScript.src) {
      return null
    }

    try {
      return new URL(currentScript.src, window.location.href).origin
    } catch {
      return null
    }
  })()

  const getScriptUrl = (script) => {
    if (!(script instanceof HTMLScriptElement) || !script.src) {
      return null
    }

    try {
      return new URL(script.src, window.location.href)
    } catch {
      return null
    }
  }

  const toIframe = (value) => {
    if (value instanceof HTMLIFrameElement) {
      return value
    }

    if (typeof value === "string") {
      const element = document.querySelector(value)
      return element instanceof HTMLIFrameElement ? element : null
    }

    return null
  }

  const toContainer = (value, fallback) => {
    if (value instanceof Element) {
      return value
    }

    if (typeof value === "string") {
      const element = document.querySelector(value)
      return element instanceof Element ? element : (fallback ?? null)
    }

    return fallback ?? null
  }

  const toPositiveNumber = (value, fallback) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }

  const normalizeFormPath = (value) => {
    if (typeof value !== "string") {
      return null
    }

    const trimmed = value.trim()
    if (!trimmed) {
      return null
    }

    if (/^https?:\/\//.test(trimmed)) {
      try {
        return normalizeFormPath(new URL(trimmed).pathname)
      } catch {
        return null
      }
    }

    const path = trimmed
      .split(/[?#]/, 1)[0]
      .replace(/^\/+/, "/")
      .replace(/^\/?embed(?:\/|$)/, "/")

    if (!path) {
      return null
    }

    const segments = path
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => {
        try {
          return decodeURIComponent(segment)
        } catch {
          return segment
        }
      })

    return segments.length > 0 ? `/${segments.join("/")}` : null
  }

  const encodeFormPath = (formPath) =>
    formPath
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => encodeURIComponent(segment))
      .join("/")

  const normalizeMode = (value) =>
    value === "light" || value === "dark" ? value : null

  const normalizeAlign = (value) =>
    value === "left" || value === "center" ? value : null

  const buildEmbedUrl = (form, explicitOrigin, options) => {
    const formPath = normalizeFormPath(form)
    const origin =
      typeof explicitOrigin === "string" && explicitOrigin.length > 0
        ? explicitOrigin
        : helperOrigin

    if (!formPath || !origin) {
      return null
    }

    const url = new URL(`/embed/${encodeFormPath(formPath)}`, origin)
    const mode = normalizeMode(options?.mode)
    const align = normalizeAlign(options?.align)

    if (mode) {
      url.searchParams.set("mode", mode)
    }

    if (align) {
      url.searchParams.set("align", align)
    }

    return url.toString()
  }

  const createAutoEmbedId = () => {
    autoEmbedCount += 1
    return `processfocus-embed-${autoEmbedCount}`
  }

  const applyDefaultIframeStyles = (iframe, minHeight) => {
    iframe.style.width = "100%"
    iframe.style.minHeight = `${minHeight}px`
    iframe.style.height = `${minHeight}px`
    iframe.style.border = "0"
    iframe.style.display = "block"
    iframe.style.background = "transparent"
  }

  const createLoadingPlaceholder = (loadingText) => {
    const placeholder = document.createElement("div")

    placeholder.classList.add("processfocus-embed-loading")
    placeholder.setAttribute("data-processfocus-embed-loading", "")
    placeholder.setAttribute("aria-live", "polite")
    placeholder.style.position = "absolute"
    placeholder.style.inset = "0"
    placeholder.style.display = "flex"
    placeholder.style.alignItems = "center"
    placeholder.style.justifyContent = "center"
    placeholder.style.padding = "1.5rem"
    placeholder.style.textAlign = "center"
    placeholder.style.color = "#475569"
    placeholder.style.font = "inherit"
    placeholder.style.pointerEvents = "none"
    placeholder.textContent = loadingText

    return placeholder
  }

  const createAutoEmbedShell = (iframe, minHeight, loadingText) => {
    const shell = document.createElement("div")
    const placeholder = createLoadingPlaceholder(loadingText)

    shell.classList.add("processfocus-embed-shell")
    shell.setAttribute("data-processfocus-embed-shell", "")
    shell.style.position = "relative"
    shell.style.width = "100%"
    shell.style.minHeight = `${minHeight}px`

    shell.appendChild(placeholder)
    shell.appendChild(iframe)

    loadingStates.set(iframe, { placeholder })

    return shell
  }

  const setLoadingState = (iframe, isLoading) => {
    const loadingState = loadingStates.get(iframe)
    if (!loadingState) {
      return
    }

    loadingState.placeholder.style.display = isLoading ? "flex" : "none"
    iframe.style.visibility = isLoading ? "hidden" : "visible"
    iframe.style.pointerEvents = isLoading ? "none" : "auto"
  }

  const insertAutoNode = (node, script, container) => {
    const target = toContainer(container, script?.parentElement ?? null)

    if (
      script instanceof HTMLScriptElement &&
      target instanceof Element &&
      target.tagName !== "HEAD" &&
      script.parentElement === target
    ) {
      target.insertBefore(node, script)
      return
    }

    if (target instanceof Element && target.tagName !== "HEAD") {
      target.appendChild(node)
      return
    }

    const appendToBody = () => {
      if (document.body) {
        document.body.appendChild(node)
        return
      }

      document.documentElement.appendChild(node)
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", appendToBody, {
        once: true,
      })
      return
    }

    appendToBody()
  }

  const getIframeOrigin = (iframe, explicitOrigin) => {
    if (typeof explicitOrigin === "string" && explicitOrigin.length > 0) {
      return explicitOrigin
    }

    const src = iframe.getAttribute("src")
    if (!src) {
      return null
    }

    try {
      return new URL(src, window.location.href).origin
    } catch {
      return null
    }
  }

  const loadForm = (options) => {
    const script =
      options?.script instanceof HTMLScriptElement ? options.script : null
    const scriptUrl = getScriptUrl(script)
    const origin = options?.origin || scriptUrl?.origin || helperOrigin
    const formPath = normalizeFormPath(options?.form)
    const mode =
      normalizeMode(options?.mode) ||
      normalizeMode(script?.dataset.processfocusMode)
    const align =
      normalizeAlign(options?.align) ||
      normalizeAlign(script?.dataset.processfocusAlign)

    if (!origin || !formPath) {
      return null
    }

    const src = buildEmbedUrl(formPath, origin, { align, mode })
    if (!src) {
      return null
    }

    const minHeight = toPositiveNumber(
      options?.minHeight,
      toPositiveNumber(
        script?.dataset.processfocusEmbedMinHeight ||
          script?.dataset.processfocusMinHeight,
        320,
      ),
    )
    const iframeId =
      typeof options?.id === "string" && options.id.length > 0
        ? options.id
        : createAutoEmbedId()
    const title =
      typeof options?.title === "string" && options.title.length > 0
        ? options.title
        : script?.dataset.processfocusTitle || "Process Focus Form"
    const loadingText =
      typeof options?.loadingText === "string" && options.loadingText.length > 0
        ? options.loadingText
        : script?.dataset.processfocusLoadingText || "Loading form..."
    const iframe = document.createElement("iframe")

    iframe.id = iframeId
    iframe.title = title
    iframe.src = src
    iframe.classList.add("processfocus-embed-frame")
    iframe.setAttribute("data-processfocus-embed", "")
    iframe.dataset.processfocusForm = formPath
    iframe.dataset.processfocusEmbedId = iframeId
    iframe.dataset.processfocusEmbedMinHeight = String(minHeight)

    applyDefaultIframeStyles(iframe, minHeight)

    const shell = createAutoEmbedShell(iframe, minHeight, loadingText)

    setLoadingState(iframe, true)
    insertAutoNode(shell, script, options?.container)
    init({ iframe, origin, minHeight })

    return iframe
  }

  const bootstrapFromScript = (script) => {
    const scriptUrl = getScriptUrl(script)
    if (!scriptUrl) {
      return null
    }

    const form = scriptUrl.searchParams.get("form")
    if (!form) {
      return null
    }

    return loadForm({
      form,
      id: scriptUrl.searchParams.get("id") ?? undefined,
      align: scriptUrl.searchParams.get("align") ?? undefined,
      loadingText: scriptUrl.searchParams.get("loadingText") ?? undefined,
      minHeight: scriptUrl.searchParams.get("minHeight") ?? undefined,
      mode: scriptUrl.searchParams.get("mode") ?? undefined,
      origin: scriptUrl.origin,
      script,
      title: scriptUrl.searchParams.get("title") ?? undefined,
    })
  }

  const isProcessFocusEmbedIframe = (iframe) => {
    if (iframe.hasAttribute("data-processfocus-embed")) {
      return true
    }

    const src = iframe.getAttribute("src")
    if (!src || !helperOrigin) {
      return false
    }

    try {
      const url = new URL(src, window.location.href)
      return url.origin === helperOrigin && url.pathname.startsWith("/embed/")
    } catch {
      return false
    }
  }

  const dispatchEmbedEvent = (data) => {
    window.dispatchEvent(
      new CustomEvent("processfocus-embed", {
        detail: data,
      }),
    )
  }

  const requestResize = (iframe, expectedOrigin) => {
    if (!iframe.contentWindow) {
      return
    }

    iframe.contentWindow.postMessage(
      {
        source: EMBED_HOST_REQUEST_SOURCE,
        version: EMBED_HOST_REQUEST_VERSION,
        event: "request-resize",
      },
      expectedOrigin,
    )
  }

  const scrollEmbedIntoView = (iframe) => {
    const target = iframe.closest("[data-processfocus-embed-shell]") || iframe

    if (typeof target.scrollIntoView !== "function") {
      return
    }

    target.scrollIntoView({ block: "start", inline: "nearest" })
  }

  const init = (options) => {
    const iframe = toIframe(options?.iframe)
    if (!iframe || initializedIframes.has(iframe)) {
      return null
    }

    const expectedOrigin = getIframeOrigin(iframe, options?.origin)
    if (!expectedOrigin) {
      return null
    }

    const minHeight = toPositiveNumber(
      options?.minHeight,
      toPositiveNumber(iframe.dataset.processfocusEmbedMinHeight, 320),
    )
    let initialResizeResolved = false
    let initialResizeIntervalId = null
    let initialResizeTimeoutId = null
    let revealFallbackTimeoutId = null

    const clearRevealFallback = () => {
      if (revealFallbackTimeoutId !== null) {
        window.clearTimeout(revealFallbackTimeoutId)
        revealFallbackTimeoutId = null
      }
    }

    const stopInitialResizePolling = () => {
      if (initialResizeIntervalId !== null) {
        window.clearInterval(initialResizeIntervalId)
        initialResizeIntervalId = null
      }

      if (initialResizeTimeoutId !== null) {
        window.clearTimeout(initialResizeTimeoutId)
        initialResizeTimeoutId = null
      }
    }

    const startInitialResizePolling = () => {
      stopInitialResizePolling()
      requestResize(iframe, expectedOrigin)

      initialResizeIntervalId = window.setInterval(() => {
        if (initialResizeResolved) {
          stopInitialResizePolling()
          return
        }

        requestResize(iframe, expectedOrigin)
      }, 120)

      initialResizeTimeoutId = window.setTimeout(() => {
        stopInitialResizePolling()
      }, 5000)
    }

    const scheduleRevealFallback = () => {
      clearRevealFallback()

      revealFallbackTimeoutId = window.setTimeout(() => {
        if (!initialResizeResolved) {
          setLoadingState(iframe, false)
        }
      }, 400)
    }

    const listener = (event) => {
      if (event.origin !== expectedOrigin) {
        return
      }

      if (iframe.contentWindow && event.source !== iframe.contentWindow) {
        return
      }

      const data = event.data
      if (!data || data.source !== EMBED_EVENT_SOURCE) {
        return
      }

      dispatchEmbedEvent(data)

      if (data.event === "submitted") {
        scrollEmbedIntoView(iframe)
      }

      if (
        (data.event === "ready" || data.event === "resize") &&
        typeof data.height === "number"
      ) {
        initialResizeResolved = true
        stopInitialResizePolling()
        clearRevealFallback()
        setLoadingState(iframe, false)
        iframe.style.height = `${Math.max(minHeight, Math.ceil(data.height))}px`
      }
    }

    const handleLoad = () => {
      initialResizeResolved = false
      setLoadingState(iframe, true)
      startInitialResizePolling()
      scheduleRevealFallback()
    }

    initializedIframes.add(iframe)
    window.addEventListener("message", listener)
    iframe.addEventListener("load", handleLoad)

    return function cleanup() {
      window.removeEventListener("message", listener)
      iframe.removeEventListener("load", handleLoad)
      stopInitialResizePolling()
      clearRevealFallback()
      loadingStates.delete(iframe)
      initializedIframes.delete(iframe)
    }
  }

  const initAll = (root) => {
    const scope = root || document
    return Array.from(scope.querySelectorAll("iframe"))
      .filter((iframe) => isProcessFocusEmbedIframe(iframe))
      .map((iframe) => init({ iframe }))
  }

  window.ProcessFocusEmbed = {
    init,
    initAll,
    loadForm,
    __bootstrapFromScript: bootstrapFromScript,
  }

  initAll()
  bootstrapFromScript(currentScript)

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function onReady() {
      document.removeEventListener("DOMContentLoaded", onReady)
      initAll()
    })
  }
})()
