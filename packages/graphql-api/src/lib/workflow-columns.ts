/**
 * Workflow column calculation for step positioning in visualizations.
 */

interface WorkflowStep {
  id: string
  isStartStep: boolean
  phaseId?: string | null
  phaseOrder?: number | null
}

interface WorkflowFlow {
  sourceStepId: string
  targetStepId: string
}

/**
 * Calculate column positions for workflow steps for visualization.
 *
 * Assigns each step a column number (1-indexed) such that:
 * - Steps flow left-to-right following the DAG structure
 * - Steps with phases form separate "waves" - a new phase cannot start
 *   until all steps from previous phases are placed
 *
 * ## Algorithm
 *
 * Processes columns iteratively, placing steps when ready:
 *
 * 1. **Ready check**: A step is ready when all predecessors are placed
 *    (or it's a start step with no predecessors)
 *
 * 2. **Phase-aware placement**: For each column, categorize ready steps:
 *    - No phase: always placed
 *    - Seen phase (appeared in earlier column): placed
 *    - New phase: only placed if no seen-phase steps are ready
 *
 * 3. **Phase conflict resolution**: When multiple new phases are ready
 *    simultaneously, pick the one with lowest phaseOrder and defer the rest
 *
 * 4. **Iteration**: Unplaced steps remain pending for the next column
 *
 * ## Example
 *
 * ```
 * Steps: A(P1), B(P1), C(P2), D(P2)
 * Flows: A→B, A→C, C→D
 *
 * Column 1: A ready (start) → place A, P1 seen
 * Column 2: B,C ready. B is P1 (seen), C is P2 (new)
 *           → place B only, defer C
 * Column 3: C ready, no seen-phase steps → place C, P2 seen
 * Column 4: D ready, P2 seen → place D
 *
 * Result: A=1, B=2, C=3, D=4
 * ```
 *
 * ## Complexity
 *
 * Time: O(V * C) where V = steps, C = columns (worst case O(V²))
 * Space: O(V + E) for adjacency maps
 *
 * @param steps - Workflow steps with id, isStartStep, and optional phaseId
 * @param flows - Directed edges between steps
 * @returns Map of step ID to column number (1-indexed)
 */
export function calculateStepColumns(
  steps: readonly WorkflowStep[],
  flows: readonly WorkflowFlow[],
): Map<string, number> {
  // Build reverse map: targetStepId -> sourceStepIds[]
  const flowsToStep = new Map<string, string[]>()
  for (const flow of flows) {
    const sources = flowsToStep.get(flow.targetStepId) ?? []
    sources.push(flow.sourceStepId)
    flowsToStep.set(flow.targetStepId, sources)
  }

  // Build step lookup by id
  const stepById = new Map<string, WorkflowStep>()
  for (const step of steps) {
    stepById.set(step.id, step)
  }

  const stepColumns = new Map<string, number>()
  const placed = new Set<string>()
  const seenPhases = new Set<string>()

  // Pending steps not yet placed
  const pending = new Set(steps.map((s) => s.id))

  let column = 1
  while (pending.size > 0) {
    // Find steps ready to be placed (all predecessors placed)
    const ready: string[] = []
    for (const id of pending) {
      const sources = flowsToStep.get(id) ?? []
      const step = stepById.get(id)
      // Ready if: start step, or has sources and all sources placed
      const isReady =
        step?.isStartStep ||
        (sources.length > 0 && sources.every((s) => placed.has(s)))
      if (isReady) {
        ready.push(id)
      }
    }

    if (ready.length === 0) {
      // No progress possible - break to avoid infinite loop
      break
    }

    // Categorize ready steps by phase status
    const seenPhaseSteps: string[] = []
    const newPhaseSteps: string[] = []
    const noPhaseSteps: string[] = []

    for (const id of ready) {
      const step = stepById.get(id)
      if (!step?.phaseId) {
        noPhaseSteps.push(id)
      } else if (seenPhases.has(step.phaseId)) {
        seenPhaseSteps.push(id)
      } else {
        newPhaseSteps.push(id)
      }
    }

    // Determine what can be placed this column:
    // - If we have any seen-phase steps, we cannot place new-phase steps
    // - No-phase steps can always be placed
    // - If multiple new phases ready and no seen phases, pick one (alphabetically first)
    const toPlace: string[] = [...noPhaseSteps, ...seenPhaseSteps]

    if (seenPhaseSteps.length === 0 && newPhaseSteps.length > 0) {
      // Group new phase steps by phase, track their order
      const stepsByPhase = new Map<string, string[]>()
      const phaseOrderMap = new Map<string, number>()
      for (const id of newPhaseSteps) {
        const step = stepById.get(id)
        if (step?.phaseId) {
          const list = stepsByPhase.get(step.phaseId) ?? []
          list.push(id)
          stepsByPhase.set(step.phaseId, list)
          // Track phase order (use Infinity for null/undefined to sort last)
          if (!phaseOrderMap.has(step.phaseId)) {
            phaseOrderMap.set(step.phaseId, step.phaseOrder ?? Infinity)
          }
        }
      }

      // Pick the phase with lowest order
      const phases = [...stepsByPhase.keys()].sort((a, b) => {
        const orderA = phaseOrderMap.get(a) ?? Infinity
        const orderB = phaseOrderMap.get(b) ?? Infinity
        return orderA - orderB
      })
      const firstPhase = phases[0]
      if (firstPhase) {
        const stepsToPlace = stepsByPhase.get(firstPhase) ?? []
        toPlace.push(...stepsToPlace)
      }
    }

    // Place steps
    for (const id of toPlace) {
      stepColumns.set(id, column)
      placed.add(id)
      pending.delete(id)
      const step = stepById.get(id)
      if (step?.phaseId) {
        seenPhases.add(step.phaseId)
      }
    }

    column++
  }

  return stepColumns
}
