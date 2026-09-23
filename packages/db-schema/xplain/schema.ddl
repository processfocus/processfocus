base path (A2048). # A path is a fully qualified path to an entity in an organisation
base name (C1024).
base purpose (T).
base condition (T).
base state  (J).
base org unit level (A64).
base email (A320). # Email address
base provider (A128).
base sub (A256). # Provider id, such as Google OAuth user ID
base passkey credential id (A2048). # WebAuthn credential ID, encoded as base64url
base passkey public key (A2048). # WebAuthn credential public key, encoded as base64url
base signature counter (A16). # Unsigned WebAuthn authenticator signature counter
base passkey transports (J). # Authenticator transports reported during registration
base passkey name (A128). # User-chosen Passkey label; absent on legacy credentials
base passkey last used at (D). # Most recent successful sign-in using this credential; absent until observed
base first name (C128).
base last name (C128).
base picture (A1024). # URL of user picture.
base locale (A35). # IETF BCP 47 / RFC 5646: en, de, en-GB, zh-Hant-TW.
base form fields (I4). # Number of fields in a form (only for Form steps)
base fallback branch (B). # Whether this flow is the fallback/else branch (taken when no conditional flows match)
base error branch (B). # Whether this flow runs after a terminal system-step failure
base error tags (J). # Optional case-sensitive outer error tags for error branches
base flow key (A128). # Stable identity for a modeled flow branch across hydrations
base oauth key (A2048). # Key for oauth storage
base key kind (A64). # Type of stored data: authorization_code, refresh_token, signing_key, etc.
base key value (J). # JSON value stored
base key expiry (D). # Expiry date for oauth storage
base last logged in (D).
base finished at (D).
base abandoned at (D).
base abandoned reason (T).
base scheduled at (D). # Target execution time for scheduled flows
base business duration (I8). # Duration in business hours, stored as milliseconds
base sla target at (D). # When todo is due (calculated from step SLA)
base sla warning at (D). # Warning threshold time for todo
base failure reason (T).
base correction required at (D). # Public Completion is waiting for provider-user correction.
base correction failure reason (T). # Delivery failure details that triggered correction.
base correction invitation attempt id (A41). # Public completion invitation attempt that triggered correction.

# Organizational unit - represents departments, divisions, teams, etc.
# Forms a hierarchical tree structure within an organisation.
# parent is a self-referential foreign key to the parent org_unit (implicitly optional 0..1)
# acronym is an optional shortened form of the name (e.g., "IT" for "Information Technology")
# timezone is an IANA timezone identifier (e.g., "Europe/Amsterdam"), inherited from the root organisation
base acronym (C64).
base timezone (A64).
base start day of week (I1). # 0=Sunday, 6=Saturday - first day of business week
type org unit "ou" = name, org unit level, parent_org unit, path, optional acronym, timezone, optional start day of week.
default org unit its timezone = "UTC".
default org unit its start day of week = 0. # Sunday default
unique index org unit its pathidx = path.

# SLA columns for processes and steps
# sla_value: Duration amount in the specified unit
# sla_unit: "businessHours" | "businessDays" | "businessWeeks"
# sla_warning: Warning threshold percentage (0-100), default 80
base sla value (I8).
base sla unit (A16).
base sla warning (I3).

type process "prc" = org unit, name, path, purpose, optional sla value, optional sla unit, optional sla warning.
unique index process its pathidx = path.
extend process with no drafts = nil process execution per process state its process.

type role "role" = org unit, name, path.
unique index role its pathidx = path.
unique index role its orgunitunameidx = org unit, name.

# A phase groups steps visually in a process workflow.
# Phases are process-specific and have an explicit display order.
base phase order (I4). # Display order of the phase within its process (1-based)
type phase "ph" = process, name, path, phase order.
unique index phase its pathidx = path.

# Role responsibility describes what a role does in a specific process.
# Has an explicit display order (1-based) from the responsibilities array in the process.
base responsibility (T).
base responsibility order (I4). # Display order within the process (1-based)
type role responsibility "rr" = process, role, responsibility, responsibility order.
unique index role responsibility its processroleidx = process, role.

# Currently steps are bound to processes, there are no steps that can
# be reused across processes.  Every step has a primary role which can
# execute this by default. It is used as the default authorisation in
# our Cedar authorisation polciies, but it's easy to grant other roles
# access to start a process or complete a role.
# Having a primary role here also helps to make clearer visualisations.
# For system steps (SystemStep), role is NULL - they are executed by the system.
base has for each (B).
# Whether a step is intentionally embeddable as an anonymous/public start form.
base embedded (B).
# Retry limit for system steps: 0 = no retries (fail immediately), 1+ = retry count.
# NULL means use system default. Only applies to system steps (role IS NULL).
base retry limit (I2).
type step "step" = name, path, purpose, process, optional role, optional form fields, optional phase, optional sla value, optional sla unit, optional sla warning, has for each, embedded, optional retry limit.
default step its has for each = false.
default step its embedded = false.
unique index step its pathidx = path.

# Supporting roles for a step — additional roles that can complete the
# form beyond the primary role. The primary role lives on step.role.
type step supporting role "ssr" = step, role.
unique index step supporting role its steproleidx = step, role.

# Connect steps.
# If the step is conditional, "condition" is a human-readable description of
# the condition.
# If the step is scheduled, "schedule" is a human-readable description of
# when the transition should trigger.
base schedule (T).
type flow "flow" = flow key, source_step, target_step, optional condition, optional schedule, fallback branch, error branch, optional error tags.
default flow its fallback branch = false.
default flow its error branch = false.
unique index flow its flowkeyidx = flow key.
index flow its sourcetargetidx = source_step, target_step.

# A step can start a process if it never is mentioned as a target in a flow.
extend step with can start process = nil flow per target_step.

# Any step without precursor could be a start step, we just pick one, as
# for now we will assume there is only one.
extend process with start step = some step where can start process per process.

# External participants are durable identities for people outside the organisation
# who submit embedded or public forms. They are not provider users and cannot log in.
type external participant "xp" = email.
unique index external participant its emailidx = email.

# Process executions

# Store state per process. When a process hasn't started officially yet,
# user is still filling in the initial form, we just store state.
# started_by_user tracks authenticated internal/service starts.
# started_by_external_participant tracks embedded-form starts by external people.
# started_by_role tracks the authorizing role and may coexist with either starter.
type process state "pst" = process, start_step, state, optional started by_user, optional started by_external participant, optional started by_role.
assert process state its single starter (true) = started by_user == nil or started by_external participant == nil.
extend process state with is draft = nil process execution per process state.

# A process which actually has started.
# business_duration stores the elapsed business hours (in ms) when execution completes.
base without waiting (B).
type process execution "pex" = without waiting, process state, optional finished at, optional business duration, optional abandoned at, optional abandoned reason.
default process execution its without waiting = false.

# Where we currently are stopped or working in the flow.
# A to do is either for a role (system or provider user), or assigned to a specific user.
# Flow indicates the precursor step (why are we here?).
# TODO: solve migrations (between changed process definitions).
# Could store flow executed against a process execution? Then at least
# you could see historic. Well, that's the todo right?
# For a system we queue the to do item to be picked up by a worker.
# business_duration stores elapsed business hours (in ms) when step completes.
# correction invitation attempt id intentionally stays FK-free: public completion
# invitation attempts already point at to do, and adding the reverse FK would make
# correction state circular for migrations and cleanup.
# completed_by_role tracks the authorizing role and may coexist with either completer.
base item data (J).
base for each barrier (B).
base barrier scheduled flow id (A41). # References scheduled_flow.id for forEach barrier pattern (no FK to allow barrier deletion)
type to do "todo" = process execution, flow, optional completed by_user, optional completed by_external participant, optional assigned to_provider user, optional business duration, optional sla target at, optional sla warning at, optional failure reason, optional correction required at, optional correction failure reason, optional correction invitation attempt id, optional item data, optional barrier scheduled flow id, optional completed by_role.
assert to do its single completer (true) = completed by_user == nil or completed by_external participant == nil.

# Public completion invitation attempts track each externally sent public to-do link.
# Provider metadata is secondary delivery information and is filled in only when
# the notification sender returns a delivery receipt.
base provider message id (A256).
base provider sent to (T).
base delivery status (A32).
base delivery event id (A256).
base delivery failure kind (A64).
base delivery failure reason (T).
type public completion invitation attempt "pcia" = to do, email, optional provider message id, optional provider sent to, optional delivery status, optional delivery event id, optional delivery failure kind, optional delivery failure reason.
index public completion invitation attempt its todoidx = to do.

# Count active processes (executions per process)
extend process with active processes = count to do its process execution per process execution its process state its process.

# When next steps have to be scheduled, we put an entry in this table
# for the following reasons:
# 1. It allows us to track executions that have not yet
#    completed. They are defined as ones that have todos, or an entry in
#    this table.
# 2. It prevents spurious or duplicate scheduling in the job
#    handler. We send it a message with the id of the scheduled flow,
#    but if that id does not exist, this means either the transaction
#    failed to commit, or isn't yet visible to it, as the handler
#    started before the db commit. This is not an issue, it will
#    retry. It won't consider not having this id a failure, but retry
#    until max attempts is reached (and then mark it as done).
#    Basically this emulates 2 phase commit between db and a queue.
# 3. It allows us to track failed scheduling slightly more easily. We
#    could look in the DLQ or log files, but this gives us immediate
#    visibility in flows that didn't schedule, and executions that should
#    be marked as active or failed.
# When target_step is set, only evaluate the specific flow to that target.
# When scheduled_at is set, the flow should execute at that time (for deferred flows).
type scheduled flow "sf" = process execution, source_step, optional target_step, optional scheduled at, for each barrier, optional completed by_role.
default scheduled flow its for each barrier = false.

# A user (or application) who can authenticate and use the system
type user "usr" = provider, sub, last logged in.
unique index user its uniquesub = provider, sub.

# Application-owned WebAuthn credential linked to its backing identity.
type passkey credential "pkc" = user, passkey credential id, passkey public key, signature counter, optional passkey transports, optional passkey name, optional passkey last used at.
unique index passkey credential its credentialidx = passkey credential id.

# Provider user - authenticated via an identity provider, can use the system
type provider user "pu" = [user], email, name, first name, last name, picture, locale, org unit.
unique index provider user its emailidx = email.

# A durable named Delegation is not a Provider User. Names are claimed only while live.
base delegation name (A128).
base active delegation name (A128).
base secret verifier (A64).
base secret issued at (D).
base secret expires at (D).
base secret revoked at (D).
base secret last used at (D).
base delegation event (A32).
type delegation "dlg" = owner_provider user, delegation name, optional active delegation name, optional secret revoked at.
unique index delegation its ownernameidx = owner_provider user, active delegation name.
type secret generation "dsg" = delegation, secret verifier, secret issued at, secret expires at, optional secret revoked at, optional secret last used at, parent_secret generation.
unique index secret generation its verifieridx = secret verifier.
index secret generation its delegationidx = delegation.
type delegation history "dgh" = delegation, secret generation, actor_provider user, delegation event, secret issued at, optional old_delegation name, optional new_delegation name, optional actor_delegation, optional actor_secret generation.

# A provider user can have zero or more roles
type provider user role "pur" = provider user, role.
unique index provider user role its provideruserroleidx = provider user, role.

# User settings for notification preferences and other per-user configuration
base notification preference (J).

type user settings "us" = [user], notification preference.

# Permitted roles for role switching (validated by Cedar, consumed by auth server)
# These are ephemeral - deleted and recreated when permittedRoles is queried
type permitted role "pr" = provider user, role.
unique index permitted role its provideruserroleidx = provider user, role.

# Permitted client roles for M2M role switching (validated by Cedar, consumed by auth server)
# Same as permitted role but for oauth clients (service accounts)
type permitted client role "pcr" = oauth client, role.
unique index permitted client role its oauthclientroleidx = oauth client, role.

# M2M roles can swap out their service token for a provider user token, if
# permitted by Cedar. This is used for frontend e2e testing.
type permitted client email "pce" = oauth client, email.
unique index permitted client email its oauthclientemailidx = oauth client, email.

# An invitation for a user to join the organisation with pre-assigned roles.
# Lifecycle: pending -> accepted (first verified human-provider bootstrap) or
# legacy_closed (migration found a pre-existing Provider User). Soft-delete
# (_deleted) is the deleted outcome. Accepted and legacy-closed rows remain
# durable history; only pending rows may be ordinary-edited or reissued.
base invitation id (A128). # Unique identifier for the invitation (from construct id)
base invitation status (A32). # pending | accepted | legacy_closed
base invitation source (A32). # model | dashboard | process | legacy
# Denormalized email for pending uniqueness. Null when accepted/legacy_closed
# so historical rows can share an email with a future pending invitation.
base invitation pending email (A320).
base invitation accepted at (D).
base invitation accepted by provider (A64).
base invitation accepted by subject (A256).
base invitation legacy closed at (D).
base invitation legacy closure reason (A128).
# Passkey Registration Link (bearer capability). Plaintext never stored.
# Hash is SHA-256 of the 32-byte token, base64url-encoded, uniquely indexed
# for constant-shape lookup. Envelope is AES-256-GCM under a dedicated key.
base registration token hash (A64).
base registration encryption version (I2).
base registration encryption nonce (A24). # AES-GCM nonce, base64url
base registration authentication tag (A32). # AES-GCM tag, base64url
base registration encrypted token (T). # AES-GCM ciphertext, base64url
base registration link expires at (D).
base registration link generated at (D).
base registration link generated by (A256).
base registration link revealed at (D).
base registration link revealed by (A256).
base registration link revoked at (D).
base registration link revoked by (A256).
# Monotonic generation counter; Registration Sessions bind to a generation.
base registration link generation (I8).
type invitation "inv" = invitation id, email, invitation status, invitation source, optional invitation pending email, optional invitation accepted at, optional invitation accepted by provider, optional invitation accepted by subject, optional accepted by_provider user, optional invitation legacy closed at, optional invitation legacy closure reason, optional registration token hash, optional registration encryption version, optional registration encryption nonce, optional registration authentication tag, optional registration encrypted token, optional registration link expires at, optional registration link generated at, optional registration link generated by, optional registration link revealed at, optional registration link revealed by, optional registration link revoked at, optional registration link revoked by, optional registration link generation.
default invitation its invitation status = "pending".
default invitation its invitation source = "legacy".
unique index invitation its invitationididx = invitation id.
# At most one pending Invitation per Normalized Email among non-deleted rows.
unique index invitation its pendingemailidx = invitation pending email.
# Live Registration Link lookup by token hash (null when no live link).
unique index invitation its registrationtokenhashidx = registration token hash.
index invitation its emailidx = email.
index invitation its statusidx = invitation status.

# Short-lived Registration Session derived from a live Registration Link.
# Browser holds the raw bearer in an HttpOnly cookie; only the hash is stored.
# Sessions bind Invitation ID and Registration Link generation so rotation,
# revocation, edit, deletion, and acceptance invalidate them immediately.
base registration session token hash (A64).
base registration session expires at (D).
type registration session "rgs" = registration session token hash, invitation, registration link generation, registration session expires at.
unique index registration session its tokenhashidx = registration session token hash.
index registration session its invitationidx = invitation.

# An invitation can have one or more roles to be assigned
type invitation role "ir" = invitation, role.
unique index invitation role its invitationroleidx = invitation, role.

# OAuth storage - for OpenAuth state, tokens, and keys.
# Used by our authorisation server.
# We treat oauth storage special, it has no soft delete.
type oauth storage "oas" = oauth key, key kind, key value, optional key expiry.
unique index oauth storage its keyidx = oauth key.

# OAuth provider configuration
base provider name (A64). # OAuth provider name: google, github, etc.
base provider config (J). # Full Oauth2WrappedConfig as JSON

type oauth provider "opr" = provider name, provider config.
unique index oauth provider its nameidx = provider name.

# OAuth client for M2M (machine-to-machine) authentication via client_credentials grant
base client id (A128).
base client secret hash (A256). # Argon2 hash of the client secret
base audience (A128). # Audience claim for tokens issued to this client

type oauth client "ocl" = client id, client secret hash, audience.
unique index oauth client its clientididx = client id.

# Queue jobs for background processing
base queue (A512). # Type of job (e.g., "send_email", "process_webhook")
base job payload (J). # JSON payload for job
#base job status (A32). # Status: pending, processing, completed, failed, dead_letter
#base job error (T). # Error message if processing failed
base job attempts (I4). # Number of processing attempts so far
base job retry limit (I4). # Maximum number of retry attempts
base available at (D). # When is job available for pickup? Allows delayed scheduling
base locked until (D). # When job becomes visible again (for retries with visibility timeout)
base claim receipt (A64). # Opaque token identifying the current claim lease

type job queue "qjob" = queue, job payload, job attempts, job retry limit, available at, optional locked until, optional claim receipt.
default job queue its job attempts = 0.
default job queue its job retry limit = 5.
default job queue its available at = systemdate.
index job queue its ready idx = queue, locked until, job attempts, available at.

# We need to track that a job is done, which is defined as the database
# transaction has committed. We cannot repeat those jobs, even if we fail
# after, and never get to acknowledge completion.
# The queue service will reschedule the job, so we need to recognise we're
# actually done. Basically what we're doing is implementing a poor
# man's 2-phase commit between a queue and our database.
base job id (A1024). # Opaque value for the job id retrieved from a queue
type completed job "cj" = queue, job id.
unique index completed job its job id ix = queue, job id.

# Business Calendar - weekly schedules, periods, exceptions, and holidays
# Design principle: "Closed by default" - only store when open, no non_working_day table needed.

# Weekly schedule - stores when org is open per day of week
base day of week (I1). # 0=Sunday, 6=Saturday
base time ranges (J). # Array of {open: {hour, minute}, close: {hour, minute}}

type weekly schedule "ws" = org unit, day of week, time ranges.
unique index weekly schedule its orgunitdayidx = org unit, day of week.

# Calendar period kind: "school_term", "shop_season", "fiscal_quarter", etc.
base period kind (A64).
base period title (C256).
base period start (D).
base period end (D).
base period active (B). # Whether this period counts as active/working
base period schedule (J). # Optional weekly schedule override as JSON

# Calendar periods - date ranges representing terms, seasons, schedules
# When requireActivePeriod is set on a calendar, dates outside active periods
# of that kind are non-business days.
type calendar period "calp" = org unit, period kind, period title, period start, period end, period active, optional period schedule.
index calendar period its kinddateidx = period kind, period start, period end.
index calendar period its orgunitidx = org unit.

# Date exceptions - one-off overrides for specific dates
# Takes precedence over holidays and periods.
base exception date (D).
base exception slots (J). # Array of {open, close} or "closed"
base exception note (T).

type date exception "dex" = org unit, exception date, exception slots, optional exception note.
unique index date exception its orgunitdateidx = org unit, exception date.

# Holiday rules - stored holiday rules (not computed dates) with org_unit FK
# The holidayDate is optional since rules are stored, not instances
base holiday date (D).
base holiday title (C256).
base holiday rule (J). # The rule definition (FixedHoliday, NthWeekdayHoliday, etc.)

type holiday instance "hol" = org unit, holiday title, holiday rule, optional holiday date.
unique index holiday instance its orgunittitleidx = org unit, holiday title.

# Document store - tracks file storage locations per org unit
base accepted types (J).
base size limit (I8). # Maximum file size in bytes

type document store "dstr" = org unit, name, path, optional accepted types, optional size limit.
unique index document store its pathidx = path.

# File - tracks individual uploaded files within a document store
base file size (I8).
base media kind (A256). # MIME content type of the uploaded file
base upload pending (B).

type file "file" = document store, optional file size, optional media kind, upload pending.
default file its upload pending = true.

# Junction table linking steps to document stores they reference
# Enables authorization: user can only upload/download if step references the store
type step document store "sds" = step, document store.
unique index step document store its stepdocstoreidx = step, document store.
