import { getEmbedManifestEntries } from "@/lib/embed-manifest-store"

const PREFERRED_EMBED_STEP_PATH = "/operations/calculator-demo/Enter numbers"

export const buildEmbedScriptSrc = ({
  align,
  form,
  minHeight,
  mode,
  title,
}: {
  readonly align: string | null
  readonly form: string
  readonly minHeight: number
  readonly mode: string | null
  readonly title: string
}): string => {
  const searchParams = new URLSearchParams({
    form,
    minHeight: String(minHeight),
    title,
  })

  if (mode === "light" || mode === "dark") {
    searchParams.set("mode", mode)
  }

  if (align === "left" || align === "center") {
    searchParams.set("align", align)
  }

  return `/processfocus-embed.js?${searchParams.toString()}`
}

export const GET = async (request: Request) => {
  if (process.env["NODE_ENV"] === "production") {
    // This host page only exists to exercise embed wiring in frontend e2e.
    return new Response("Not found", { status: 404 })
  }

  const requestUrl = new URL(request.url)
  const embedMode = requestUrl.searchParams.get("mode")
  const embedAlign = requestUrl.searchParams.get("align")
  const includeTopSpacer = requestUrl.searchParams.get("spacer") === "before"

  const entries = getEmbedManifestEntries()
  const entry =
    entries.find(
      (candidate) => candidate.stepPath === PREFERRED_EMBED_STEP_PATH,
    ) ?? entries[0]

  if (!entry) {
    return new Response("No embedded forms are configured.", { status: 404 })
  }

  const hostTitle =
    entry.stepPath === PREFERRED_EMBED_STEP_PATH
      ? "Embedded calculator host"
      : `Embedded ${entry.processName} host`
  const embedScriptSrc = buildEmbedScriptSrc({
    align: embedAlign,
    form: entry.processPath,
    minHeight: 640,
    mode: embedMode,
    title: entry.processName,
  })

  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${hostTitle}</title>
    <style>
      body {
        font-family: ui-sans-serif, system-ui, sans-serif;
        margin: 0;
        padding: 24px;
        background: #f8fafc;
        color: #0f172a;
      }

      main {
        max-width: 1080px;
        margin: 0 auto;
      }

      iframe.processfocus-embed-frame {
        width: 100%;
        min-height: 640px;
        height: 640px;
        border: 0;
        border-radius: 24px;
        background: white;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
      }

      .test-spacer {
        min-height: 760px;
      }
    </style>
  </head>
    <body>
      <main>
        <h1>${hostTitle}</h1>
        ${includeTopSpacer ? '<div class="test-spacer" aria-hidden="true"></div>' : ""}
        <script src="${embedScriptSrc}"></script>
      </main>
      <script>
        window.__embedEvents = [];

        window.addEventListener("processfocus-embed", (event) => {
          window.__embedEvents.push(event.detail);
        });
      </script>
  </body>
</html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    },
  )
}
