import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { RxDbProviderBoundary } from "../lib/collections/rxdb-provider"

describe("RxDbProviderBoundary", () => {
  test("hides stale-cache descendants while a reset is pending", () => {
    const rendered = renderToStaticMarkup(
      <RxDbProviderBoundary
        state={{ status: "resetting" }}
        onRetry={async () => undefined}
      >
        <p>stale collection content</p>
      </RxDbProviderBoundary>,
    )

    expect(rendered).not.toContain("stale collection content")
  })
})
