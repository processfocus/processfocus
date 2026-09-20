import type { SqlError } from "@effect/sql/SqlError"
import { Context, type Effect } from "effect"

/**
 * Represents a flow record from the database.
 * A flow defines a transition from one step to another in a process.
 */
export interface FlowRow {
  /** Unique identifier for this flow */
  readonly id: string
  /** ID of the step where this flow originates */
  readonly sourceStepId: string
  /** ID of the step where this flow leads to */
  readonly targetStepId: string
}

/**
 * Service providing flow query operations.
 */
export class FlowQueries extends Context.Tag(
  "@pf/graphql-db-operations/FlowQueries",
)<
  FlowQueries,
  {
    /**
     * Query all flows that originate from a given step (by step ID).
     * These are the flows where source_step equals the given step ID.
     */
    readonly queryFlowsBySourceStepId: (
      stepId: string,
    ) => Effect.Effect<readonly FlowRow[], SqlError>
  }
>() {}
