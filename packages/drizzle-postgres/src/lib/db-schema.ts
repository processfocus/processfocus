import { sql } from "drizzle-orm"
import { relations } from "drizzle-orm/_relations"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { boolean, check, customType, index, integer, jsonb, pgTable, pgView, uniqueIndex, varchar } from "drizzle-orm/pg-core"
import { DateTime } from "effect"
import { ulid } from "ulidx"

// Generated from Xplain DDL: schema.ddl
// Auto-generated - DO NOT EDIT

// Custom type for case-insensitive text columns (PostgreSQL citext)
// Note: Requires 'CREATE EXTENSION IF NOT EXISTS citext' in database
const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext"
  },
})

// Custom type for Effect DateTime columns
// Keep in sync with parsePgTimestamp emitted by cli/xplain2drizzle/src/generator.postgres.ts
const parsePgTimestamp = (value: Date | string): DateTime.Utc => {
  if (value instanceof Date) return DateTime.unsafeFromDate(value)
  const timestamp = value.includes("T") ? value : value.replace(" ", "T")
  return DateTime.unsafeMake(/[zZ]|[+-]\d{2}:?\d{2}$/.test(timestamp) ? timestamp : timestamp + "Z")
}

const effectDateTime = customType<{ data: DateTime.Utc; driverData: Date | string }>({
  dataType() {
    return "timestamp without time zone"
  },
  toDriver(value: DateTime.Utc): Date {
    return DateTime.toDateUtc(value)
  },
  fromDriver(value: Date | string): DateTime.Utc {
    return parsePgTimestamp(value)
  },
})

export const orgUnit = pgTable("pf_org_unit", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `ou-${ulid()}`),
  name: citext("name").notNull(),
  orgUnitLevel: varchar("org_unit_level", { length: 64 }).notNull(),
  parentOrgUnitId: varchar("parent_org_unit", { length: 41 }).references((): AnyPgColumn => orgUnit.id),
  path: varchar("path", { length: 2048 }).notNull(),
  acronym: citext("acronym"),
  timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
  startDayOfWeek: integer("start_day_of_week").default(0),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  pathidxIdx: uniqueIndex("pf_org_unit_pathidx_idx").on(table.path).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_org_unit_updated_at_id_idx").on(table.updatedAt, table.id),
  nameLengthCheck: check("name_length_check", sql.raw(`length("pf_org_unit"."name") <= 1024`)),
  acronymLengthCheck: check("acronym_length_check", sql.raw(`length("pf_org_unit"."acronym") <= 64`)),
}))

export const process = pgTable("pf_process", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `prc-${ulid()}`),
  orgUnitId: varchar("org_unit_id", { length: 41 }).notNull().references(() => orgUnit.id),
  name: citext("name").notNull(),
  path: varchar("path", { length: 2048 }).notNull(),
  purpose: citext("purpose").notNull(),
  slaValue: integer("sla_value"),
  slaUnit: varchar("sla_unit", { length: 16 }),
  slaWarning: integer("sla_warning"),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  pathidxIdx: uniqueIndex("pf_process_pathidx_idx").on(table.path).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_process_updated_at_id_idx").on(table.updatedAt, table.id),
  nameLengthCheck: check("name_length_check", sql.raw(`length("pf_process"."name") <= 1024`)),
}))

export const role = pgTable("pf_role", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `role-${ulid()}`),
  orgUnitId: varchar("org_unit_id", { length: 41 }).notNull().references(() => orgUnit.id),
  name: citext("name").notNull(),
  path: varchar("path", { length: 2048 }).notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  pathidxIdx: uniqueIndex("pf_role_pathidx_idx").on(table.path).where(sql`_deleted = false`),
  orgunitunameidxIdx: uniqueIndex("pf_role_orgunitunameidx_idx").on(table.orgUnitId, table.name).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_role_updated_at_id_idx").on(table.updatedAt, table.id),
  nameLengthCheck: check("name_length_check", sql.raw(`length("pf_role"."name") <= 1024`)),
}))

export const phase = pgTable("pf_phase", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `ph-${ulid()}`),
  processId: varchar("process_id", { length: 41 }).notNull().references(() => process.id),
  name: citext("name").notNull(),
  path: varchar("path", { length: 2048 }).notNull(),
  phaseOrder: integer("phase_order").notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  pathidxIdx: uniqueIndex("pf_phase_pathidx_idx").on(table.path).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_phase_updated_at_id_idx").on(table.updatedAt, table.id),
  nameLengthCheck: check("name_length_check", sql.raw(`length("pf_phase"."name") <= 1024`)),
}))

export const roleResponsibility = pgTable("pf_role_responsibility", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `rr-${ulid()}`),
  processId: varchar("process_id", { length: 41 }).notNull().references(() => process.id),
  roleId: varchar("role_id", { length: 41 }).notNull().references(() => role.id),
  responsibility: citext("responsibility").notNull(),
  responsibilityOrder: integer("responsibility_order").notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  processroleidxIdx: uniqueIndex("pf_role_responsibility_processroleidx_idx").on(table.processId, table.roleId).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_role_responsibility_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const step = pgTable("pf_step", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `step-${ulid()}`),
  name: citext("name").notNull(),
  path: varchar("path", { length: 2048 }).notNull(),
  purpose: citext("purpose").notNull(),
  processId: varchar("process_id", { length: 41 }).notNull().references(() => process.id),
  roleId: varchar("role_id", { length: 41 }).references(() => role.id),
  formFields: integer("form_fields"),
  phaseId: varchar("phase_id", { length: 41 }).references(() => phase.id),
  slaValue: integer("sla_value"),
  slaUnit: varchar("sla_unit", { length: 16 }),
  slaWarning: integer("sla_warning"),
  hasForEach: boolean("has_for_each").notNull().default(false),
  embedded: boolean("embedded").notNull().default(false),
  retryLimit: integer("retry_limit"),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  pathidxIdx: uniqueIndex("pf_step_pathidx_idx").on(table.path).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_step_updated_at_id_idx").on(table.updatedAt, table.id),
  nameLengthCheck: check("name_length_check", sql.raw(`length("pf_step"."name") <= 1024`)),
}))

export const stepSupportingRole = pgTable("pf_step_supporting_role", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `ssr-${ulid()}`),
  stepId: varchar("step_id", { length: 41 }).notNull().references(() => step.id),
  roleId: varchar("role_id", { length: 41 }).notNull().references(() => role.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  steproleidxIdx: uniqueIndex("pf_step_supporting_role_steproleidx_idx").on(table.stepId, table.roleId).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_step_supporting_role_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const flow = pgTable("pf_flow", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `flow-${ulid()}`),
  flowKey: varchar("flow_key", { length: 128 }).notNull(),
  sourceStepId: varchar("source_step", { length: 41 }).notNull().references(() => step.id),
  targetStepId: varchar("target_step", { length: 41 }).notNull().references(() => step.id),
  condition: citext("condition"),
  schedule: citext("schedule"),
  fallbackBranch: boolean("fallback_branch").notNull().default(false),
  errorBranch: boolean("error_branch").notNull().default(false),
  errorTags: jsonb("error_tags").$type<Record<string, unknown> | unknown[]>(),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  sourcetargetidxIdx: index("pf_flow_sourcetargetidx_idx").on(table.sourceStepId, table.targetStepId).where(sql`_deleted = false`),
  flowkeyidxIdx: uniqueIndex("pf_flow_flowkeyidx_idx").on(table.flowKey).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_flow_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const externalParticipant = pgTable("pf_external_participant", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `xp-${ulid()}`),
  email: varchar("email", { length: 320 }).notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  emailidxIdx: uniqueIndex("pf_external_participant_emailidx_idx").on(table.email).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_external_participant_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const processState = pgTable("pf_process_state", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `pst-${ulid()}`),
  processId: varchar("process_id", { length: 41 }).notNull().references(() => process.id),
  startStepId: varchar("start_step", { length: 41 }).notNull().references(() => step.id),
  state: jsonb("state").$type<Record<string, unknown> | unknown[]>().notNull(),
  startedByUserId: varchar("started_by_user", { length: 41 }).references(() => user.id),
  startedByExternalParticipantId: varchar("started_by_external_participant", { length: 41 }).references(() => externalParticipant.id),
  startedByRoleId: varchar("started_by_role", { length: 41 }).references(() => role.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  updatedAtIdIdx: index("pf_process_state_updated_at_id_idx").on(table.updatedAt, table.id),
  singleStarterCheck: check("single_starter_check", sql`${table.startedByUserId} is null or ${table.startedByExternalParticipantId} is null`),
}))

export const processExecution = pgTable("pf_process_execution", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `pex-${ulid()}`),
  withoutWaiting: boolean("without_waiting").notNull().default(false),
  processStateId: varchar("process_state_id", { length: 41 }).notNull().references(() => processState.id),
  finishedAt: effectDateTime("finished_at"),
  businessDuration: integer("business_duration"),
  abandonedAt: effectDateTime("abandoned_at"),
  abandonedReason: citext("abandoned_reason"),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  updatedAtIdIdx: index("pf_process_execution_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const toDo = pgTable("pf_to_do", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `todo-${ulid()}`),
  processExecutionId: varchar("process_execution_id", { length: 41 }).notNull().references(() => processExecution.id),
  flowId: varchar("flow_id", { length: 41 }).notNull().references(() => flow.id),
  completedByUserId: varchar("completed_by_user", { length: 41 }).references(() => user.id),
  completedByExternalParticipantId: varchar("completed_by_external_participant", { length: 41 }).references(() => externalParticipant.id),
  assignedToProviderUserId: varchar("assigned_to_provider_user", { length: 41 }).references(() => providerUser.id),
  businessDuration: integer("business_duration"),
  slaTargetAt: effectDateTime("sla_target_at"),
  slaWarningAt: effectDateTime("sla_warning_at"),
  failureReason: citext("failure_reason"),
  correctionRequiredAt: effectDateTime("correction_required_at"),
  correctionFailureReason: citext("correction_failure_reason"),
  correctionInvitationAttemptId: varchar("correction_invitation_attempt_id", { length: 41 }),
  itemData: jsonb("item_data").$type<Record<string, unknown> | unknown[]>(),
  barrierScheduledFlowId: varchar("barrier_scheduled_flow_id", { length: 41 }),
  completedByRoleId: varchar("completed_by_role", { length: 41 }).references(() => role.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  updatedAtIdIdx: index("pf_to_do_updated_at_id_idx").on(table.updatedAt, table.id),
  singleCompleterCheck: check("single_completer_check", sql`${table.completedByUserId} is null or ${table.completedByExternalParticipantId} is null`),
}))

export const publicCompletionInvitationAttempt = pgTable("pf_public_completion_invitation_attempt", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `pcia-${ulid()}`),
  toDoId: varchar("to_do_id", { length: 41 }).notNull().references(() => toDo.id),
  email: varchar("email", { length: 320 }).notNull(),
  providerMessageId: varchar("provider_message_id", { length: 256 }),
  providerSentTo: citext("provider_sent_to"),
  deliveryStatus: varchar("delivery_status", { length: 32 }),
  deliveryEventId: varchar("delivery_event_id", { length: 256 }),
  deliveryFailureKind: varchar("delivery_failure_kind", { length: 64 }),
  deliveryFailureReason: citext("delivery_failure_reason"),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  todoidxIdx: index("pf_public_completion_invitation_attempt_todoidx_idx").on(table.toDoId).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_public_completion_invitation_attempt_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const scheduledFlow = pgTable("pf_scheduled_flow", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `sf-${ulid()}`),
  processExecutionId: varchar("process_execution_id", { length: 41 }).notNull().references(() => processExecution.id),
  sourceStepId: varchar("source_step", { length: 41 }).notNull().references(() => step.id),
  targetStepId: varchar("target_step", { length: 41 }).references(() => step.id),
  scheduledAt: effectDateTime("scheduled_at"),
  forEachBarrier: boolean("for_each_barrier").notNull().default(false),
  completedByRoleId: varchar("completed_by_role", { length: 41 }).references(() => role.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  updatedAtIdIdx: index("pf_scheduled_flow_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const user = pgTable("pf_user", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `usr-${ulid()}`),
  provider: varchar("provider", { length: 128 }).notNull(),
  sub: varchar("sub", { length: 256 }).notNull(),
  lastLoggedIn: effectDateTime("last_logged_in").notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  uniquesubIdx: uniqueIndex("pf_user_uniquesub_idx").on(table.provider, table.sub).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_user_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const passkeyCredential = pgTable("pf_passkey_credential", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `pkc-${ulid()}`),
  userId: varchar("user_id", { length: 41 }).notNull().references(() => user.id),
  passkeyCredentialId: varchar("passkey_credential_id", { length: 2048 }).notNull(),
  passkeyPublicKey: varchar("passkey_public_key", { length: 2048 }).notNull(),
  signatureCounter: varchar("signature_counter", { length: 16 }).notNull(),
  passkeyTransports: jsonb("passkey_transports").$type<Record<string, unknown> | unknown[]>(),
  passkeyName: varchar("passkey_name", { length: 128 }),
  passkeyLastUsedAt: effectDateTime("passkey_last_used_at"),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  credentialidxIdx: uniqueIndex("pf_passkey_credential_credentialidx_idx").on(table.passkeyCredentialId).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_passkey_credential_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const providerUser = pgTable("pf_provider_user", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `pu-${ulid()}`),
  userId: varchar("user_id", { length: 41 }).notNull().references(() => user.id),
  email: varchar("email", { length: 320 }).notNull(),
  name: citext("name").notNull(),
  firstName: citext("first_name").notNull(),
  lastName: citext("last_name").notNull(),
  picture: varchar("picture", { length: 1024 }).notNull(),
  locale: varchar("locale", { length: 35 }).notNull(),
  orgUnitId: varchar("org_unit_id", { length: 41 }).notNull().references(() => orgUnit.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  emailidxIdx: uniqueIndex("pf_provider_user_emailidx_idx").on(table.email).where(sql`_deleted = false`),
  userUniqueIdx: uniqueIndex("pf_provider_user_user_unique_idx").on(table.userId).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_provider_user_updated_at_id_idx").on(table.updatedAt, table.id),
  nameLengthCheck: check("name_length_check", sql.raw(`length("pf_provider_user"."name") <= 1024`)),
  firstNameLengthCheck: check("first_name_length_check", sql.raw(`length("pf_provider_user"."first_name") <= 128`)),
  lastNameLengthCheck: check("last_name_length_check", sql.raw(`length("pf_provider_user"."last_name") <= 128`)),
}))

export const delegation = pgTable("pf_delegation", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `dlg-${ulid()}`),
  ownerProviderUserId: varchar("owner_provider_user", { length: 41 }).notNull().references(() => providerUser.id),
  delegationName: varchar("delegation_name", { length: 128 }).notNull(),
  activeDelegationName: varchar("active_delegation_name", { length: 128 }),
  secretRevokedAt: effectDateTime("secret_revoked_at"),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  ownernameidxIdx: uniqueIndex("pf_delegation_ownernameidx_idx").on(table.ownerProviderUserId, table.activeDelegationName).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_delegation_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const secretGeneration = pgTable("pf_secret_generation", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `dsg-${ulid()}`),
  delegationId: varchar("delegation_id", { length: 41 }).notNull().references(() => delegation.id),
  secretVerifier: varchar("secret_verifier", { length: 64 }).notNull(),
  secretIssuedAt: effectDateTime("secret_issued_at").notNull(),
  secretExpiresAt: effectDateTime("secret_expires_at").notNull(),
  secretRevokedAt: effectDateTime("secret_revoked_at"),
  secretLastUsedAt: effectDateTime("secret_last_used_at"),
  parentSecretGenerationId: varchar("parent_secret_generation", { length: 41 }).references((): AnyPgColumn => secretGeneration.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  delegationidxIdx: index("pf_secret_generation_delegationidx_idx").on(table.delegationId).where(sql`_deleted = false`),
  verifieridxIdx: uniqueIndex("pf_secret_generation_verifieridx_idx").on(table.secretVerifier).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_secret_generation_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const delegationHistory = pgTable("pf_delegation_history", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `dgh-${ulid()}`),
  delegationId: varchar("delegation_id", { length: 41 }).notNull().references(() => delegation.id),
  secretGenerationId: varchar("secret_generation_id", { length: 41 }).notNull().references(() => secretGeneration.id),
  actorProviderUserId: varchar("actor_provider_user", { length: 41 }).notNull().references(() => providerUser.id),
  delegationEvent: varchar("delegation_event", { length: 32 }).notNull(),
  secretIssuedAt: effectDateTime("secret_issued_at").notNull(),
  oldDelegationName: varchar("old_delegation_name", { length: 128 }),
  newDelegationName: varchar("new_delegation_name", { length: 128 }),
  actorDelegationId: varchar("actor_delegation", { length: 41 }).references(() => delegation.id),
  actorSecretGenerationId: varchar("actor_secret_generation", { length: 41 }).references(() => secretGeneration.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  updatedAtIdIdx: index("pf_delegation_history_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const providerUserRole = pgTable("pf_provider_user_role", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `pur-${ulid()}`),
  providerUserId: varchar("provider_user_id", { length: 41 }).notNull().references(() => providerUser.id),
  roleId: varchar("role_id", { length: 41 }).notNull().references(() => role.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  provideruserroleidxIdx: uniqueIndex("pf_provider_user_role_provideruserroleidx_idx").on(table.providerUserId, table.roleId).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_provider_user_role_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const userSettings = pgTable("pf_user_settings", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `us-${ulid()}`),
  userId: varchar("user_id", { length: 41 }).notNull().references(() => user.id),
  notificationPreference: jsonb("notification_preference").$type<Record<string, unknown> | unknown[]>().notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  userUniqueIdx: uniqueIndex("pf_user_settings_user_unique_idx").on(table.userId).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_user_settings_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const permittedRole = pgTable("pf_permitted_role", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `pr-${ulid()}`),
  providerUserId: varchar("provider_user_id", { length: 41 }).notNull().references(() => providerUser.id),
  roleId: varchar("role_id", { length: 41 }).notNull().references(() => role.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  provideruserroleidxIdx: uniqueIndex("pf_permitted_role_provideruserroleidx_idx").on(table.providerUserId, table.roleId).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_permitted_role_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const permittedClientRole = pgTable("pf_permitted_client_role", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `pcr-${ulid()}`),
  oauthClientId: varchar("oauth_client_id", { length: 41 }).notNull().references(() => oauthClient.id),
  roleId: varchar("role_id", { length: 41 }).notNull().references(() => role.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  oauthclientroleidxIdx: uniqueIndex("pf_permitted_client_role_oauthclientroleidx_idx").on(table.oauthClientId, table.roleId).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_permitted_client_role_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const permittedClientEmail = pgTable("pf_permitted_client_email", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `pce-${ulid()}`),
  oauthClientId: varchar("oauth_client_id", { length: 41 }).notNull().references(() => oauthClient.id),
  email: varchar("email", { length: 320 }).notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  oauthclientemailidxIdx: uniqueIndex("pf_permitted_client_email_oauthclientemailidx_idx").on(table.oauthClientId, table.email).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_permitted_client_email_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const invitation = pgTable("pf_invitation", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `inv-${ulid()}`),
  invitationId: varchar("invitation_id", { length: 128 }).notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  invitationStatus: varchar("invitation_status", { length: 32 }).notNull().default("pending"),
  invitationSource: varchar("invitation_source", { length: 32 }).notNull().default("legacy"),
  invitationPendingEmail: varchar("invitation_pending_email", { length: 320 }),
  invitationAcceptedAt: effectDateTime("invitation_accepted_at"),
  invitationAcceptedByProvider: varchar("invitation_accepted_by_provider", { length: 64 }),
  invitationAcceptedBySubject: varchar("invitation_accepted_by_subject", { length: 256 }),
  acceptedByProviderUserId: varchar("accepted_by_provider_user", { length: 41 }).references(() => providerUser.id),
  invitationLegacyClosedAt: effectDateTime("invitation_legacy_closed_at"),
  invitationLegacyClosureReason: varchar("invitation_legacy_closure_reason", { length: 128 }),
  registrationTokenHash: varchar("registration_token_hash", { length: 64 }),
  registrationEncryptionVersion: integer("registration_encryption_version"),
  registrationEncryptionNonce: varchar("registration_encryption_nonce", { length: 24 }),
  registrationAuthenticationTag: varchar("registration_authentication_tag", { length: 32 }),
  registrationEncryptedToken: citext("registration_encrypted_token"),
  registrationLinkExpiresAt: effectDateTime("registration_link_expires_at"),
  registrationLinkGeneratedAt: effectDateTime("registration_link_generated_at"),
  registrationLinkGeneratedBy: varchar("registration_link_generated_by", { length: 256 }),
  registrationLinkRevealedAt: effectDateTime("registration_link_revealed_at"),
  registrationLinkRevealedBy: varchar("registration_link_revealed_by", { length: 256 }),
  registrationLinkRevokedAt: effectDateTime("registration_link_revoked_at"),
  registrationLinkRevokedBy: varchar("registration_link_revoked_by", { length: 256 }),
  registrationLinkGeneration: integer("registration_link_generation"),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  emailidxIdx: index("pf_invitation_emailidx_idx").on(table.email).where(sql`_deleted = false`),
  statusidxIdx: index("pf_invitation_statusidx_idx").on(table.invitationStatus).where(sql`_deleted = false`),
  invitationididxIdx: uniqueIndex("pf_invitation_invitationididx_idx").on(table.invitationId).where(sql`_deleted = false`),
  pendingemailidxIdx: uniqueIndex("pf_invitation_pendingemailidx_idx").on(table.invitationPendingEmail).where(sql`_deleted = false`),
  registrationtokenhashidxIdx: uniqueIndex("pf_invitation_registrationtokenhashidx_idx").on(table.registrationTokenHash).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_invitation_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const registrationSession = pgTable("pf_registration_session", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `rgs-${ulid()}`),
  registrationSessionTokenHash: varchar("registration_session_token_hash", { length: 64 }).notNull(),
  invitationId: varchar("invitation_id", { length: 41 }).notNull().references(() => invitation.id),
  registrationLinkGeneration: integer("registration_link_generation").notNull(),
  registrationSessionExpiresAt: effectDateTime("registration_session_expires_at").notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  invitationidxIdx: index("pf_registration_session_invitationidx_idx").on(table.invitationId).where(sql`_deleted = false`),
  tokenhashidxIdx: uniqueIndex("pf_registration_session_tokenhashidx_idx").on(table.registrationSessionTokenHash).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_registration_session_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const invitationRole = pgTable("pf_invitation_role", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `ir-${ulid()}`),
  invitationId: varchar("invitation_id", { length: 41 }).notNull().references(() => invitation.id),
  roleId: varchar("role_id", { length: 41 }).notNull().references(() => role.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  invitationroleidxIdx: uniqueIndex("pf_invitation_role_invitationroleidx_idx").on(table.invitationId, table.roleId).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_invitation_role_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const oauthStorage = pgTable("pf_oauth_storage", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `oas-${ulid()}`),
  oauthKey: varchar("oauth_key", { length: 2048 }).notNull(),
  keyKind: varchar("key_kind", { length: 64 }).notNull(),
  keyValue: jsonb("key_value").$type<Record<string, unknown> | unknown[]>().notNull(),
  keyExpiry: effectDateTime("key_expiry"),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  keyidxIdx: uniqueIndex("pf_oauth_storage_keyidx_idx").on(table.oauthKey),
  updatedAtIdIdx: index("pf_oauth_storage_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const oauthProvider = pgTable("pf_oauth_provider", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `opr-${ulid()}`),
  providerName: varchar("provider_name", { length: 64 }).notNull(),
  providerConfig: jsonb("provider_config").$type<Record<string, unknown> | unknown[]>().notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  nameidxIdx: uniqueIndex("pf_oauth_provider_nameidx_idx").on(table.providerName).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_oauth_provider_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const oauthClient = pgTable("pf_oauth_client", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `ocl-${ulid()}`),
  clientId: varchar("client_id", { length: 128 }).notNull(),
  clientSecretHash: varchar("client_secret_hash", { length: 256 }).notNull(),
  audience: varchar("audience", { length: 128 }).notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  clientididxIdx: uniqueIndex("pf_oauth_client_clientididx_idx").on(table.clientId).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_oauth_client_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const jobQueue = pgTable("pf_job_queue", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `qjob-${ulid()}`),
  queue: varchar("queue", { length: 512 }).notNull(),
  jobPayload: jsonb("job_payload").$type<Record<string, unknown> | unknown[]>().notNull(),
  jobAttempts: integer("job_attempts").notNull().default(0),
  jobRetryLimit: integer("job_retry_limit").notNull().default(5),
  availableAt: effectDateTime("available_at").notNull().default(sql`NOW()`),
  lockedUntil: effectDateTime("locked_until"),
  claimReceipt: varchar("claim_receipt", { length: 64 }),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  readyIdxIdx: index("pf_job_queue_ready_idx_idx").on(table.queue, table.lockedUntil, table.jobAttempts, table.availableAt).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_job_queue_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const completedJob = pgTable("pf_completed_job", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `cj-${ulid()}`),
  queue: varchar("queue", { length: 512 }).notNull(),
  jobId: varchar("job_id", { length: 1024 }).notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  jobIdIxIdx: uniqueIndex("pf_completed_job_job_id_ix_idx").on(table.queue, table.jobId).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_completed_job_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const weeklySchedule = pgTable("pf_weekly_schedule", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `ws-${ulid()}`),
  orgUnitId: varchar("org_unit_id", { length: 41 }).notNull().references(() => orgUnit.id),
  dayOfWeek: integer("day_of_week").notNull(),
  timeRanges: jsonb("time_ranges").$type<Record<string, unknown> | unknown[]>().notNull(),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  orgunitdayidxIdx: uniqueIndex("pf_weekly_schedule_orgunitdayidx_idx").on(table.orgUnitId, table.dayOfWeek).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_weekly_schedule_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const calendarPeriod = pgTable("pf_calendar_period", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `calp-${ulid()}`),
  orgUnitId: varchar("org_unit_id", { length: 41 }).notNull().references(() => orgUnit.id),
  periodKind: varchar("period_kind", { length: 64 }).notNull(),
  periodTitle: citext("period_title").notNull(),
  periodStart: effectDateTime("period_start").notNull(),
  periodEnd: effectDateTime("period_end").notNull(),
  periodActive: boolean("period_active").notNull(),
  periodSchedule: jsonb("period_schedule").$type<Record<string, unknown> | unknown[]>(),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  kinddateidxIdx: index("pf_calendar_period_kinddateidx_idx").on(table.periodKind, table.periodStart, table.periodEnd).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_calendar_period_updated_at_id_idx").on(table.updatedAt, table.id),
  periodTitleLengthCheck: check("period_title_length_check", sql.raw(`length("pf_calendar_period"."period_title") <= 256`)),
}))

export const dateException = pgTable("pf_date_exception", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `dex-${ulid()}`),
  orgUnitId: varchar("org_unit_id", { length: 41 }).notNull().references(() => orgUnit.id),
  exceptionDate: effectDateTime("exception_date").notNull(),
  exceptionSlots: jsonb("exception_slots").$type<Record<string, unknown> | unknown[]>().notNull(),
  exceptionNote: citext("exception_note"),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  orgunitdateidxIdx: uniqueIndex("pf_date_exception_orgunitdateidx_idx").on(table.orgUnitId, table.exceptionDate).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_date_exception_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const holidayInstance = pgTable("pf_holiday_instance", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `hol-${ulid()}`),
  orgUnitId: varchar("org_unit_id", { length: 41 }).notNull().references(() => orgUnit.id),
  holidayTitle: citext("holiday_title").notNull(),
  holidayRule: jsonb("holiday_rule").$type<Record<string, unknown> | unknown[]>().notNull(),
  holidayDate: effectDateTime("holiday_date"),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  orgunittitleidxIdx: uniqueIndex("pf_holiday_instance_orgunittitleidx_idx").on(table.orgUnitId, table.holidayTitle).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_holiday_instance_updated_at_id_idx").on(table.updatedAt, table.id),
  holidayTitleLengthCheck: check("holiday_title_length_check", sql.raw(`length("pf_holiday_instance"."holiday_title") <= 256`)),
}))

export const documentStore = pgTable("pf_document_store", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `dstr-${ulid()}`),
  orgUnitId: varchar("org_unit_id", { length: 41 }).notNull().references(() => orgUnit.id),
  name: citext("name").notNull(),
  path: varchar("path", { length: 2048 }).notNull(),
  acceptedTypes: jsonb("accepted_types").$type<Record<string, unknown> | unknown[]>(),
  sizeLimit: integer("size_limit"),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  pathidxIdx: uniqueIndex("pf_document_store_pathidx_idx").on(table.path).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_document_store_updated_at_id_idx").on(table.updatedAt, table.id),
  nameLengthCheck: check("name_length_check", sql.raw(`length("pf_document_store"."name") <= 1024`)),
}))

export const file = pgTable("pf_file", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `file-${ulid()}`),
  documentStoreId: varchar("document_store_id", { length: 41 }).notNull().references(() => documentStore.id),
  fileSize: integer("file_size"),
  mediaKind: varchar("media_kind", { length: 256 }),
  uploadPending: boolean("upload_pending").notNull().default(true),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  updatedAtIdIdx: index("pf_file_updated_at_id_idx").on(table.updatedAt, table.id),
}))

export const stepDocumentStore = pgTable("pf_step_document_store", {
  id: varchar("id", { length: 41 }).primaryKey().$defaultFn(() => `sds-${ulid()}`),
  stepId: varchar("step_id", { length: 41 }).notNull().references(() => step.id),
  documentStoreId: varchar("document_store_id", { length: 41 }).notNull().references(() => documentStore.id),
  createdAt: effectDateTime("created_at").notNull().default(sql`now()`),
  updatedAt: effectDateTime("updated_at").notNull().default(sql`now()`),
  createdBy: varchar("created_by", { length: 256 }).notNull().default("SYSTEM"),
  updatedBy: varchar("updated_by", { length: 256 }).notNull().default("SYSTEM"),
  _deleted: boolean("_deleted").notNull().default(false),
}, (table) => ({
  stepdocstoreidxIdx: uniqueIndex("pf_step_document_store_stepdocstoreidx_idx").on(table.stepId, table.documentStoreId).where(sql`_deleted = false`),
  updatedAtIdIdx: index("pf_step_document_store_updated_at_id_idx").on(table.updatedAt, table.id),
}))

// Views for virtual attributes
export const processItsNoDrafts = pgView("pf_process_its_no_drafts", {
  id: varchar("id", { length: 41 }).notNull(),
  noDrafts: boolean("no_drafts").notNull(),
}).as(sql`
  select
    id,
    not exists (select 1 from pf_process_execution
    join pf_process_state on pf_process_execution.process_state_id = pf_process_state.id and pf_process_state._deleted = false
    where pf_process_state.process_id = pf_process.id and pf_process_execution._deleted = false) as no_drafts
  from pf_process
`)

export const processItsStartStep = pgView("pf_process_its_start_step", {
  id: varchar("id", { length: 41 }).notNull(),
  startStep: varchar("start_step", { length: 41 }),
}).as(sql`
  select
    id,
    (select pf_step.id from pf_step
    join pf_step_its_can_start_process on pf_step.id = pf_step_its_can_start_process.id
    where pf_step.process_id = pf_process.id
    and pf_step_its_can_start_process.can_start_process = true
    and pf_step._deleted = false
    limit 1) as start_step
  from pf_process
`)

export const processItsActiveProcesses = pgView("pf_process_its_active_processes", {
  id: varchar("id", { length: 41 }).notNull(),
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

export const stepItsCanStartProcess = pgView("pf_step_its_can_start_process", {
  id: varchar("id", { length: 41 }).notNull(),
  canStartProcess: boolean("can_start_process").notNull(),
}).as(sql`
  select
    id,
    not exists (select 1 from pf_flow where pf_flow.target_step = pf_step.id and pf_flow._deleted = false) as can_start_process
  from pf_step
`)

export const processStateItsIsDraft = pgView("pf_process_state_its_is_draft", {
  id: varchar("id", { length: 41 }).notNull(),
  isDraft: boolean("is_draft").notNull(),
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
