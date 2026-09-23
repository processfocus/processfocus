import { sql } from "drizzle-orm"
import { relations } from "drizzle-orm/_relations"
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import { check, customType, index, integer, sqliteTable, sqliteView, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { DateTime } from "effect"
import { ulid } from "ulidx"

// Generated from Xplain DDL: schema.ddl
// Auto-generated - DO NOT EDIT

// Custom type for case-insensitive text columns (SQLite COLLATE NOCASE)
// Note: COLLATE NOCASE is ASCII-only case folding
const citextColumn = customType<{ data: string; driverData: string }>({
  dataType() {
    return "text collate nocase"
  },
})

// Custom type for JSON columns
const jsonColumn = customType<{ data: Record<string, unknown> | unknown[]; driverData: string | null }>({
  dataType() {
    return "text"
  },
  toDriver(value: Record<string, unknown> | unknown[]): string {
    return JSON.stringify(value)
  },
  fromDriver(value: string | null): Record<string, unknown> | unknown[] {
    return value == null ? {} : JSON.parse(value)
  },
})

// Custom type for Effect DateTime columns
const effectDateTime = customType<{ data: DateTime.Utc; driverData: number }>({
  dataType() {
    return "real"
  },
  toDriver(value: DateTime.Utc): number {
    const millis = DateTime.toEpochMillis(value)
    return millis / 86400000 + 2440587.5
  },
  // Warning: value can be undefined when using findFirst and no row exists
  fromDriver(value: number): DateTime.Utc {
    const millis = (value - 2440587.5) * 86400000
    return DateTime.unsafeMake(millis)
  },
})

export const orgUnit = sqliteTable("pf_org_unit", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `ou-${ulid()}`),
  name: citextColumn("name").notNull(),
  orgUnitLevel: text("org_unit_level", { length: 64 }).notNull(),
  parentOrgUnitId: text("parent_org_unit", { length: 41 }).references((): AnySQLiteColumn => orgUnit.id),
  path: text("path", { length: 2048 }).notNull(),
  acronym: citextColumn("acronym"),
  timezone: text("timezone", { length: 64 }).notNull().default("UTC"),
  startDayOfWeek: integer("start_day_of_week").default(0),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  pathidxIdx: uniqueIndex("pf_org_unit_pathidx_idx").on(table.path).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_org_unit_updated_at_id_idx").on(table.updatedAt, table.id),
  nameLengthCheck: check("name_length_check", sql.raw(`length("pf_org_unit"."name") <= 1024`)),
  acronymLengthCheck: check("acronym_length_check", sql.raw(`length("pf_org_unit"."acronym") <= 64`)),
}))

export const process = sqliteTable("pf_process", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `prc-${ulid()}`),
  orgUnitId: text("org_unit_id", { length: 41 }).notNull().references(() => orgUnit.id),
  name: citextColumn("name").notNull(),
  path: text("path", { length: 2048 }).notNull(),
  purpose: citextColumn("purpose").notNull(),
  slaValue: integer("sla_value"),
  slaUnit: text("sla_unit", { length: 16 }),
  slaWarning: integer("sla_warning"),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  pathidxIdx: uniqueIndex("pf_process_pathidx_idx").on(table.path).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_process_updated_at_id_idx").on(table.updatedAt, table.id),
  nameLengthCheck: check("name_length_check", sql.raw(`length("pf_process"."name") <= 1024`)),
}))

export const role = sqliteTable("pf_role", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `role-${ulid()}`),
  orgUnitId: text("org_unit_id", { length: 41 }).notNull().references(() => orgUnit.id),
  name: citextColumn("name").notNull(),
  path: text("path", { length: 2048 }).notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  pathidxIdx: uniqueIndex("pf_role_pathidx_idx").on(table.path).where(sql`_deleted = 0`),
  orgunitunameidxIdx: uniqueIndex("pf_role_orgunitunameidx_idx").on(table.orgUnitId, table.name).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_role_updated_at_id_idx").on(table.updatedAt, table.id),
  nameLengthCheck: check("name_length_check", sql.raw(`length("pf_role"."name") <= 1024`)),
}))

export const phase = sqliteTable("pf_phase", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `ph-${ulid()}`),
  processId: text("process_id", { length: 41 }).notNull().references(() => process.id),
  name: citextColumn("name").notNull(),
  path: text("path", { length: 2048 }).notNull(),
  phaseOrder: integer("phase_order").notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  pathidxIdx: uniqueIndex("pf_phase_pathidx_idx").on(table.path).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_phase_updated_at_id_idx").on(table.updatedAt, table.id),
  nameLengthCheck: check("name_length_check", sql.raw(`length("pf_phase"."name") <= 1024`)),
}))

export const roleResponsibility = sqliteTable("pf_role_responsibility", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `rr-${ulid()}`),
  processId: text("process_id", { length: 41 }).notNull().references(() => process.id),
  roleId: text("role_id", { length: 41 }).notNull().references(() => role.id),
  responsibility: citextColumn("responsibility").notNull(),
  responsibilityOrder: integer("responsibility_order").notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  processroleidxIdx: uniqueIndex("pf_role_responsibility_processroleidx_idx").on(table.processId, table.roleId).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_role_responsibility_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const step = sqliteTable("pf_step", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `step-${ulid()}`),
  name: citextColumn("name").notNull(),
  path: text("path", { length: 2048 }).notNull(),
  purpose: citextColumn("purpose").notNull(),
  processId: text("process_id", { length: 41 }).notNull().references(() => process.id),
  roleId: text("role_id", { length: 41 }).references(() => role.id),
  formFields: integer("form_fields"),
  phaseId: text("phase_id", { length: 41 }).references(() => phase.id),
  slaValue: integer("sla_value"),
  slaUnit: text("sla_unit", { length: 16 }),
  slaWarning: integer("sla_warning"),
  hasForEach: integer("has_for_each", { mode: "boolean" }).notNull().default(false),
  embedded: integer("embedded", { mode: "boolean" }).notNull().default(false),
  retryLimit: integer("retry_limit"),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  pathidxIdx: uniqueIndex("pf_step_pathidx_idx").on(table.path).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_step_updated_at_id_idx").on(table.updatedAt, table.id),
  nameLengthCheck: check("name_length_check", sql.raw(`length("pf_step"."name") <= 1024`)),
}))

export const stepSupportingRole = sqliteTable("pf_step_supporting_role", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `ssr-${ulid()}`),
  stepId: text("step_id", { length: 41 }).notNull().references(() => step.id),
  roleId: text("role_id", { length: 41 }).notNull().references(() => role.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  steproleidxIdx: uniqueIndex("pf_step_supporting_role_steproleidx_idx").on(table.stepId, table.roleId).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_step_supporting_role_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const flow = sqliteTable("pf_flow", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `flow-${ulid()}`),
  flowKey: text("flow_key", { length: 128 }).notNull(),
  sourceStepId: text("source_step", { length: 41 }).notNull().references(() => step.id),
  targetStepId: text("target_step", { length: 41 }).notNull().references(() => step.id),
  condition: citextColumn("condition"),
  schedule: citextColumn("schedule"),
  fallbackBranch: integer("fallback_branch", { mode: "boolean" }).notNull().default(false),
  errorBranch: integer("error_branch", { mode: "boolean" }).notNull().default(false),
  errorTags: jsonColumn("error_tags"),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  sourcetargetidxIdx: index("pf_flow_sourcetargetidx_idx").on(table.sourceStepId, table.targetStepId).where(sql`_deleted = 0`),
  flowkeyidxIdx: uniqueIndex("pf_flow_flowkeyidx_idx").on(table.flowKey).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_flow_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const externalParticipant = sqliteTable("pf_external_participant", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `xp-${ulid()}`),
  email: text("email", { length: 320 }).notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  emailidxIdx: uniqueIndex("pf_external_participant_emailidx_idx").on(table.email).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_external_participant_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const processState = sqliteTable("pf_process_state", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `pst-${ulid()}`),
  processId: text("process_id", { length: 41 }).notNull().references(() => process.id),
  startStepId: text("start_step", { length: 41 }).notNull().references(() => step.id),
  state: jsonColumn("state").notNull(),
  startedByUserId: text("started_by_user", { length: 41 }).references(() => user.id),
  startedByExternalParticipantId: text("started_by_external_participant", { length: 41 }).references(() => externalParticipant.id),
  startedByRoleId: text("started_by_role", { length: 41 }).references(() => role.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  updatedAtIdIdx: index("pf_process_state_updated_at_id_idx").on(table.updatedAt, table.id),
  singleStarterCheck: check("single_starter_check", sql`${table.startedByUserId} is null or ${table.startedByExternalParticipantId} is null`),
}))

export const processExecution = sqliteTable("pf_process_execution", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `pex-${ulid()}`),
  withoutWaiting: integer("without_waiting", { mode: "boolean" }).notNull().default(false),
  processStateId: text("process_state_id", { length: 41 }).notNull().references(() => processState.id),
  finishedAt: effectDateTime("finished_at"),
  businessDuration: integer("business_duration"),
  abandonedAt: effectDateTime("abandoned_at"),
  abandonedReason: citextColumn("abandoned_reason"),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  updatedAtIdIdx: index("pf_process_execution_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const toDo = sqliteTable("pf_to_do", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `todo-${ulid()}`),
  processExecutionId: text("process_execution_id", { length: 41 }).notNull().references(() => processExecution.id),
  flowId: text("flow_id", { length: 41 }).notNull().references(() => flow.id),
  completedByUserId: text("completed_by_user", { length: 41 }).references(() => user.id),
  completedByExternalParticipantId: text("completed_by_external_participant", { length: 41 }).references(() => externalParticipant.id),
  assignedToProviderUserId: text("assigned_to_provider_user", { length: 41 }).references(() => providerUser.id),
  businessDuration: integer("business_duration"),
  slaTargetAt: effectDateTime("sla_target_at"),
  slaWarningAt: effectDateTime("sla_warning_at"),
  failureReason: citextColumn("failure_reason"),
  correctionRequiredAt: effectDateTime("correction_required_at"),
  correctionFailureReason: citextColumn("correction_failure_reason"),
  correctionInvitationAttemptId: text("correction_invitation_attempt_id", { length: 41 }),
  itemData: jsonColumn("item_data"),
  barrierScheduledFlowId: text("barrier_scheduled_flow_id", { length: 41 }),
  completedByRoleId: text("completed_by_role", { length: 41 }).references(() => role.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  updatedAtIdIdx: index("pf_to_do_updated_at_id_idx").on(table.updatedAt, table.id),
  singleCompleterCheck: check("single_completer_check", sql`${table.completedByUserId} is null or ${table.completedByExternalParticipantId} is null`),
}))

export const publicCompletionInvitationAttempt = sqliteTable("pf_public_completion_invitation_attempt", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `pcia-${ulid()}`),
  toDoId: text("to_do_id", { length: 41 }).notNull().references(() => toDo.id),
  email: text("email", { length: 320 }).notNull(),
  providerMessageId: text("provider_message_id", { length: 256 }),
  providerSentTo: citextColumn("provider_sent_to"),
  deliveryStatus: text("delivery_status", { length: 32 }),
  deliveryEventId: text("delivery_event_id", { length: 256 }),
  deliveryFailureKind: text("delivery_failure_kind", { length: 64 }),
  deliveryFailureReason: citextColumn("delivery_failure_reason"),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  todoidxIdx: index("pf_public_completion_invitation_attempt_todoidx_idx").on(table.toDoId).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_public_completion_invitation_attempt_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const scheduledFlow = sqliteTable("pf_scheduled_flow", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `sf-${ulid()}`),
  processExecutionId: text("process_execution_id", { length: 41 }).notNull().references(() => processExecution.id),
  sourceStepId: text("source_step", { length: 41 }).notNull().references(() => step.id),
  targetStepId: text("target_step", { length: 41 }).references(() => step.id),
  scheduledAt: effectDateTime("scheduled_at"),
  forEachBarrier: integer("for_each_barrier", { mode: "boolean" }).notNull().default(false),
  completedByRoleId: text("completed_by_role", { length: 41 }).references(() => role.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  updatedAtIdIdx: index("pf_scheduled_flow_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const user = sqliteTable("pf_user", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `usr-${ulid()}`),
  provider: text("provider", { length: 128 }).notNull(),
  sub: text("sub", { length: 256 }).notNull(),
  lastLoggedIn: effectDateTime("last_logged_in").notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  uniquesubIdx: uniqueIndex("pf_user_uniquesub_idx").on(table.provider, table.sub).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_user_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const passkeyCredential = sqliteTable("pf_passkey_credential", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `pkc-${ulid()}`),
  userId: text("user_id", { length: 41 }).notNull().references(() => user.id),
  passkeyCredentialId: text("passkey_credential_id", { length: 2048 }).notNull(),
  passkeyPublicKey: text("passkey_public_key", { length: 2048 }).notNull(),
  signatureCounter: text("signature_counter", { length: 16 }).notNull(),
  passkeyTransports: jsonColumn("passkey_transports"),
  passkeyName: text("passkey_name", { length: 128 }),
  passkeyLastUsedAt: effectDateTime("passkey_last_used_at"),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  credentialidxIdx: uniqueIndex("pf_passkey_credential_credentialidx_idx").on(table.passkeyCredentialId).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_passkey_credential_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const providerUser = sqliteTable("pf_provider_user", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `pu-${ulid()}`),
  userId: text("user_id", { length: 41 }).notNull().references(() => user.id),
  email: text("email", { length: 320 }).notNull(),
  name: citextColumn("name").notNull(),
  firstName: citextColumn("first_name").notNull(),
  lastName: citextColumn("last_name").notNull(),
  picture: text("picture", { length: 1024 }).notNull(),
  locale: text("locale", { length: 35 }).notNull(),
  orgUnitId: text("org_unit_id", { length: 41 }).notNull().references(() => orgUnit.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  emailidxIdx: uniqueIndex("pf_provider_user_emailidx_idx").on(table.email).where(sql`_deleted = 0`),
  userUniqueIdx: uniqueIndex("pf_provider_user_user_unique_idx").on(table.userId).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_provider_user_updated_at_id_idx").on(table.updatedAt, table.id),
  nameLengthCheck: check("name_length_check", sql.raw(`length("pf_provider_user"."name") <= 1024`)),
  firstNameLengthCheck: check("first_name_length_check", sql.raw(`length("pf_provider_user"."first_name") <= 128`)),
  lastNameLengthCheck: check("last_name_length_check", sql.raw(`length("pf_provider_user"."last_name") <= 128`)),
}))

export const delegation = sqliteTable("pf_delegation", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `dlg-${ulid()}`),
  ownerProviderUserId: text("owner_provider_user", { length: 41 }).notNull().references(() => providerUser.id),
  delegationName: text("delegation_name", { length: 128 }).notNull(),
  activeDelegationName: text("active_delegation_name", { length: 128 }),
  secretRevokedAt: effectDateTime("secret_revoked_at"),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  ownernameidxIdx: uniqueIndex("pf_delegation_ownernameidx_idx").on(table.ownerProviderUserId, table.activeDelegationName).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_delegation_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const secretGeneration = sqliteTable("pf_secret_generation", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `dsg-${ulid()}`),
  delegationId: text("delegation_id", { length: 41 }).notNull().references(() => delegation.id),
  secretVerifier: text("secret_verifier", { length: 64 }).notNull(),
  secretIssuedAt: effectDateTime("secret_issued_at").notNull(),
  secretExpiresAt: effectDateTime("secret_expires_at").notNull(),
  secretRevokedAt: effectDateTime("secret_revoked_at"),
  secretLastUsedAt: effectDateTime("secret_last_used_at"),
  parentSecretGenerationId: text("parent_secret_generation", { length: 41 }).references((): AnySQLiteColumn => secretGeneration.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  delegationidxIdx: index("pf_secret_generation_delegationidx_idx").on(table.delegationId).where(sql`_deleted = 0`),
  verifieridxIdx: uniqueIndex("pf_secret_generation_verifieridx_idx").on(table.secretVerifier).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_secret_generation_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const delegationHistory = sqliteTable("pf_delegation_history", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `dgh-${ulid()}`),
  delegationId: text("delegation_id", { length: 41 }).notNull().references(() => delegation.id),
  secretGenerationId: text("secret_generation_id", { length: 41 }).notNull().references(() => secretGeneration.id),
  actorProviderUserId: text("actor_provider_user", { length: 41 }).notNull().references(() => providerUser.id),
  delegationEvent: text("delegation_event", { length: 32 }).notNull(),
  secretIssuedAt: effectDateTime("secret_issued_at").notNull(),
  oldDelegationName: text("old_delegation_name", { length: 128 }),
  newDelegationName: text("new_delegation_name", { length: 128 }),
  actorDelegationId: text("actor_delegation", { length: 41 }).references(() => delegation.id),
  actorSecretGenerationId: text("actor_secret_generation", { length: 41 }).references(() => secretGeneration.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  updatedAtIdIdx: index("pf_delegation_history_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const providerUserRole = sqliteTable("pf_provider_user_role", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `pur-${ulid()}`),
  providerUserId: text("provider_user_id", { length: 41 }).notNull().references(() => providerUser.id),
  roleId: text("role_id", { length: 41 }).notNull().references(() => role.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  provideruserroleidxIdx: uniqueIndex("pf_provider_user_role_provideruserroleidx_idx").on(table.providerUserId, table.roleId).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_provider_user_role_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const userSettings = sqliteTable("pf_user_settings", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `us-${ulid()}`),
  userId: text("user_id", { length: 41 }).notNull().references(() => user.id),
  notificationPreference: jsonColumn("notification_preference").notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  userUniqueIdx: uniqueIndex("pf_user_settings_user_unique_idx").on(table.userId).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_user_settings_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const permittedRole = sqliteTable("pf_permitted_role", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `pr-${ulid()}`),
  providerUserId: text("provider_user_id", { length: 41 }).notNull().references(() => providerUser.id),
  roleId: text("role_id", { length: 41 }).notNull().references(() => role.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  provideruserroleidxIdx: uniqueIndex("pf_permitted_role_provideruserroleidx_idx").on(table.providerUserId, table.roleId).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_permitted_role_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const permittedClientRole = sqliteTable("pf_permitted_client_role", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `pcr-${ulid()}`),
  oauthClientId: text("oauth_client_id", { length: 41 }).notNull().references(() => oauthClient.id),
  roleId: text("role_id", { length: 41 }).notNull().references(() => role.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  oauthclientroleidxIdx: uniqueIndex("pf_permitted_client_role_oauthclientroleidx_idx").on(table.oauthClientId, table.roleId).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_permitted_client_role_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const permittedClientEmail = sqliteTable("pf_permitted_client_email", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `pce-${ulid()}`),
  oauthClientId: text("oauth_client_id", { length: 41 }).notNull().references(() => oauthClient.id),
  email: text("email", { length: 320 }).notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  oauthclientemailidxIdx: uniqueIndex("pf_permitted_client_email_oauthclientemailidx_idx").on(table.oauthClientId, table.email).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_permitted_client_email_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const invitation = sqliteTable("pf_invitation", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `inv-${ulid()}`),
  invitationId: text("invitation_id", { length: 128 }).notNull(),
  email: text("email", { length: 320 }).notNull(),
  invitationStatus: text("invitation_status", { length: 32 }).notNull().default("pending"),
  invitationSource: text("invitation_source", { length: 32 }).notNull().default("legacy"),
  invitationPendingEmail: text("invitation_pending_email", { length: 320 }),
  invitationAcceptedAt: effectDateTime("invitation_accepted_at"),
  invitationAcceptedByProvider: text("invitation_accepted_by_provider", { length: 64 }),
  invitationAcceptedBySubject: text("invitation_accepted_by_subject", { length: 256 }),
  acceptedByProviderUserId: text("accepted_by_provider_user", { length: 41 }).references(() => providerUser.id),
  invitationLegacyClosedAt: effectDateTime("invitation_legacy_closed_at"),
  invitationLegacyClosureReason: text("invitation_legacy_closure_reason", { length: 128 }),
  registrationTokenHash: text("registration_token_hash", { length: 64 }),
  registrationEncryptionVersion: integer("registration_encryption_version"),
  registrationEncryptionNonce: text("registration_encryption_nonce", { length: 24 }),
  registrationAuthenticationTag: text("registration_authentication_tag", { length: 32 }),
  registrationEncryptedToken: citextColumn("registration_encrypted_token"),
  registrationLinkExpiresAt: effectDateTime("registration_link_expires_at"),
  registrationLinkGeneratedAt: effectDateTime("registration_link_generated_at"),
  registrationLinkGeneratedBy: text("registration_link_generated_by", { length: 256 }),
  registrationLinkRevealedAt: effectDateTime("registration_link_revealed_at"),
  registrationLinkRevealedBy: text("registration_link_revealed_by", { length: 256 }),
  registrationLinkRevokedAt: effectDateTime("registration_link_revoked_at"),
  registrationLinkRevokedBy: text("registration_link_revoked_by", { length: 256 }),
  registrationLinkGeneration: integer("registration_link_generation"),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  emailidxIdx: index("pf_invitation_emailidx_idx").on(table.email).where(sql`_deleted = 0`),
  statusidxIdx: index("pf_invitation_statusidx_idx").on(table.invitationStatus).where(sql`_deleted = 0`),
  invitationididxIdx: uniqueIndex("pf_invitation_invitationididx_idx").on(table.invitationId).where(sql`_deleted = 0`),
  pendingemailidxIdx: uniqueIndex("pf_invitation_pendingemailidx_idx").on(table.invitationPendingEmail).where(sql`_deleted = 0`),
  registrationtokenhashidxIdx: uniqueIndex("pf_invitation_registrationtokenhashidx_idx").on(table.registrationTokenHash).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_invitation_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const registrationSession = sqliteTable("pf_registration_session", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `rgs-${ulid()}`),
  registrationSessionTokenHash: text("registration_session_token_hash", { length: 64 }).notNull(),
  invitationId: text("invitation_id", { length: 41 }).notNull().references(() => invitation.id),
  registrationLinkGeneration: integer("registration_link_generation").notNull(),
  registrationSessionExpiresAt: effectDateTime("registration_session_expires_at").notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  invitationidxIdx: index("pf_registration_session_invitationidx_idx").on(table.invitationId).where(sql`_deleted = 0`),
  tokenhashidxIdx: uniqueIndex("pf_registration_session_tokenhashidx_idx").on(table.registrationSessionTokenHash).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_registration_session_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const invitationRole = sqliteTable("pf_invitation_role", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `ir-${ulid()}`),
  invitationId: text("invitation_id", { length: 41 }).notNull().references(() => invitation.id),
  roleId: text("role_id", { length: 41 }).notNull().references(() => role.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  invitationroleidxIdx: uniqueIndex("pf_invitation_role_invitationroleidx_idx").on(table.invitationId, table.roleId).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_invitation_role_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const oauthStorage = sqliteTable("pf_oauth_storage", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `oas-${ulid()}`),
  oauthKey: text("oauth_key", { length: 2048 }).notNull(),
  keyKind: text("key_kind", { length: 64 }).notNull(),
  keyValue: jsonColumn("key_value").notNull(),
  keyExpiry: effectDateTime("key_expiry"),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  keyidxIdx: uniqueIndex("pf_oauth_storage_keyidx_idx").on(table.oauthKey),
  updatedAtIdIdx: index("pf_oauth_storage_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const oauthProvider = sqliteTable("pf_oauth_provider", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `opr-${ulid()}`),
  providerName: text("provider_name", { length: 64 }).notNull(),
  providerConfig: jsonColumn("provider_config").notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  nameidxIdx: uniqueIndex("pf_oauth_provider_nameidx_idx").on(table.providerName).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_oauth_provider_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const oauthClient = sqliteTable("pf_oauth_client", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `ocl-${ulid()}`),
  clientId: text("client_id", { length: 128 }).notNull(),
  clientSecretHash: text("client_secret_hash", { length: 256 }).notNull(),
  audience: text("audience", { length: 128 }).notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  clientididxIdx: uniqueIndex("pf_oauth_client_clientididx_idx").on(table.clientId).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_oauth_client_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const jobQueue = sqliteTable("pf_job_queue", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `qjob-${ulid()}`),
  queue: text("queue", { length: 512 }).notNull(),
  jobPayload: jsonColumn("job_payload").notNull(),
  jobAttempts: integer("job_attempts").notNull().default(0),
  jobRetryLimit: integer("job_retry_limit").notNull().default(5),
  availableAt: effectDateTime("available_at").notNull().default(sql`(julianday('now'))`),
  lockedUntil: effectDateTime("locked_until"),
  claimReceipt: text("claim_receipt", { length: 64 }),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  readyIdxIdx: index("pf_job_queue_ready_idx_idx").on(table.queue, table.lockedUntil, table.jobAttempts, table.availableAt).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_job_queue_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const completedJob = sqliteTable("pf_completed_job", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `cj-${ulid()}`),
  queue: text("queue", { length: 512 }).notNull(),
  jobId: text("job_id", { length: 1024 }).notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  jobIdIxIdx: uniqueIndex("pf_completed_job_job_id_ix_idx").on(table.queue, table.jobId).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_completed_job_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const weeklySchedule = sqliteTable("pf_weekly_schedule", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `ws-${ulid()}`),
  orgUnitId: text("org_unit_id", { length: 41 }).notNull().references(() => orgUnit.id),
  dayOfWeek: integer("day_of_week").notNull(),
  timeRanges: jsonColumn("time_ranges").notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  orgunitdayidxIdx: uniqueIndex("pf_weekly_schedule_orgunitdayidx_idx").on(table.orgUnitId, table.dayOfWeek).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_weekly_schedule_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const calendarPeriod = sqliteTable("pf_calendar_period", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `calp-${ulid()}`),
  orgUnitId: text("org_unit_id", { length: 41 }).notNull().references(() => orgUnit.id),
  periodKind: text("period_kind", { length: 64 }).notNull(),
  periodTitle: citextColumn("period_title").notNull(),
  periodStart: effectDateTime("period_start").notNull(),
  periodEnd: effectDateTime("period_end").notNull(),
  periodActive: integer("period_active", { mode: "boolean" }).notNull(),
  periodSchedule: jsonColumn("period_schedule"),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  kinddateidxIdx: index("pf_calendar_period_kinddateidx_idx").on(table.periodKind, table.periodStart, table.periodEnd).where(sql`_deleted = 0`),
  orgunitidxIdx: index("pf_calendar_period_orgunitidx_idx").on(table.orgUnitId).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_calendar_period_updated_at_id_idx").on(table.updatedAt, table.id),
  periodTitleLengthCheck: check("period_title_length_check", sql.raw(`length("pf_calendar_period"."period_title") <= 256`)),
}))

export const dateException = sqliteTable("pf_date_exception", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `dex-${ulid()}`),
  orgUnitId: text("org_unit_id", { length: 41 }).notNull().references(() => orgUnit.id),
  exceptionDate: effectDateTime("exception_date").notNull(),
  exceptionSlots: jsonColumn("exception_slots").notNull(),
  exceptionNote: citextColumn("exception_note"),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  orgunitdateidxIdx: uniqueIndex("pf_date_exception_orgunitdateidx_idx").on(table.orgUnitId, table.exceptionDate).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_date_exception_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const holidayInstance = sqliteTable("pf_holiday_instance", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `hol-${ulid()}`),
  orgUnitId: text("org_unit_id", { length: 41 }).notNull().references(() => orgUnit.id),
  holidayTitle: citextColumn("holiday_title").notNull(),
  holidayRule: jsonColumn("holiday_rule").notNull(),
  holidayDate: effectDateTime("holiday_date"),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  orgunittitleidxIdx: uniqueIndex("pf_holiday_instance_orgunittitleidx_idx").on(table.orgUnitId, table.holidayTitle).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_holiday_instance_updated_at_id_idx").on(table.updatedAt, table.id),
  holidayTitleLengthCheck: check("holiday_title_length_check", sql.raw(`length("pf_holiday_instance"."holiday_title") <= 256`)),
}))

export const documentStore = sqliteTable("pf_document_store", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `dstr-${ulid()}`),
  orgUnitId: text("org_unit_id", { length: 41 }).notNull().references(() => orgUnit.id),
  name: citextColumn("name").notNull(),
  path: text("path", { length: 2048 }).notNull(),
  acceptedTypes: jsonColumn("accepted_types"),
  sizeLimit: integer("size_limit"),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  pathidxIdx: uniqueIndex("pf_document_store_pathidx_idx").on(table.path).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_document_store_updated_at_id_idx").on(table.updatedAt, table.id),
  nameLengthCheck: check("name_length_check", sql.raw(`length("pf_document_store"."name") <= 1024`)),
}))

export const file = sqliteTable("pf_file", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `file-${ulid()}`),
  documentStoreId: text("document_store_id", { length: 41 }).notNull().references(() => documentStore.id),
  fileSize: integer("file_size"),
  mediaKind: text("media_kind", { length: 256 }),
  uploadPending: integer("upload_pending", { mode: "boolean" }).notNull().default(true),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  updatedAtIdIdx: index("pf_file_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const stepDocumentStore = sqliteTable("pf_step_document_store", {
  id: text("id", { length: 41 }).primaryKey().$defaultFn(() => `sds-${ulid()}`),
  stepId: text("step_id", { length: 41 }).notNull().references(() => step.id),
  documentStoreId: text("document_store_id", { length: 41 }).notNull().references(() => documentStore.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`(julianday('now'))`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`(julianday('now'))`),
  createdBy: text("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: text("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: integer("_deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => ({
  stepdocstoreidxIdx: uniqueIndex("pf_step_document_store_stepdocstoreidx_idx").on(table.stepId, table.documentStoreId).where(sql`_deleted = 0`),
  updatedAtIdIdx: index("pf_step_document_store_updated_at_id_idx").on(table.updatedAt, table.id),
}))

// Views for virtual attributes
export const processItsNoDrafts = sqliteView("pf_process_its_no_drafts", {
  id: text("id", { length: 41 }).notNull(),
  noDrafts: integer("no_drafts", { mode: "boolean" }).notNull(),
}).as(sql`
  select
    id,
    not exists (select 1 from pf_process_execution
    join pf_process_state on pf_process_execution.process_state_id = pf_process_state.id and pf_process_state._deleted = false
    where pf_process_state.process_id = pf_process.id and pf_process_execution._deleted = false) as no_drafts
  from pf_process
`)

export const processItsStartStep = sqliteView("pf_process_its_start_step", {
  id: text("id", { length: 41 }).notNull(),
  startStep: text("start_step", { length: 41 }),
}).as(sql`
  select
    id,
    (select pf_step.id from pf_step
    join pf_step_its_can_start_process on pf_step.id = pf_step_its_can_start_process.id
    where pf_step.process_id = pf_process.id
    and pf_step_its_can_start_process.can_start_process = 1
    and pf_step._deleted = false
    limit 1) as start_step
  from pf_process
`)

export const processItsActiveProcesses = sqliteView("pf_process_its_active_processes", {
  id: text("id", { length: 41 }).notNull(),
  activeProcesses: integer("active_processes").notNull(),
}).as(sql`
  select
    pf_process.id,
    count(distinct pf_to_do.id) as active_processes
  from pf_process
  left outer join pf_process_state on pf_process_state.process_id = pf_process.id and pf_process_state._deleted = false
  left outer join pf_process_execution on pf_process_execution.process_state_id = pf_process_state.id and pf_process_execution._deleted = false
  left outer join pf_to_do on pf_to_do.process_execution_id = pf_process_execution.id and pf_to_do._deleted = false
  group by
    pf_process.id
`)

export const stepItsCanStartProcess = sqliteView("pf_step_its_can_start_process", {
  id: text("id", { length: 41 }).notNull(),
  canStartProcess: integer("can_start_process", { mode: "boolean" }).notNull(),
}).as(sql`
  select
    id,
    not exists (select 1 from pf_flow where pf_flow.target_step = pf_step.id and pf_flow._deleted = false) as can_start_process
  from pf_step
`)

export const processStateItsIsDraft = sqliteView("pf_process_state_its_is_draft", {
  id: text("id", { length: 41 }).notNull(),
  isDraft: integer("is_draft", { mode: "boolean" }).notNull(),
}).as(sql`
  select
    id,
    not exists (select 1 from pf_process_execution where pf_process_execution.process_state_id = pf_process_state.id and pf_process_execution._deleted = false) as is_draft
  from pf_process_state
`)

// Type exports
export type OrgUnit = typeof orgUnit.$inferSelect
export type NewOrgUnit = typeof orgUnit.$inferInsert
export type Process = typeof process.$inferSelect
export type NewProcess = typeof process.$inferInsert
export type Role = typeof role.$inferSelect
export type NewRole = typeof role.$inferInsert
export type Phase = typeof phase.$inferSelect
export type NewPhase = typeof phase.$inferInsert
export type RoleResponsibility = typeof roleResponsibility.$inferSelect
export type NewRoleResponsibility = typeof roleResponsibility.$inferInsert
export type Step = typeof step.$inferSelect
export type NewStep = typeof step.$inferInsert
export type StepSupportingRole = typeof stepSupportingRole.$inferSelect
export type NewStepSupportingRole = typeof stepSupportingRole.$inferInsert
export type Flow = typeof flow.$inferSelect
export type NewFlow = typeof flow.$inferInsert
export type ExternalParticipant = typeof externalParticipant.$inferSelect
export type NewExternalParticipant = typeof externalParticipant.$inferInsert
export type ProcessState = typeof processState.$inferSelect
export type NewProcessState = typeof processState.$inferInsert
export type ProcessExecution = typeof processExecution.$inferSelect
export type NewProcessExecution = typeof processExecution.$inferInsert
export type ToDo = typeof toDo.$inferSelect
export type NewToDo = typeof toDo.$inferInsert
export type PublicCompletionInvitationAttempt = typeof publicCompletionInvitationAttempt.$inferSelect
export type NewPublicCompletionInvitationAttempt = typeof publicCompletionInvitationAttempt.$inferInsert
export type ScheduledFlow = typeof scheduledFlow.$inferSelect
export type NewScheduledFlow = typeof scheduledFlow.$inferInsert
export type User = typeof user.$inferSelect
export type NewUser = typeof user.$inferInsert
export type PasskeyCredential = typeof passkeyCredential.$inferSelect
export type NewPasskeyCredential = typeof passkeyCredential.$inferInsert
export type ProviderUser = typeof providerUser.$inferSelect
export type NewProviderUser = typeof providerUser.$inferInsert
export type Delegation = typeof delegation.$inferSelect
export type NewDelegation = typeof delegation.$inferInsert
export type SecretGeneration = typeof secretGeneration.$inferSelect
export type NewSecretGeneration = typeof secretGeneration.$inferInsert
export type DelegationHistory = typeof delegationHistory.$inferSelect
export type NewDelegationHistory = typeof delegationHistory.$inferInsert
export type ProviderUserRole = typeof providerUserRole.$inferSelect
export type NewProviderUserRole = typeof providerUserRole.$inferInsert
export type UserSettings = typeof userSettings.$inferSelect
export type NewUserSettings = typeof userSettings.$inferInsert
export type PermittedRole = typeof permittedRole.$inferSelect
export type NewPermittedRole = typeof permittedRole.$inferInsert
export type PermittedClientRole = typeof permittedClientRole.$inferSelect
export type NewPermittedClientRole = typeof permittedClientRole.$inferInsert
export type PermittedClientEmail = typeof permittedClientEmail.$inferSelect
export type NewPermittedClientEmail = typeof permittedClientEmail.$inferInsert
export type Invitation = typeof invitation.$inferSelect
export type NewInvitation = typeof invitation.$inferInsert
export type RegistrationSession = typeof registrationSession.$inferSelect
export type NewRegistrationSession = typeof registrationSession.$inferInsert
export type InvitationRole = typeof invitationRole.$inferSelect
export type NewInvitationRole = typeof invitationRole.$inferInsert
export type OauthStorage = typeof oauthStorage.$inferSelect
export type NewOauthStorage = typeof oauthStorage.$inferInsert
export type OauthProvider = typeof oauthProvider.$inferSelect
export type NewOauthProvider = typeof oauthProvider.$inferInsert
export type OauthClient = typeof oauthClient.$inferSelect
export type NewOauthClient = typeof oauthClient.$inferInsert
export type JobQueue = typeof jobQueue.$inferSelect
export type NewJobQueue = typeof jobQueue.$inferInsert
export type CompletedJob = typeof completedJob.$inferSelect
export type NewCompletedJob = typeof completedJob.$inferInsert
export type WeeklySchedule = typeof weeklySchedule.$inferSelect
export type NewWeeklySchedule = typeof weeklySchedule.$inferInsert
export type CalendarPeriod = typeof calendarPeriod.$inferSelect
export type NewCalendarPeriod = typeof calendarPeriod.$inferInsert
export type DateException = typeof dateException.$inferSelect
export type NewDateException = typeof dateException.$inferInsert
export type HolidayInstance = typeof holidayInstance.$inferSelect
export type NewHolidayInstance = typeof holidayInstance.$inferInsert
export type DocumentStore = typeof documentStore.$inferSelect
export type NewDocumentStore = typeof documentStore.$inferInsert
export type File = typeof file.$inferSelect
export type NewFile = typeof file.$inferInsert
export type StepDocumentStore = typeof stepDocumentStore.$inferSelect
export type NewStepDocumentStore = typeof stepDocumentStore.$inferInsert

// Relations

export const orgUnitRelations = relations(orgUnit, ({ one, many }) => ({
  parentOrgUnit: one(orgUnit, {
    fields: [orgUnit.parentOrgUnitId],
    references: [orgUnit.id],
  }),
  processes: many(process),
  roles: many(role),
  providerUsers: many(providerUser),
  weeklySchedules: many(weeklySchedule),
  calendarPeriods: many(calendarPeriod),
  dateExceptions: many(dateException),
  holidayInstances: many(holidayInstance),
  documentStores: many(documentStore),
  children: many(orgUnit),
}))

export const processRelations = relations(process, ({ one, many }) => ({
  orgUnit: one(orgUnit, {
    fields: [process.orgUnitId],
    references: [orgUnit.id],
  }),
  phases: many(phase),
  roleResponsibilities: many(roleResponsibility),
  steps: many(step),
  processStates: many(processState),
}))

export const roleRelations = relations(role, ({ one, many }) => ({
  orgUnit: one(orgUnit, {
    fields: [role.orgUnitId],
    references: [orgUnit.id],
  }),
  roleResponsibilities: many(roleResponsibility),
  steps: many(step),
  stepSupportingRoles: many(stepSupportingRole),
  processStates: many(processState),
  toDos: many(toDo),
  scheduledFlows: many(scheduledFlow),
  providerUserRoles: many(providerUserRole),
  permittedRoles: many(permittedRole),
  permittedClientRoles: many(permittedClientRole),
  invitationRoles: many(invitationRole),
}))

export const phaseRelations = relations(phase, ({ one, many }) => ({
  process: one(process, {
    fields: [phase.processId],
    references: [process.id],
  }),
  steps: many(step),
}))

export const roleResponsibilityRelations = relations(roleResponsibility, ({ one }) => ({
  process: one(process, {
    fields: [roleResponsibility.processId],
    references: [process.id],
  }),
  role: one(role, {
    fields: [roleResponsibility.roleId],
    references: [role.id],
  }),
}))

export const stepRelations = relations(step, ({ one, many }) => ({
  process: one(process, {
    fields: [step.processId],
    references: [process.id],
  }),
  role: one(role, {
    fields: [step.roleId],
    references: [role.id],
  }),
  phase: one(phase, {
    fields: [step.phaseId],
    references: [phase.id],
  }),
  stepSupportingRoles: many(stepSupportingRole),
  flows: many(flow, { relationName: "flow_sourceStep" }),
  processStates: many(processState),
  scheduledFlows: many(scheduledFlow, { relationName: "scheduledFlow_sourceStep" }),
  stepDocumentStores: many(stepDocumentStore),
}))

export const stepSupportingRoleRelations = relations(stepSupportingRole, ({ one }) => ({
  step: one(step, {
    fields: [stepSupportingRole.stepId],
    references: [step.id],
  }),
  role: one(role, {
    fields: [stepSupportingRole.roleId],
    references: [role.id],
  }),
}))

export const flowRelations = relations(flow, ({ one, many }) => ({
  sourceStep: one(step, {
    relationName: "flow_sourceStep",
    fields: [flow.sourceStepId],
    references: [step.id],
  }),
  targetStep: one(step, {
    relationName: "flow_targetStep",
    fields: [flow.targetStepId],
    references: [step.id],
  }),
  toDos: many(toDo),
}))

export const externalParticipantRelations = relations(externalParticipant, ({ many }) => ({
  processStates: many(processState),
  toDos: many(toDo),
}))

export const processStateRelations = relations(processState, ({ one, many }) => ({
  process: one(process, {
    fields: [processState.processId],
    references: [process.id],
  }),
  startStep: one(step, {
    fields: [processState.startStepId],
    references: [step.id],
  }),
  startedByUser: one(user, {
    fields: [processState.startedByUserId],
    references: [user.id],
  }),
  startedByExternalParticipant: one(externalParticipant, {
    fields: [processState.startedByExternalParticipantId],
    references: [externalParticipant.id],
  }),
  startedByRole: one(role, {
    fields: [processState.startedByRoleId],
    references: [role.id],
  }),
  processExecutions: many(processExecution),
}))

export const processExecutionRelations = relations(processExecution, ({ one, many }) => ({
  processState: one(processState, {
    fields: [processExecution.processStateId],
    references: [processState.id],
  }),
  toDos: many(toDo),
  scheduledFlows: many(scheduledFlow),
}))

export const toDoRelations = relations(toDo, ({ one, many }) => ({
  processExecution: one(processExecution, {
    fields: [toDo.processExecutionId],
    references: [processExecution.id],
  }),
  flow: one(flow, {
    fields: [toDo.flowId],
    references: [flow.id],
  }),
  completedByUser: one(user, {
    fields: [toDo.completedByUserId],
    references: [user.id],
  }),
  completedByExternalParticipant: one(externalParticipant, {
    fields: [toDo.completedByExternalParticipantId],
    references: [externalParticipant.id],
  }),
  assignedToProviderUser: one(providerUser, {
    fields: [toDo.assignedToProviderUserId],
    references: [providerUser.id],
  }),
  completedByRole: one(role, {
    fields: [toDo.completedByRoleId],
    references: [role.id],
  }),
  publicCompletionInvitationAttempts: many(publicCompletionInvitationAttempt),
}))

export const publicCompletionInvitationAttemptRelations = relations(publicCompletionInvitationAttempt, ({ one }) => ({
  toDo: one(toDo, {
    fields: [publicCompletionInvitationAttempt.toDoId],
    references: [toDo.id],
  }),
}))

export const scheduledFlowRelations = relations(scheduledFlow, ({ one }) => ({
  processExecution: one(processExecution, {
    fields: [scheduledFlow.processExecutionId],
    references: [processExecution.id],
  }),
  sourceStep: one(step, {
    relationName: "scheduledFlow_sourceStep",
    fields: [scheduledFlow.sourceStepId],
    references: [step.id],
  }),
  targetStep: one(step, {
    relationName: "scheduledFlow_targetStep",
    fields: [scheduledFlow.targetStepId],
    references: [step.id],
  }),
  completedByRole: one(role, {
    fields: [scheduledFlow.completedByRoleId],
    references: [role.id],
  }),
}))

export const userRelations = relations(user, ({ one, many }) => ({
  processStates: many(processState),
  toDos: many(toDo),
  passkeyCredentials: many(passkeyCredential),
  providerUser: one(providerUser, {
    fields: [user.id],
    references: [providerUser.userId],
  }),
  userSettings: one(userSettings, {
    fields: [user.id],
    references: [userSettings.userId],
  }),
}))

export const passkeyCredentialRelations = relations(passkeyCredential, ({ one }) => ({
  user: one(user, {
    fields: [passkeyCredential.userId],
    references: [user.id],
  }),
}))

export const providerUserRelations = relations(providerUser, ({ one, many }) => ({
  user: one(user, {
    fields: [providerUser.userId],
    references: [user.id],
  }),
  orgUnit: one(orgUnit, {
    fields: [providerUser.orgUnitId],
    references: [orgUnit.id],
  }),
  toDos: many(toDo),
  delegations: many(delegation),
  delegationHistories: many(delegationHistory),
  providerUserRoles: many(providerUserRole),
  permittedRoles: many(permittedRole),
  invitations: many(invitation),
}))

export const delegationRelations = relations(delegation, ({ one, many }) => ({
  ownerProviderUser: one(providerUser, {
    fields: [delegation.ownerProviderUserId],
    references: [providerUser.id],
  }),
  secretGenerations: many(secretGeneration),
  delegationHistories: many(delegationHistory, { relationName: "delegationHistory_delegation" }),
}))

export const secretGenerationRelations = relations(secretGeneration, ({ one, many }) => ({
  delegation: one(delegation, {
    fields: [secretGeneration.delegationId],
    references: [delegation.id],
  }),
  parentSecretGeneration: one(secretGeneration, {
    fields: [secretGeneration.parentSecretGenerationId],
    references: [secretGeneration.id],
  }),
  delegationHistories: many(delegationHistory, { relationName: "delegationHistory_secretGeneration" }),
  children: many(secretGeneration),
}))

export const delegationHistoryRelations = relations(delegationHistory, ({ one }) => ({
  delegation: one(delegation, {
    relationName: "delegationHistory_delegation",
    fields: [delegationHistory.delegationId],
    references: [delegation.id],
  }),
  secretGeneration: one(secretGeneration, {
    relationName: "delegationHistory_secretGeneration",
    fields: [delegationHistory.secretGenerationId],
    references: [secretGeneration.id],
  }),
  actorProviderUser: one(providerUser, {
    fields: [delegationHistory.actorProviderUserId],
    references: [providerUser.id],
  }),
  actorDelegation: one(delegation, {
    relationName: "delegationHistory_actorDelegation",
    fields: [delegationHistory.actorDelegationId],
    references: [delegation.id],
  }),
  actorSecretGeneration: one(secretGeneration, {
    relationName: "delegationHistory_actorSecretGeneration",
    fields: [delegationHistory.actorSecretGenerationId],
    references: [secretGeneration.id],
  }),
}))

export const providerUserRoleRelations = relations(providerUserRole, ({ one }) => ({
  providerUser: one(providerUser, {
    fields: [providerUserRole.providerUserId],
    references: [providerUser.id],
  }),
  role: one(role, {
    fields: [providerUserRole.roleId],
    references: [role.id],
  }),
}))

export const userSettingsRelations = relations(userSettings, ({ one }) => ({
  user: one(user, {
    fields: [userSettings.userId],
    references: [user.id],
  }),
}))

export const permittedRoleRelations = relations(permittedRole, ({ one }) => ({
  providerUser: one(providerUser, {
    fields: [permittedRole.providerUserId],
    references: [providerUser.id],
  }),
  role: one(role, {
    fields: [permittedRole.roleId],
    references: [role.id],
  }),
}))

export const permittedClientRoleRelations = relations(permittedClientRole, ({ one }) => ({
  oauthClient: one(oauthClient, {
    fields: [permittedClientRole.oauthClientId],
    references: [oauthClient.id],
  }),
  role: one(role, {
    fields: [permittedClientRole.roleId],
    references: [role.id],
  }),
}))

export const permittedClientEmailRelations = relations(permittedClientEmail, ({ one }) => ({
  oauthClient: one(oauthClient, {
    fields: [permittedClientEmail.oauthClientId],
    references: [oauthClient.id],
  }),
}))

export const invitationRelations = relations(invitation, ({ one, many }) => ({
  acceptedByProviderUser: one(providerUser, {
    fields: [invitation.acceptedByProviderUserId],
    references: [providerUser.id],
  }),
  registrationSessions: many(registrationSession),
  invitationRoles: many(invitationRole),
}))

export const registrationSessionRelations = relations(registrationSession, ({ one }) => ({
  invitation: one(invitation, {
    fields: [registrationSession.invitationId],
    references: [invitation.id],
  }),
}))

export const invitationRoleRelations = relations(invitationRole, ({ one }) => ({
  invitation: one(invitation, {
    fields: [invitationRole.invitationId],
    references: [invitation.id],
  }),
  role: one(role, {
    fields: [invitationRole.roleId],
    references: [role.id],
  }),
}))

export const oauthClientRelations = relations(oauthClient, ({ many }) => ({
  permittedClientRoles: many(permittedClientRole),
  permittedClientEmails: many(permittedClientEmail),
}))

export const weeklyScheduleRelations = relations(weeklySchedule, ({ one }) => ({
  orgUnit: one(orgUnit, {
    fields: [weeklySchedule.orgUnitId],
    references: [orgUnit.id],
  }),
}))

export const calendarPeriodRelations = relations(calendarPeriod, ({ one }) => ({
  orgUnit: one(orgUnit, {
    fields: [calendarPeriod.orgUnitId],
    references: [orgUnit.id],
  }),
}))

export const dateExceptionRelations = relations(dateException, ({ one }) => ({
  orgUnit: one(orgUnit, {
    fields: [dateException.orgUnitId],
    references: [orgUnit.id],
  }),
}))

export const holidayInstanceRelations = relations(holidayInstance, ({ one }) => ({
  orgUnit: one(orgUnit, {
    fields: [holidayInstance.orgUnitId],
    references: [orgUnit.id],
  }),
}))

export const documentStoreRelations = relations(documentStore, ({ one, many }) => ({
  orgUnit: one(orgUnit, {
    fields: [documentStore.orgUnitId],
    references: [orgUnit.id],
  }),
  files: many(file),
  stepDocumentStores: many(stepDocumentStore),
}))

export const fileRelations = relations(file, ({ one }) => ({
  documentStore: one(documentStore, {
    fields: [file.documentStoreId],
    references: [documentStore.id],
  }),
}))

export const stepDocumentStoreRelations = relations(stepDocumentStore, ({ one }) => ({
  step: one(step, {
    fields: [stepDocumentStore.stepId],
    references: [step.id],
  }),
  documentStore: one(documentStore, {
    fields: [stepDocumentStore.documentStoreId],
    references: [documentStore.id],
  }),
}))
