/// <reference types="bun" />

import { resolve } from "node:path"

// No organisation/runtime credentials or databases. This exercises the actual
// browser components, not secret exchange or a live delegated Dashboard.
const bundle = await Bun.build({
  entrypoints: [
    resolve(
      import.meta.dir,
      "../../frontend/test/fixtures/delegation-ui-probe.tsx",
    ),
  ],
  target: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
})
if (!bundle.success) throw new Error("Unable to bundle delegation UI probe")
const output = bundle.outputs[0]
if (!output) throw new Error("Missing delegation UI probe bundle")
const javascript = await output.text()
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/probe.js")
      return new Response(javascript, {
        headers: { "Content-Type": "text/javascript" },
      })
    if (path === "/api/auth/delegation")
      return Response.json(
        { success: false },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      )
    return new Response(
      `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Delegated access component probe</title><style>body{font:16px system-ui;margin:0;color:#172033;background:#f7f8fa}main{max-width:560px;margin:32px auto;padding:24px}form{display:grid;gap:12px;margin-top:16px}input,button{box-sizing:border-box;width:100%;padding:12px;font:inherit}details,[role=status]{padding:16px;border:1px solid #d6d9df;border-radius:8px;background:white}summary{cursor:pointer}[role=status]{background:#fff7df}p{overflow-wrap:anywhere}time{font-variant-numeric:tabular-nums}</style></head><body><div id="root"></div><script type="module" src="/probe.js"></script></body></html>`,
      { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } },
    )
  },
})
console.info(`Delegation component probe: ${server.url}`)
