import { describe, expect, test } from "vitest"
import { getWorkflowEdgeRoute } from "../lib/workflow/edge-routing"

function normalizePath(path: string): string {
  return path.replace(/\s+/g, " ").trim()
}

function escapeRegex(value: number): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function expectPathToIncludePoints(
  path: string,
  points: ReadonlyArray<readonly [number, number]>,
): void {
  const normalizedPath = normalizePath(path)

  for (const [x, y] of points) {
    expect(normalizedPath).toMatch(
      new RegExp(`(^|[^0-9.-])${escapeRegex(x)} ${escapeRegex(y)}([^0-9.-]|$)`),
    )
  }
}

describe("getWorkflowEdgeRoute", () => {
  test("keeps same-row adjacent edges as straight lines", () => {
    const route = getWorkflowEdgeRoute({
      sourceX: 360,
      sourceY: 300,
      targetX: 640,
      targetY: 300,
      sourceColumn: 2,
      targetColumn: 3,
    })

    expect(normalizePath(route.path)).toBe("M 360 300 L 640 300")
    expect(route.labelX).toBe(500)
    expect(route.labelY).toBe(300)
  })

  test("keeps forward cross-swimlane edges on the source row", () => {
    const route = getWorkflowEdgeRoute({
      sourceX: 360,
      sourceY: 300,
      targetX: 1080,
      targetY: 100,
      sourceColumn: 2,
      targetColumn: 4,
      sourceGapWidth: 80,
      targetPrecedingGapWidth: 80,
      isCrossLane: true,
    })

    expectPathToIncludePoints(route.path, [
      [1040, 300],
      [1040, 100],
    ])
    expect(route.labelX).toBe(700)
    expect(route.labelY).toBe(300)
  })

  test("uses the source-gap path for same-lane forward edges across multiple columns", () => {
    const route = getWorkflowEdgeRoute({
      sourceX: 360,
      sourceY: 300,
      targetX: 920,
      targetY: 180,
      sourceColumn: 2,
      targetColumn: 4,
      sourceGapWidth: 80,
    })

    expectPathToIncludePoints(route.path, [
      [400, 300],
      [400, 180],
    ])
    expect(route.labelX).toBe(660)
    expect(route.labelY).toBe(180)
  })

  test("uses the source-gap path for same-column edges", () => {
    const route = getWorkflowEdgeRoute({
      sourceX: 360,
      sourceY: 300,
      targetX: 360,
      targetY: 100,
      sourceColumn: 2,
      targetColumn: 2,
      sourceGapWidth: 80,
    })

    expectPathToIncludePoints(route.path, [
      [400, 300],
      [400, 100],
    ])
    expect(route.labelX).toBe(400)
    expect(route.labelY).toBe(200)
  })

  test("uses the source-gap path for backward edges", () => {
    const route = getWorkflowEdgeRoute({
      sourceX: 600,
      sourceY: 300,
      targetX: 300,
      targetY: 100,
      sourceColumn: 4,
      targetColumn: 2,
      sourceGapWidth: 80,
      targetPrecedingGapWidth: 80,
      isCrossLane: true,
    })

    expectPathToIncludePoints(route.path, [
      [640, 300],
      [640, 100],
    ])
    expect(route.labelX).toBe(640)
    expect(route.labelY).toBe(200)
  })

  test("falls back to the source-gap path when a cross-lane edge has little room", () => {
    const route = getWorkflowEdgeRoute({
      sourceX: 360,
      sourceY: 300,
      targetX: 390,
      targetY: 100,
      sourceColumn: 2,
      targetColumn: 4,
      sourceGapWidth: 80,
      targetPrecedingGapWidth: 80,
      isCrossLane: true,
    })

    expectPathToIncludePoints(route.path, [
      [400, 300],
      [400, 100],
    ])
    expect(route.labelX).toBe(400)
    expect(route.labelY).toBe(200)
  })

  test("keeps sibling forward edges separated with source-relative spread", () => {
    const firstRoute = getWorkflowEdgeRoute({
      sourceX: 360,
      sourceY: 300,
      targetX: 1080,
      targetY: 100,
      sourceColumn: 2,
      targetColumn: 4,
      sourceGapWidth: 80,
      targetPrecedingGapWidth: 80,
      edgeIndex: 0,
      totalEdges: 2,
      isCrossLane: true,
    })
    const secondRoute = getWorkflowEdgeRoute({
      sourceX: 360,
      sourceY: 300,
      targetX: 1080,
      targetY: 100,
      sourceColumn: 2,
      targetColumn: 4,
      sourceGapWidth: 80,
      targetPrecedingGapWidth: 80,
      edgeIndex: 1,
      totalEdges: 2,
      isCrossLane: true,
    })

    expectPathToIncludePoints(firstRoute.path, [[1034, 300]])
    expectPathToIncludePoints(secondRoute.path, [[1046, 300]])
    expect(firstRoute.labelX).toBe(697)
    expect(secondRoute.labelX).toBe(703)
    expect(firstRoute.labelY).toBe(300)
    expect(secondRoute.labelY).toBe(300)
  })

  test("keeps sibling cross-lane edges on the same strategy near the turn threshold", () => {
    const firstRoute = getWorkflowEdgeRoute({
      sourceX: 360,
      sourceY: 300,
      targetX: 410,
      targetY: 100,
      sourceColumn: 2,
      targetColumn: 4,
      sourceGapWidth: 80,
      targetPrecedingGapWidth: 40,
      edgeIndex: 0,
      totalEdges: 2,
      isCrossLane: true,
    })
    const secondRoute = getWorkflowEdgeRoute({
      sourceX: 360,
      sourceY: 300,
      targetX: 410,
      targetY: 100,
      sourceColumn: 2,
      targetColumn: 4,
      sourceGapWidth: 80,
      targetPrecedingGapWidth: 40,
      edgeIndex: 1,
      totalEdges: 2,
      isCrossLane: true,
    })

    expectPathToIncludePoints(firstRoute.path, [
      [384, 300],
      [384, 100],
    ])
    expectPathToIncludePoints(secondRoute.path, [
      [396, 300],
      [396, 100],
    ])
    expect(firstRoute.labelX).toBe(384)
    expect(secondRoute.labelX).toBe(396)
    expect(firstRoute.labelY).toBe(200)
    expect(secondRoute.labelY).toBe(200)
  })

  test("falls back for all siblings when spread would push one below the turn threshold", () => {
    const firstRoute = getWorkflowEdgeRoute({
      sourceX: 360,
      sourceY: 300,
      targetX: 390,
      targetY: 100,
      sourceColumn: 2,
      targetColumn: 4,
      sourceGapWidth: 80,
      targetPrecedingGapWidth: 40,
      edgeIndex: 0,
      totalEdges: 2,
      isCrossLane: true,
    })
    const secondRoute = getWorkflowEdgeRoute({
      sourceX: 360,
      sourceY: 300,
      targetX: 390,
      targetY: 100,
      sourceColumn: 2,
      targetColumn: 4,
      sourceGapWidth: 80,
      targetPrecedingGapWidth: 40,
      edgeIndex: 1,
      totalEdges: 2,
      isCrossLane: true,
    })

    expectPathToIncludePoints(firstRoute.path, [
      [394, 300],
      [394, 100],
    ])
    expectPathToIncludePoints(secondRoute.path, [
      [406, 300],
      [406, 100],
    ])
    expect(firstRoute.labelX).toBe(394)
    expect(secondRoute.labelX).toBe(406)
    expect(firstRoute.labelY).toBe(200)
    expect(secondRoute.labelY).toBe(200)
  })

  test("puts the cross-lane label on the vertical segment when the rise dominates", () => {
    const route = getWorkflowEdgeRoute({
      sourceX: 360,
      sourceY: 300,
      targetX: 430,
      targetY: 100,
      sourceColumn: 2,
      targetColumn: 4,
      sourceGapWidth: 80,
      targetPrecedingGapWidth: 80,
      isCrossLane: true,
    })

    expectPathToIncludePoints(route.path, [
      [390, 300],
      [390, 100],
    ])
    expect(route.labelX).toBe(390)
    expect(route.labelY).toBe(200)
  })
})
