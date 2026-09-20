import { DEFAULT_STEP_GAP } from "./layout"

const CORNER_RADIUS = 8
const EDGE_SPREAD = 12
const CROSS_LANE_ROW_LABEL_RATIO = 2
const SOURCE_GAP_LABEL_RATIO = 3

interface WorkflowEdgeRoutingOptions {
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  sourceColumn: number
  targetColumn: number
  sourceGapWidth?: number | undefined
  targetPrecedingGapWidth?: number | undefined
  edgeIndex?: number | undefined
  totalEdges?: number | undefined
  isCrossLane?: boolean | undefined
}

interface WorkflowEdgeRoute {
  path: string
  labelX: number
  labelY: number
}

interface Point {
  x: number
  y: number
}

export function getWorkflowEdgeRoute(
  options: WorkflowEdgeRoutingOptions,
): WorkflowEdgeRoute {
  const edgeIndex = options.edgeIndex ?? 0
  const totalEdges = options.totalEdges ?? 1
  const sourceGapWidth = options.sourceGapWidth ?? DEFAULT_STEP_GAP
  const targetPrecedingGapWidth =
    options.targetPrecedingGapWidth ?? DEFAULT_STEP_GAP
  const maxLeftwardSpread =
    totalEdges > 1 ? ((totalEdges - 1) / 2) * EDGE_SPREAD : 0

  // Keep sibling edges separated all the way to their turn point by reusing the
  // source-relative spread offset on both the source and target-side waypoints.
  const spreadOffset =
    totalEdges > 1 ? (edgeIndex - (totalEdges - 1) / 2) * EDGE_SPREAD : 0

  // Same-row adjacent-column edges stay straight even across lanes because the
  // direct connection is shorter and clearer than adding an artificial bend.
  if (
    Math.abs(options.sourceY - options.targetY) < 2 &&
    options.targetColumn === options.sourceColumn + 1
  ) {
    return {
      path: `M ${options.sourceX} ${options.sourceY} L ${options.targetX} ${options.targetY}`,
      labelX: (options.sourceX + options.targetX) / 2,
      labelY: options.sourceY,
    }
  }

  const sourceTurnX = options.sourceX + sourceGapWidth / 2 + spreadOffset

  if (options.isCrossLane && options.targetColumn > options.sourceColumn) {
    const minCrossLaneTurnX = options.sourceX + CORNER_RADIUS
    const targetTurnXBase = options.targetX - targetPrecedingGapWidth / 2
    const targetTurnX = targetTurnXBase + spreadOffset

    // Decide the routing strategy from the unspread turn point plus the maximum
    // leftward sibling spread so parallel edges keep the same shape near the
    // threshold, then apply spread to the final path points.
    if (targetTurnXBase > minCrossLaneTurnX + maxLeftwardSpread) {
      const path = createRoundedOrthogonalPath([
        { x: options.sourceX, y: options.sourceY },
        { x: targetTurnX, y: options.sourceY },
        { x: targetTurnX, y: options.targetY },
        { x: options.targetX, y: options.targetY },
      ])

      const horizontalDistanceBeforeTurn = Math.abs(
        targetTurnX - options.sourceX,
      )
      const finalVerticalDistance = Math.abs(options.targetY - options.sourceY)

      // Cross-lane forward edges are visually dominated by the long source-row
      // run, so move the label onto that row sooner than on source-gap fallbacks.
      if (
        horizontalDistanceBeforeTurn >
        finalVerticalDistance * CROSS_LANE_ROW_LABEL_RATIO
      ) {
        return {
          path,
          labelX: (options.sourceX + targetTurnX) / 2,
          labelY: options.sourceY,
        }
      }

      return {
        path,
        labelX: targetTurnX,
        labelY: (options.sourceY + options.targetY) / 2,
      }
    }
  }

  // Too little horizontal room for a later turn, or a backward edge: fall back
  // to the source-gap path immediately after the source column.
  const path = createRoundedOrthogonalPath([
    { x: options.sourceX, y: options.sourceY },
    { x: sourceTurnX, y: options.sourceY },
    { x: sourceTurnX, y: options.targetY },
    { x: options.targetX, y: options.targetY },
  ])

  const verticalDistance = Math.abs(options.targetY - options.sourceY)
  const horizontalDistanceAfterTurn = Math.abs(options.targetX - sourceTurnX)

  if (horizontalDistanceAfterTurn > verticalDistance * SOURCE_GAP_LABEL_RATIO) {
    return {
      path,
      labelX: (sourceTurnX + options.targetX) / 2,
      labelY: options.targetY,
    }
  }

  return {
    path,
    labelX: sourceTurnX,
    labelY: (options.sourceY + options.targetY) / 2,
  }
}

function createRoundedOrthogonalPath(points: ReadonlyArray<Point>): string {
  const dedupedPoints = points.filter(
    (point, index, allPoints) =>
      index === 0 ||
      point.x !== allPoints[index - 1]?.x ||
      point.y !== allPoints[index - 1]?.y,
  )

  const firstPoint = dedupedPoints[0]
  if (!firstPoint) return ""

  let path = `M ${firstPoint.x} ${firstPoint.y}`

  for (let index = 1; index < dedupedPoints.length; index += 1) {
    const previousPoint = dedupedPoints[index - 1]
    const currentPoint = dedupedPoints[index]
    const nextPoint = dedupedPoints[index + 1]

    if (!previousPoint || !currentPoint) continue

    if (!nextPoint) {
      path += ` L ${currentPoint.x} ${currentPoint.y}`
      continue
    }

    const incomingLength = getSegmentLength(previousPoint, currentPoint)
    const outgoingLength = getSegmentLength(currentPoint, nextPoint)

    if (incomingLength === 0 || outgoingLength === 0) {
      path += ` L ${currentPoint.x} ${currentPoint.y}`
      continue
    }

    const cornerRadius = Math.min(
      CORNER_RADIUS,
      incomingLength / 2,
      outgoingLength / 2,
    )
    const cornerStart = moveTowards(currentPoint, previousPoint, cornerRadius)
    const cornerEnd = moveTowards(currentPoint, nextPoint, cornerRadius)

    path += ` L ${cornerStart.x} ${cornerStart.y}`
    path += ` Q ${currentPoint.x} ${currentPoint.y} ${cornerEnd.x} ${cornerEnd.y}`
  }

  return path
}

function getSegmentLength(start: Point, end: Point): number {
  return Math.hypot(end.x - start.x, end.y - start.y)
}

function moveTowards(from: Point, to: Point, distance: number): Point {
  const segmentLength = getSegmentLength(from, to)
  if (segmentLength === 0) return from

  const ratio = distance / segmentLength

  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio,
  }
}
