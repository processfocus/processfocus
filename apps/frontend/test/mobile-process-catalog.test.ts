import { describe, expect, test } from "vitest"
import { createMobileProcessCatalog } from "../app/(protected)/processes/lib/mobile-process-catalog"

describe("createMobileProcessCatalog", () => {
  test("orders processes alphabetically by title", () => {
    const catalog = createMobileProcessCatalog([
      {
        id: "2",
        name: "Zebra Intake",
        purpose: "Last in the list",
        startStepPath: "zebra/start",
      },
      {
        id: "1",
        name: "Alpha Intake",
        purpose: "First in the list",
        startStepPath: "alpha/start",
      },
    ])

    expect(catalog.map((item) => item.title)).toEqual([
      "Alpha Intake",
      "Zebra Intake",
    ])
  })

  test("collapses whitespace and preserves start routes", () => {
    const [item] = createMobileProcessCatalog([
      {
        id: "1",
        name: "  Purchase\n Request  ",
        purpose: "  Start   a\nnew  purchase request  ",
        startStepPath: "finance/purchase-request/start",
      },
    ])

    expect(item).toEqual({
      id: "1",
      title: "Purchase Request",
      description: "Start a new purchase request",
      startHref: "/processes/start/finance/purchase-request/start",
    })
  })

  test("preserves the full mobile description text", () => {
    const [item] = createMobileProcessCatalog([
      {
        id: "1",
        name: "Long Description",
        purpose:
          "This purpose is intentionally long so the mobile catalog keeps the row compact and readable for quick process starts.",
        startStepPath: "long-description/start",
      },
    ])

    expect(item.description).toBe(
      "This purpose is intentionally long so the mobile catalog keeps the row compact and readable for quick process starts.",
    )
  })
})
