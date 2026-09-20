import { Construct } from "constructs"
import type { OrgUnit } from "./org-unit"
import { normalizePath } from "./org-utils"
import type { Role } from "./role"

/**
 * Renderer types built into the frontend stats route.
 * Orgs reference these by name; the frontend maps them to React components.
 */
export type StatsViewRenderer = "timeline"

/**
 * Props for creating a StatsView construct.
 */
export interface StatsViewProps {
  /** Display name for the stats view */
  readonly name: string
  /** Optional description of what this stats view shows */
  readonly purpose?: string
  /** Roles allowed to access this stats view. Must not be empty. */
  readonly roles: readonly [Role, ...Role[]]
  /**
   * The built-in renderer type the frontend should use.
   * The frontend maps this to a React component (e.g. "timeline" → JourneyTimeline).
   */
  readonly renderer: StatsViewRenderer
  /**
   * The GraphQL query name that returns the stats data.
   * This query must be provided by the org's CustomGraphqlSchema.
   */
  readonly queryName: string
}

/**
 * Stats view construct for defining custom analytics/visualization screens.
 *
 * StatsViews are organizational-level custom data views that provide
 * visualizations beyond the standard list/table model. They are:
 * - Discovered by the frontend via the `availableStatsViews` GraphQL query
 * - Rendered at `/stats/<path>` in the frontend
 * - Backed by a custom GraphQL query from the org's `CustomGraphqlSchema`
 *
 * Unlike `List`, StatsView does not generate its own GraphQL schema —
 * the org is responsible for providing the query via `CustomGraphqlSchema`.
 * StatsView only carries metadata (name, renderer type, query name, roles)
 * that the frontend uses to discover and render the view.
 *
 * @example
 * ```typescript
 * new StatsView(org, "enrolment-journeys", {
 *   name: "Enrolment Journeys",
 *   purpose: "See how quickly enrolments move through the pipeline",
 *   roles: [officeStaff],
 *   renderer: "timeline",
 *   queryName: "timelineAllEnrolmentEnquiries",
 * })
 * ```
 */
export class StatsView extends Construct {
  readonly isStatsView: true = true
  /** Display name for the stats view */
  readonly name: string

  /** Optional description of what this stats view shows */
  readonly purpose?: string

  /** Roles allowed to access this stats view */
  readonly roles: readonly [Role, ...Role[]]

  /** Built-in renderer type the frontend should use */
  readonly renderer: StatsViewRenderer

  /** GraphQL query name that returns the stats data */
  readonly queryName: string

  constructor(scope: OrgUnit, id: string, props: StatsViewProps) {
    super(scope, id)
    this.name = props.name
    if (props.purpose !== undefined) {
      this.purpose = props.purpose
    }
    if (props.roles.length === 0) {
      throw new Error(
        `StatsView ${normalizePath(this.node.path)} requires at least one role`,
      )
    }
    this.roles = props.roles
    this.renderer = props.renderer
    this.queryName = props.queryName
  }
}
