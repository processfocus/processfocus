import { Construct } from "constructs"
import type { Schema } from "effect"
import DirectedGraph from "graphology"
import type { DayOfMonth, TimeOfDay } from "@pf/business-calendar"
import type { FlattenFields } from "@pf/form-submission-schema"
import { isForm } from "./brands"
import type {
  CamelCase,
  FlowContext,
  FormStepMeta,
  StepMeta,
} from "./flow-context"
import { type FlowPath, wrapInFlowPath } from "./flow-path"
import type { Form } from "./form"
import type { OrgUnit } from "./org-unit"
import { pathToPascalCase } from "./org-utils"
import type { Role } from "./role"
import type { ScheduledTime } from "./schedule"
import type { SlaConfig } from "./sla"
import type { Step } from "./step"

export interface ProcessResponsibility {
  readonly role: Role
  readonly responsibility: string
}

/**
 * Use lowercase weekday strings for process cron config so org definitions and
 * JSON manifests stay ergonomic and stable across serialisation boundaries.
 */
export type CronWeekday =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"

export interface DailyProcessCron {
  readonly type: "daily"
  readonly at: TimeOfDay
  readonly timeZone?: string | undefined
}

export interface HourlyProcessCron {
  readonly type: "hourly"
  readonly minute: number
  readonly timeZone?: string | undefined
}

export interface WeeklyProcessCron {
  readonly type: "weekly"
  readonly weekday: CronWeekday
  readonly at: TimeOfDay
  readonly timeZone?: string | undefined
}

export interface MonthlyProcessCron {
  readonly type: "monthly"
  readonly dayOfMonth: DayOfMonth
  readonly at: TimeOfDay
  readonly timeZone?: string | undefined
}

export type ProcessCron =
  | HourlyProcessCron
  | DailyProcessCron
  | WeeklyProcessCron
  | MonthlyProcessCron

export interface ProcessProps {
  /**
   * Name of process.
   */
  readonly name: string

  /**
   * Purpose of process.
   */
  readonly purpose: string

  /**
   * Optional path to a Markdown document that explains how to operate this process.
   * Relative paths are resolved from the organisation root.
   */
  readonly documentationPath?: string | undefined

  /**
   * Description of responsibilities of each roles in the process.
   * Shown in the process flow.
   *
   * Determines the ordering of swimlanes when set.
   */
  readonly responsibilities?: ProcessResponsibility[]

  /**
   * Optional SLA (Service Level Agreement) for the overall process.
   * Specifies the maximum duration for the process to complete,
   * measured in business calendar time.
   */
  readonly sla?: SlaConfig

  /**
   * Optional deploy-time recurring start metadata.
   * Only supported for processes with exactly one system start step.
   */
  readonly cron?: ProcessCron
}

/**
 * Condition function type for flow edges.
 * The optional second parameter provides access to completed step metadata.
 *
 * @typeParam TState - Accumulated state type from completed steps
 * @typeParam TSteps - Record of completed step metadata (optional)
 */
export type Condition<
  TState,
  TSteps extends Record<string, StepMeta> = Record<string, never>,
> = (state: TState, ctx?: FlowContext<TSteps>) => boolean

/**
 * Schedule function type for flow edges.
 * Returns a ScheduledTime indicating when the transition should trigger.
 *
 * @param state - Accumulated state from completed steps
 * @param ctx - Flow context with completed step metadata (e.g., completedAt times)
 * @typeParam TState - Accumulated state type from completed steps
 * @typeParam TSteps - Record of completed step metadata
 */
export type ScheduleFn<
  TState,
  TSteps extends Record<string, StepMeta> = Record<string, never>,
> = (state: TState, ctx: FlowContext<TSteps>) => ScheduledTime

export interface EdgeAttributes<TState> {
  condition?: Condition<TState> | undefined
  conditionText?: string | undefined
  // biome-ignore lint/suspicious/noExplicitAny: TSteps is erased at runtime; schedule stored for evaluation later
  schedule?: ScheduleFn<TState, any> | undefined
  scheduleText?: string | undefined
  isEndStep?: boolean
  isElse?: boolean
  isOnError?: boolean
  taggedErrors?: readonly string[]
}

/**
 * Concrete graph node type for serialization/deserialization.
 * Represents a Step with generic state and input types.
 */
export type GraphNode = Step<
  Record<string, unknown>,
  Schema.Struct.Fields | undefined
>

/**
 * Concrete graph edge type for serialization/deserialization.
 * Represents an edge with unknown state type.
 */
export type GraphEdge = EdgeAttributes<unknown>

/**
 * Base interface for anything that can provide access to a Process.
 * Both Process and Step implement this interface.
 */
export interface IProcessHolder {
  readonly process: Process
}

// Type utility to infer the output type from Effect Schema fields
export type InferSchemaType<T extends Schema.Struct.Fields | undefined> =
  T extends Schema.Struct.Fields
    ? Schema.Schema.Type<ReturnType<typeof Schema.Struct<T>>>
    : object

// Type utility for Form steps: infer the flat submission type (wrappers removed)
export type InferFormSchemaType<T extends Schema.Struct.Fields | undefined> =
  T extends Schema.Struct.Fields
    ? FlattenFields<T> extends infer F extends Schema.Struct.Fields
      ? Schema.Schema.Type<ReturnType<typeof Schema.Struct<F>>>
      : object
    : object

// Resolve the correct state contribution type based on whether step is a Form.
// Form steps use flattened submission types (wrappers removed from state).
// Non-form steps use the raw schema type as-is.
export type ResolveStepOutput<
  TOutput extends Schema.Struct.Fields | undefined,
  TIsForm extends boolean,
> = TIsForm extends true
  ? InferFormSchemaType<TOutput>
  : InferSchemaType<TOutput>

// pathToPascalCase is imported from ./org-utils

export class Process extends Construct implements IProcessHolder {
  static readonly START_NODE = "__start__"
  static readonly END_NODE = "__end__"

  readonly isProcess: true = true

  /**
   * Returns true if the node ID is a virtual node (__start__ or __end__).
   */
  static isVirtualNode(nodeId: string): boolean {
    return nodeId === Process.START_NODE || nodeId === Process.END_NODE
  }

  private readonly graph: DirectedGraph
  /**
   * Reference to this Process instance, allowing Process to be used
   * as a scope when creating Steps.
   */
  public readonly process: Process
  public readonly props: ProcessProps
  public readonly orgUnit: OrgUnit

  constructor(scope: OrgUnit, id: string, props: ProcessProps) {
    super(scope, id)
    this.graph = new DirectedGraph({ multi: true, type: "directed" })
    this.graph.addNode(Process.START_NODE)
    this.graph.addNode(Process.END_NODE)
    this.process = this
    this.props = props
    this.orgUnit = scope

    // Validate no duplicate roles in responsibilities
    if (props.responsibilities) {
      const rolePaths = new Set<string>()
      for (const resp of props.responsibilities) {
        const rolePath = resp.role.node.path
        if (rolePaths.has(rolePath)) {
          throw new Error(
            `Duplicate role "${resp.role.name}" in responsibilities for process "${props.name}"`,
          )
        }
        rolePaths.add(rolePath)
      }
    }
  }

  /**
   * Returns the GraphQL mutation name for starting this process.
   * Example: "engineering/bug-report-fix" -> "startEngineeringBugReportFix"
   */
  startMutationName(): string {
    return `start${pathToPascalCase(this.node.path)}`
  }

  start<
    TInitialState,
    TOutput extends Schema.Struct.Fields | undefined,
    TId extends string,
    TIsForm extends boolean = false,
  >(
    initialStep: Step<TInitialState, TOutput, TId, TIsForm, boolean>,
  ): FlowPath<
    ResolveStepOutput<TOutput, TIsForm>,
    TOutput,
    TIsForm extends true
      ? { [K in CamelCase<TId>]: FormStepMeta }
      : { [K in CamelCase<TId>]: StepMeta }
  > {
    this.graph.addDirectedEdge(Process.START_NODE, initialStep.node.path)
    return wrapInFlowPath(
      initialStep as Step<
        ResolveStepOutput<TOutput, TIsForm>,
        TOutput,
        TId,
        TIsForm,
        boolean
      >,
      this,
    )
  }

  addEndEdge<
    TState = Record<string, never>,
    TOutput extends Schema.Struct.Fields | undefined = undefined,
    TIsForm extends boolean = boolean,
  >(step: Step<TState, TOutput, string, TIsForm, boolean>): void {
    const stepPath = step.node.path
    if (this.graph.hasDirectedEdge(stepPath, Process.END_NODE)) {
      throw new Error(`Step "${stepPath}" already has .end() called`)
    }
    this.graph.addDirectedEdge(stepPath, Process.END_NODE)
  }

  /**
   * Adds an else edge to the __end__ node.
   * This is followed ONLY if NO conditional edges from the step match.
   */
  addElseEndEdge<
    TState = Record<string, never>,
    TOutput extends Schema.Struct.Fields | undefined = undefined,
    TIsForm extends boolean = boolean,
  >(step: Step<TState, TOutput, string, TIsForm, boolean>): void {
    const stepPath = step.node.path
    // Check if an else edge to END already exists
    const existingEdges = this.graph.outEdges(stepPath) ?? []
    for (const edge of existingEdges) {
      if (this.graph.target(edge) === Process.END_NODE) {
        const attrs = this.graph.getEdgeAttributes(
          edge,
        ) as EdgeAttributes<TState>
        if (attrs.isElse) {
          throw new Error(`Step "${stepPath}" already has .elseEnd() called`)
        }
      }
    }
    this.graph.addDirectedEdge(stepPath, Process.END_NODE, { isElse: true })
  }

  /**
   * Validates process flows and returns problematic step paths.
   * Checks for:
   * - Dangling steps: no outgoing edges (missing .end())
   * - Unreachable steps: not reachable from start
   * - Missing else branches: steps with conditional edges but no else branch
   * - Multiple else branches: steps with more than one else edge
   * - Orphan else branches: steps with else edge but no conditional edges
   *
   * @returns Object with separate arrays for unreachable, dangling, missingElse, multipleElse, and orphanElse steps
   */
  validateFlows(): {
    unreachable: string[]
    dangling: string[]
    missingElse: string[]
    multipleElse: string[]
    orphanElse: string[]
  } {
    // Find all nodes reachable from __start__
    const reachable = new Set<string>()
    const queue = [Process.START_NODE]
    while (queue.length > 0) {
      const nodeId = queue.pop()
      if (nodeId === undefined || reachable.has(nodeId)) continue
      reachable.add(nodeId)
      for (const neighbor of this.graph.outNeighbors(nodeId)) {
        queue.push(neighbor)
      }
    }

    const unreachable: string[] = []
    const dangling: string[] = []
    const missingElse: string[] = []
    const multipleElse: string[] = []
    const orphanElse: string[] = []

    for (const nodeId of this.realNodes()) {
      if (!reachable.has(nodeId)) {
        unreachable.push(nodeId)
      } else if (this.graph.outDegree(nodeId) === 0) {
        dangling.push(nodeId)
      } else {
        // Check for conditional edges and else branches
        const outEdges = this.graph.outEdges(nodeId) ?? []
        let hasConditional = false
        let elseCount = 0

        for (const edge of outEdges) {
          const attrs = this.graph.getEdgeAttributes(
            edge,
          ) as EdgeAttributes<unknown>
          if (attrs.condition) {
            hasConditional = true
          }
          if (attrs.isElse) {
            elseCount++
          }
        }

        // If there are conditional edges, there must be exactly one else edge
        if (hasConditional) {
          if (elseCount === 0) {
            missingElse.push(nodeId)
          } else if (elseCount > 1) {
            multipleElse.push(nodeId)
          }
        } else if (elseCount > 0) {
          // Else edge without any conditional edges is invalid
          orphanElse.push(nodeId)
        }
      }
    }
    return { unreachable, dangling, missingElse, multipleElse, orphanElse }
  }

  /**
   * Returns steps connected from __start__ (hides graph implementation).
   * @returns Array of start steps for this process
   */
  startNodes(): Step<
    Record<string, unknown>,
    Schema.Struct.Fields | undefined,
    string,
    boolean,
    boolean
  >[] {
    return this.graph
      .outNeighbors(Process.START_NODE)
      .map(
        (nodeId) =>
          this.graph.getNodeAttributes(nodeId) as Step<
            Record<string, unknown>,
            Schema.Struct.Fields | undefined,
            string,
            boolean,
            boolean
          >,
      )
  }

  getGraph(): DirectedGraph {
    return this.graph
  }

  /**
   * Returns all real (non-virtual) node IDs in the process graph.
   * Filters out __start__ and __end__ nodes.
   */
  realNodes(): string[] {
    return this.graph.nodes().filter((id) => !Process.isVirtualNode(id))
  }

  addNode<
    TState = Record<string, never>,
    TOutput extends Schema.Struct.Fields | undefined = undefined,
    TIsForm extends boolean = boolean,
  >(step: Step<TState, TOutput, string, TIsForm, boolean>): void {
    const id = step.node.path
    if (!this.graph.hasNode(id)) {
      this.graph.addNode(id, step)
    }
  }

  addEdge<
    TSourceState = Record<string, never>,
    TSourceOutput extends Schema.Struct.Fields | undefined = undefined,
    TSourceIsForm extends boolean = boolean,
    TDestState = Record<string, never>,
    TDestOutput extends Schema.Struct.Fields | undefined = undefined,
    TDestIsForm extends boolean = boolean,
  >(
    source: Step<TSourceState, TSourceOutput, string, TSourceIsForm, boolean>,
    dest: Step<TDestState, TDestOutput, string, TDestIsForm, boolean>,
    attributes?: EdgeAttributes<TSourceState>,
  ): void {
    const source_id = source.node.path
    const dest_id = dest.node.path

    const existingParallelEdges = (this.graph.outEdges(source_id) ?? []).filter(
      (edge) => this.graph.target(edge) === dest_id,
    )

    // Allow onError edges to coexist with normal edges and with each other so
    // authors can model duplicate recovery fanout, including intentionally
    // identical tagged recovery branches to the same target. Keep normal
    // branches single-edge per source/target pair to avoid ambiguous
    // condition/schedule lookups in the runtime evaluator.
    if (
      attributes?.isOnError !== true &&
      existingParallelEdges.some(
        (edge) =>
          (this.graph.getEdgeAttributes(edge) as EdgeAttributes<TSourceState>)
            .isOnError !== true,
      )
    ) {
      throw new Error(`Flow from "${source_id}" to "${dest_id}" already exists`)
    }

    this.graph.addDirectedEdge(source_id, dest_id, attributes)
  }

  /** Get all Form steps in this process. */
  forms(): Array<{
    form: Form<
      Record<string, unknown>,
      Record<string, StepMeta>,
      Schema.Struct.Fields
    >
    path: string
  }> {
    const result: Array<{
      form: Form<
        Record<string, unknown>,
        Record<string, StepMeta>,
        Schema.Struct.Fields
      >
      path: string
    }> = []

    for (const nodeId of this.graph.nodes()) {
      const step = this.graph.getNodeAttributes(nodeId) as unknown
      if (isForm(step)) {
        result.push({
          form: step as unknown as Form<
            Record<string, unknown>,
            Record<string, StepMeta>,
            Schema.Struct.Fields
          >,
          path: nodeId,
        })
      }
    }

    return result
  }
}
