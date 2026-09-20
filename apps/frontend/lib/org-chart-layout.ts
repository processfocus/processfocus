import type { Edge, Node } from "@xyflow/react"
import type { OrgUnit, OrgUnitNodeData } from "./org-chart-types"

interface LayoutNode extends OrgUnit {
  children: LayoutNode[]
  depth: number
  x: number
  y: number
  width: number
}

const MIN_NODE_WIDTH = 280
const NODE_HEIGHT = 90
const HORIZONTAL_GAP = 40
const VERTICAL_GAP = 100

// Build tree structure from flat array
const buildTree = (units: OrgUnit[]): LayoutNode | null => {
  const unitMap = new Map<string, LayoutNode>()

  // Create layout nodes
  units.forEach((unit) => {
    unitMap.set(unit.id, {
      ...unit,
      children: [],
      depth: 0,
      x: 0,
      y: 0,
      width: MIN_NODE_WIDTH,
    })
  })

  // Build parent-child relationships
  let root: LayoutNode | null = null
  units.forEach((unit) => {
    const node = unitMap.get(unit.id)
    if (!node) return

    if (unit.parentId) {
      const parent = unitMap.get(unit.parentId)
      if (parent) {
        parent.children.push(node)
      }
    } else {
      root = node
    }
  })

  return root
}

// Calculate width needed for a subtree
const calculateSubtreeWidth = (node: LayoutNode): number => {
  if (node.children.length === 0) {
    return MIN_NODE_WIDTH
  }

  const childrenWidth = node.children.reduce((sum, child) => {
    return sum + calculateSubtreeWidth(child)
  }, 0)

  const gapsWidth = (node.children.length - 1) * HORIZONTAL_GAP
  return Math.max(MIN_NODE_WIDTH, childrenWidth + gapsWidth)
}

// Assign depths to nodes
const assignDepths = (node: LayoutNode, depth = 0): void => {
  node.depth = depth
  for (const child of node.children) {
    assignDepths(child, depth + 1)
  }
}

// Position nodes in the tree
const positionNodes = (node: LayoutNode, startX = 0): void => {
  const subtreeWidth = calculateSubtreeWidth(node)
  node.width = subtreeWidth

  // Node spans the full subtree width
  node.x = startX
  node.y = node.depth * (NODE_HEIGHT + VERTICAL_GAP)

  // Position children
  if (node.children.length > 0) {
    let childX = startX

    node.children.forEach((child) => {
      positionNodes(child, childX)
      childX += calculateSubtreeWidth(child) + HORIZONTAL_GAP
    })
  }
}

// Convert tree to React Flow nodes and edges
const treeToNodesAndEdges = (
  node: LayoutNode,
  nodes: Node<OrgUnitNodeData>[] = [],
  edges: Edge[] = [],
): { nodes: Node<OrgUnitNodeData>[]; edges: Edge[] } => {
  // Add node with calculated width
  nodes.push({
    id: node.id,
    type: "orgUnit",
    position: { x: node.x, y: node.y },
    data: {
      name: node.name,
      level: node.level,
      width: node.width,
    },
    style: {
      width: node.width,
      height: NODE_HEIGHT,
    },
    draggable: false,
  })

  // Add edges and process children
  node.children.forEach((child) => {
    edges.push({
      id: `${node.id}-${child.id}`,
      source: node.id,
      target: child.id,
      type: "smoothstep",
      style: { stroke: "#94a3b8", strokeWidth: 2 },
    })

    treeToNodesAndEdges(child, nodes, edges)
  })

  return { nodes, edges }
}

export const layoutOrgChart = (
  units: OrgUnit[],
): {
  nodes: Node<OrgUnitNodeData>[]
  edges: Edge[]
} => {
  const root = buildTree(units)

  if (!root) {
    return { nodes: [], edges: [] }
  }

  assignDepths(root)
  positionNodes(root)

  return treeToNodesAndEdges(root)
}
