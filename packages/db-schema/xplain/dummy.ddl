database test.

base name (A1024).
base purpose (T).
base condition (T).
base state (T).
base org unit level (A32).

# Organizational unit - represents departments, divisions, teams, etc.
# Forms a hierarchical tree structure within an organisation.
# parent is a self-referential foreign key to the parent org_unit
type org unit (I9) = name, org unit level, optional parent_org unit.

type process (I9) = org unit, name, purpose.

type role (I9) = org unit, name.

# Currently steps are bound to processes, there are no steps that can
# be reused across processes.
# A step can start a process if it never is mentioned as a target in a flow.
type step (I9) = name, purpose, process, role.

type flow (I9) = source_step, target_step, optional condition.

# Process executions

# Store state per process. When a process hasn't started officially
# yet, user is still filling in the initial form, we just store state.
type process state (I9) = process, state.

# A process which actually has started.
type process execution (I9) = process state.

extend process state with is draft = nil process execution per process state.
extend process with no drafts = nil process execution per process state its process.
extend step with can start process = nil flow per target_step.

type to do (I9) = process execution, flow.

# Count active processes (executions per process)
extend process with active processes = count to do its process execution per process execution its process state its process.

# Where we currently are stopped or working in the flow.
# Either a system
# We still need to solve migrations (between changed process definitions).
type to do (I9) = process execution, flow.

end.
