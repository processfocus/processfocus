import { calculateStepColumns } from "../src/lib/workflow-columns"
import { describe, expect, it } from "bun:test"

describe("calculateStepColumns", () => {
  it("handles single step (no flows)", () => {
    const steps = [{ id: "A", isStartStep: true }]
    const flows: { sourceStepId: string; targetStepId: string }[] = []

    const columns = calculateStepColumns(steps, flows)

    expect(columns.get("A")).toBe(1)
  })

  it("handles linear flow: A → B → C (columns: 1, 2, 3)", () => {
    const steps = [
      { id: "A", isStartStep: true },
      { id: "B", isStartStep: false },
      { id: "C", isStartStep: false },
    ]
    const flows = [
      { sourceStepId: "A", targetStepId: "B" },
      { sourceStepId: "B", targetStepId: "C" },
    ]

    const columns = calculateStepColumns(steps, flows)

    expect(columns.get("A")).toBe(1)
    expect(columns.get("B")).toBe(2)
    expect(columns.get("C")).toBe(3)
  })

  it("handles convergent flow: A → C, B → C (A=1, B=1, C=2)", () => {
    const steps = [
      { id: "A", isStartStep: true },
      { id: "B", isStartStep: true },
      { id: "C", isStartStep: false },
    ]
    const flows = [
      { sourceStepId: "A", targetStepId: "C" },
      { sourceStepId: "B", targetStepId: "C" },
    ]

    const columns = calculateStepColumns(steps, flows)

    expect(columns.get("A")).toBe(1)
    expect(columns.get("B")).toBe(1)
    expect(columns.get("C")).toBe(2)
  })

  it("handles diamond pattern: A → B → D, A → C → D (A=1, B=2, C=2, D=3)", () => {
    const steps = [
      { id: "A", isStartStep: true },
      { id: "B", isStartStep: false },
      { id: "C", isStartStep: false },
      { id: "D", isStartStep: false },
    ]
    const flows = [
      { sourceStepId: "A", targetStepId: "B" },
      { sourceStepId: "A", targetStepId: "C" },
      { sourceStepId: "B", targetStepId: "D" },
      { sourceStepId: "C", targetStepId: "D" },
    ]

    const columns = calculateStepColumns(steps, flows)

    expect(columns.get("A")).toBe(1)
    expect(columns.get("B")).toBe(2)
    expect(columns.get("C")).toBe(2)
    expect(columns.get("D")).toBe(3)
  })

  it("handles multiple start steps with different path lengths", () => {
    // A → B → D
    // C → D
    // D should be at column 3 (max path)
    const steps = [
      { id: "A", isStartStep: true },
      { id: "B", isStartStep: false },
      { id: "C", isStartStep: true },
      { id: "D", isStartStep: false },
    ]
    const flows = [
      { sourceStepId: "A", targetStepId: "B" },
      { sourceStepId: "B", targetStepId: "D" },
      { sourceStepId: "C", targetStepId: "D" },
    ]

    const columns = calculateStepColumns(steps, flows)

    expect(columns.get("A")).toBe(1)
    expect(columns.get("B")).toBe(2)
    expect(columns.get("C")).toBe(1)
    expect(columns.get("D")).toBe(3) // max(B=2, C=1) + 1 = 3
  })

  it("handles empty steps array", () => {
    const steps: { id: string; isStartStep: boolean }[] = []
    const flows: { sourceStepId: string; targetStepId: string }[] = []

    const columns = calculateStepColumns(steps, flows)

    expect(columns.size).toBe(0)
  })

  it("handles parallel branches: A → B, A → C (no convergence)", () => {
    const steps = [
      { id: "A", isStartStep: true },
      { id: "B", isStartStep: false },
      { id: "C", isStartStep: false },
    ]
    const flows = [
      { sourceStepId: "A", targetStepId: "B" },
      { sourceStepId: "A", targetStepId: "C" },
    ]

    const columns = calculateStepColumns(steps, flows)

    expect(columns.get("A")).toBe(1)
    expect(columns.get("B")).toBe(2)
    expect(columns.get("C")).toBe(2)
  })

  it("handles complex convergent pattern with unequal path lengths", () => {
    // A → B → C → E
    //     D ────→ E
    // E should be at column 4 (max path from A through C)
    const steps = [
      { id: "A", isStartStep: true },
      { id: "B", isStartStep: false },
      { id: "C", isStartStep: false },
      { id: "D", isStartStep: true },
      { id: "E", isStartStep: false },
    ]
    const flows = [
      { sourceStepId: "A", targetStepId: "B" },
      { sourceStepId: "B", targetStepId: "C" },
      { sourceStepId: "C", targetStepId: "E" },
      { sourceStepId: "D", targetStepId: "E" },
    ]

    const columns = calculateStepColumns(steps, flows)

    expect(columns.get("A")).toBe(1)
    expect(columns.get("B")).toBe(2)
    expect(columns.get("C")).toBe(3)
    expect(columns.get("D")).toBe(1)
    expect(columns.get("E")).toBe(4) // max(C=3, D=1) + 1 = 4
  })

  it("handles step with no start step flag but is source of flows", () => {
    // This tests a step that has no incoming flows but isn't marked as start
    // Such steps won't get a column assigned (edge case/data integrity issue)
    const steps = [
      { id: "A", isStartStep: false }, // Not marked as start
      { id: "B", isStartStep: false },
    ]
    const flows = [{ sourceStepId: "A", targetStepId: "B" }]

    const columns = calculateStepColumns(steps, flows)

    // A won't be processed since it's not a start step
    expect(columns.has("A")).toBe(false)
    expect(columns.has("B")).toBe(false)
  })

  it("handles sequential chain with 5 steps", () => {
    const steps = [
      { id: "A", isStartStep: true },
      { id: "B", isStartStep: false },
      { id: "C", isStartStep: false },
      { id: "D", isStartStep: false },
      { id: "E", isStartStep: false },
    ]
    const flows = [
      { sourceStepId: "A", targetStepId: "B" },
      { sourceStepId: "B", targetStepId: "C" },
      { sourceStepId: "C", targetStepId: "D" },
      { sourceStepId: "D", targetStepId: "E" },
    ]

    const columns = calculateStepColumns(steps, flows)

    expect(columns.get("A")).toBe(1)
    expect(columns.get("B")).toBe(2)
    expect(columns.get("C")).toBe(3)
    expect(columns.get("D")).toBe(4)
    expect(columns.get("E")).toBe(5)
  })

  // Phase-aware column calculation tests
  describe("phase-aware column calculation", () => {
    it("separates steps into phase waves", () => {
      // A(P1) → B(P1)
      //      ↘ C(P2) → D(P2)
      // Without phases: A=1, B=2, C=2, D=3
      // With phases: A=1, B=2, C=3, D=4
      const steps = [
        { id: "A", isStartStep: true, phaseId: "P1" },
        { id: "B", isStartStep: false, phaseId: "P1" },
        { id: "C", isStartStep: false, phaseId: "P2" },
        { id: "D", isStartStep: false, phaseId: "P2" },
      ]
      const flows = [
        { sourceStepId: "A", targetStepId: "B" },
        { sourceStepId: "A", targetStepId: "C" },
        { sourceStepId: "C", targetStepId: "D" },
      ]
      const columns = calculateStepColumns(steps, flows)
      expect(columns.get("A")).toBe(1)
      expect(columns.get("B")).toBe(2)
      expect(columns.get("C")).toBe(3)
      expect(columns.get("D")).toBe(4)
    })

    it("handles three phases correctly", () => {
      // A(P1) → B(P2) → C(P3)
      const steps = [
        { id: "A", isStartStep: true, phaseId: "P1" },
        { id: "B", isStartStep: false, phaseId: "P2" },
        { id: "C", isStartStep: false, phaseId: "P3" },
      ]
      const flows = [
        { sourceStepId: "A", targetStepId: "B" },
        { sourceStepId: "B", targetStepId: "C" },
      ]
      const columns = calculateStepColumns(steps, flows)
      expect(columns.get("A")).toBe(1)
      expect(columns.get("B")).toBe(2)
      expect(columns.get("C")).toBe(3)
    })

    it("steps without phases follow graph structure", () => {
      // A(P1) → B(no phase) → C(P2)
      const steps = [
        { id: "A", isStartStep: true, phaseId: "P1" },
        { id: "B", isStartStep: false }, // no phase
        { id: "C", isStartStep: false, phaseId: "P2" },
      ]
      const flows = [
        { sourceStepId: "A", targetStepId: "B" },
        { sourceStepId: "B", targetStepId: "C" },
      ]
      const columns = calculateStepColumns(steps, flows)
      expect(columns.get("A")).toBe(1)
      expect(columns.get("B")).toBe(2)
      expect(columns.get("C")).toBe(3) // P2 starts after P1 max (1), so ≥2, tentative=3, offset=0
    })

    it("handles convergent flows within phases", () => {
      // P1: A → B, C → B (converge)
      // P2: B → D
      const steps = [
        { id: "A", isStartStep: true, phaseId: "P1" },
        { id: "C", isStartStep: true, phaseId: "P1" },
        { id: "B", isStartStep: false, phaseId: "P1" },
        { id: "D", isStartStep: false, phaseId: "P2" },
      ]
      const flows = [
        { sourceStepId: "A", targetStepId: "B" },
        { sourceStepId: "C", targetStepId: "B" },
        { sourceStepId: "B", targetStepId: "D" },
      ]
      const columns = calculateStepColumns(steps, flows)
      expect(columns.get("A")).toBe(1)
      expect(columns.get("C")).toBe(1)
      expect(columns.get("B")).toBe(2)
      expect(columns.get("D")).toBe(3) // P2 starts after P1 max (2)
    })

    it("single phase behaves like no phases", () => {
      const steps = [
        { id: "A", isStartStep: true, phaseId: "P1" },
        { id: "B", isStartStep: false, phaseId: "P1" },
        { id: "C", isStartStep: false, phaseId: "P1" },
      ]
      const flows = [
        { sourceStepId: "A", targetStepId: "B" },
        { sourceStepId: "B", targetStepId: "C" },
      ]
      const columns = calculateStepColumns(steps, flows)
      expect(columns.get("A")).toBe(1)
      expect(columns.get("B")).toBe(2)
      expect(columns.get("C")).toBe(3)
    })

    it("parallel branches in same phase stay in same columns", () => {
      // A(P1) → B(P1)
      // A(P1) → C(P1)
      const steps = [
        { id: "A", isStartStep: true, phaseId: "P1" },
        { id: "B", isStartStep: false, phaseId: "P1" },
        { id: "C", isStartStep: false, phaseId: "P1" },
      ]
      const flows = [
        { sourceStepId: "A", targetStepId: "B" },
        { sourceStepId: "A", targetStepId: "C" },
      ]
      const columns = calculateStepColumns(steps, flows)
      expect(columns.get("A")).toBe(1)
      expect(columns.get("B")).toBe(2)
      expect(columns.get("C")).toBe(2)
    })

    it("phases without direct flow still separate", () => {
      // A(P1) → B(P1)
      // C(P2) → D(P2)  [separate track, same process]
      // P1 and P2 have no direct flow between them
      // P2 should still start at column 3 (after P1 ends at 2)
      const steps = [
        { id: "A", isStartStep: true, phaseId: "P1" },
        { id: "B", isStartStep: false, phaseId: "P1" },
        { id: "C", isStartStep: true, phaseId: "P2" },
        { id: "D", isStartStep: false, phaseId: "P2" },
      ]
      const flows = [
        { sourceStepId: "A", targetStepId: "B" },
        { sourceStepId: "C", targetStepId: "D" },
      ]
      const columns = calculateStepColumns(steps, flows)
      // P1: A=1, B=2
      // P2: tentative C=1, D=2, but must shift to start at 3
      expect(columns.get("A")).toBe(1)
      expect(columns.get("B")).toBe(2)
      expect(columns.get("C")).toBe(3)
      expect(columns.get("D")).toBe(4)
    })

    it("later phase step pushed even if tentative is earlier", () => {
      // A(P1) → B(P1) → D(P1)
      // A(P1) → C(P2)
      // Tentative: A=1, B=2, C=2, D=3
      // C is P2, must wait for P1 to finish (D=3), so C=4
      const steps = [
        { id: "A", isStartStep: true, phaseId: "P1" },
        { id: "B", isStartStep: false, phaseId: "P1" },
        { id: "C", isStartStep: false, phaseId: "P2" },
        { id: "D", isStartStep: false, phaseId: "P1" },
      ]
      const flows = [
        { sourceStepId: "A", targetStepId: "B" },
        { sourceStepId: "A", targetStepId: "C" },
        { sourceStepId: "B", targetStepId: "D" },
      ]
      const columns = calculateStepColumns(steps, flows)
      expect(columns.get("A")).toBe(1)
      expect(columns.get("B")).toBe(2)
      expect(columns.get("D")).toBe(3)
      expect(columns.get("C")).toBe(4) // P2 must wait for P1 to finish
    })

    it("avoids empty columns when later phase has steps at different depths", () => {
      // Pre-boarding: A(start) → B → C
      //               A → D(Day1), E(Day1)  (parallel from A)
      //               C → F(Day1)           (sequential from C)
      //
      // Tentative: A=1, B=2, C=3, D=2, E=2, F=4
      // Pre-boarding max = 3
      // Day 1 min tentative = 2
      // Day 1 should start at column 4
      //
      // D and E: tentative=2, need offset +2 → column 4
      // F: tentative=4, already at boundary, should stay at 4 (not 6!)
      const steps = [
        { id: "A", isStartStep: true, phaseId: "Pre-boarding" },
        { id: "B", isStartStep: false, phaseId: "Pre-boarding" },
        { id: "C", isStartStep: false, phaseId: "Pre-boarding" },
        { id: "D", isStartStep: false, phaseId: "Day1" },
        { id: "E", isStartStep: false, phaseId: "Day1" },
        { id: "F", isStartStep: false, phaseId: "Day1" },
      ]
      const flows = [
        { sourceStepId: "A", targetStepId: "B" },
        { sourceStepId: "B", targetStepId: "C" },
        { sourceStepId: "A", targetStepId: "D" },
        { sourceStepId: "A", targetStepId: "E" },
        { sourceStepId: "C", targetStepId: "F" },
      ]
      const columns = calculateStepColumns(steps, flows)
      expect(columns.get("A")).toBe(1)
      expect(columns.get("B")).toBe(2)
      expect(columns.get("C")).toBe(3)
      // Day 1 should start at 4, D and E pushed from 2 to 4
      expect(columns.get("D")).toBe(4)
      expect(columns.get("E")).toBe(4)
      // F was tentatively at 4, should stay at 4 (not be pushed to 6)
      expect(columns.get("F")).toBe(4)
    })

    it("selects phase with lowest order when multiple new phases are ready", () => {
      // A(start) → B(P1, order=2)
      //         → C(P2, order=1)
      // Both B and C ready after A, but P2 (order=1) should be picked first
      const steps = [
        { id: "A", isStartStep: true },
        { id: "B", isStartStep: false, phaseId: "P1", phaseOrder: 2 },
        { id: "C", isStartStep: false, phaseId: "P2", phaseOrder: 1 },
      ]
      const flows = [
        { sourceStepId: "A", targetStepId: "B" },
        { sourceStepId: "A", targetStepId: "C" },
      ]
      const columns = calculateStepColumns(steps, flows)
      expect(columns.get("A")).toBe(1)
      // P2 (order=1) should be placed first, then P1 (order=2)
      expect(columns.get("C")).toBe(2) // P2, lower order
      expect(columns.get("B")).toBe(3) // P1, higher order
    })

    it("falls back to placing phases with undefined order after phases with defined order", () => {
      // A(start) → B(P1, order=undefined)
      //         → C(P2, order=1)
      // P2 has explicit order, P1 doesn't, so P2 should be placed first
      const steps = [
        { id: "A", isStartStep: true },
        { id: "B", isStartStep: false, phaseId: "P1" }, // no phaseOrder
        { id: "C", isStartStep: false, phaseId: "P2", phaseOrder: 1 },
      ]
      const flows = [
        { sourceStepId: "A", targetStepId: "B" },
        { sourceStepId: "A", targetStepId: "C" },
      ]
      const columns = calculateStepColumns(steps, flows)
      expect(columns.get("A")).toBe(1)
      expect(columns.get("C")).toBe(2) // P2 with order=1 placed first
      expect(columns.get("B")).toBe(3) // P1 with no order placed last
    })
  })
})
