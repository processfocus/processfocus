import { Schema } from "effect"

const text = Schema.String.pipe(Schema.check(Schema.isMinLength(1)))
export const ProjectWorkloadPermissionSchema = Schema.Literals([
  "deploy",
  "database-download",
  "database-upload",
  "create-environment",
  "destroy-environment",
])

export type ProjectWorkloadPermission =
  typeof ProjectWorkloadPermissionSchema.Type

/** Runtime-owned OAuth client data. Organisation import must preserve this owner. */
export const ProjectWorkloadSchema = Schema.Struct({
  owner: Schema.Literal("project"),
  // Historical registration metadata is retained on read/write; never grants authority.
  providerUserId: Schema.optional(text),
  providerUserEmail: Schema.optional(text),
  projectId: text,
  name: text,
  targetIssuer: text,
  assertionAudience: text,
  repository: text,
  ref: text,
  workflowRef: text,
  environment: Schema.optional(text),
  events: Schema.Array(
    Schema.Literals(["push", "workflow_dispatch", "schedule"]),
  ),
  permissions: Schema.Array(ProjectWorkloadPermissionSchema),
  enabled: Schema.Boolean,
  identity: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("pending"),
      enrollmentAudience: text,
    }),
    Schema.Struct({
      kind: Schema.Literal("enrolled"),
      repositoryId: text,
      repositoryOwnerId: text,
    }),
  ]),
})

export type ProjectWorkload = Schema.Schema.Type<typeof ProjectWorkloadSchema>
