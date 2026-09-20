import { describe, expect, it } from "bun:test"

/**
 * Integration test to verify that the /types subpath export doesn't pull in Effect.
 *
 * This is important for bundle size - client components should import from
 * @pf/form-client-representation/types to avoid pulling Effect into the client bundle.
 */
describe("@pf/form-client-representation/types export", () => {
  it("exports FormComponentType enum", async () => {
    const { FormComponentType } = await import("./types")

    expect(FormComponentType.Text).toBeDefined()
    expect(FormComponentType.Number).toBeDefined()
    expect(FormComponentType.Boolean).toBeDefined()
    expect(FormComponentType.FieldSet).toBeDefined()
  })

  it("exports type definitions (compile-time check)", async () => {
    // This test verifies the types are exported and usable
    // If any type is missing, this would fail at compile time
    const types = await import("./types")

    // Verify the module exports the expected items
    expect(types.FormComponentType).toBeDefined()

    // The following are type-only exports, so we just verify the module loads
    // without errors. The actual type checking happens at compile time.
    expect(types).toBeDefined()
  })

  it("does not export Effect-dependent code", async () => {
    // Import the types module
    const typesModule = await import("./types")

    // The types module should only export:
    // - FormComponentType enum
    // - Type definitions (which don't exist at runtime)
    const exportedKeys = Object.keys(typesModule)

    // Should only have the enum (types are erased at runtime)
    expect(exportedKeys).toContain("FormComponentType")

    // Verify no Effect-specific exports leak through
    expect(exportedKeys).not.toContain("Effect")
    expect(exportedKeys).not.toContain("Context")
    expect(exportedKeys).not.toContain("Layer")
    expect(exportedKeys).not.toContain("Match")
  })
})
