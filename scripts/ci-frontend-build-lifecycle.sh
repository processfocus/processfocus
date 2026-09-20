#!/usr/bin/env bash
# Cleanup helpers are reached through traps (ShellCheck does not follow them).
# shellcheck disable=SC2329
set -euo pipefail

# Linux CI/local verification supervisor. The command must not daemonize or
# escape its session. SIGINT, SIGTERM and SIGHUP are supported; SIGKILL cannot
# run cleanup, but even surviving descendants cannot inherit the lock.
# Tests use this same seam with small commands in disposable Git worktrees.
set +m
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
worktree_root="$(git rev-parse --show-toplevel)"
cd "$worktree_root"
git_dir="$(git rev-parse --absolute-git-dir)"
lock_path="${git_dir}/ci-frontend-build.lock"
lock_wait="${PF_FRONTEND_BUILD_LOCK_WAIT_SECONDS:-120}"
shutdown_wait="${PF_FRONTEND_BUILD_SHUTDOWN_SECONDS:-5}"
for duration in "$lock_wait" "$shutdown_wait"; do
  if [[ ! "$duration" =~ ^[0-9]+$ || ${#duration} -gt 5 ]]; then
    echo "ERROR: frontend build wait durations must be integers from 0 to 99999 seconds" >&2
    exit 2
  fi
done
shutdown_wait=$((10#$shutdown_wait))

# Discard ambient ownership claims before installing any cleanup trap.
unset CI_FRONTEND_BUILD_DB_DIR CI_FRONTEND_BUILD_DB_PATH CI_FRONTEND_BUILD_DB_MARKER CI_FRONTEND_BUILD_DB_OWNER
worker_pid=""
owned_processes_alive() {
  ps -eo pid=,pgid=,stat= 9>&- | awk -v owner="$worker_pid" \
    '($1 == owner || $2 == owner) && $3 !~ /^Z/ { alive=1 } END { exit !alive }' 9>&-
}
cleanup() {
  local status=$?
  trap - EXIT
  trap '' INT TERM HUP
  if [[ -n "$worker_pid" ]]; then
    # The session leader and every ordinary descendant belong only to this
    # invocation. Kill the PID too in case termination raced setsid startup.
    kill -TERM -- "-$worker_pid" "$worker_pid" 2>/dev/null || true
    local deadline=$((SECONDS + shutdown_wait))
    while owned_processes_alive && (( SECONDS < deadline )); do
      sleep 0.1 9>&-
    done
    if owned_processes_alive; then
      echo "Frontend build: escalating owned process group $worker_pid to SIGKILL" >&2
      kill -KILL -- "-$worker_pid" 2>/dev/null || true
    fi
    kill -KILL "$worker_pid" 2>/dev/null || true
    # Reap our direct child and wait for remaining descendants to stop before
    # deleting the database. Orphan zombies have exited and cannot write it.
    deadline=$((SECONDS + 5))
    while owned_processes_alive; do
      if (( SECONDS >= deadline )); then
        echo "ERROR: owned process group $worker_pid did not stop; preserving database at ${CI_FRONTEND_BUILD_DB_PATH:-unallocated}" >&2
        exit 1
      fi
      sleep 0.1 9>&-
    done
    wait "$worker_pid" 2>/dev/null || true
  fi
  cleanup_ci_frontend_build_database
  exit "$status"
}
# shellcheck source=scripts/ci-frontend-build-database.sh
source "${script_dir}/ci-frontend-build-database.sh"
trap cleanup EXIT
# Defer signals across resource allocation and PID registration so an interrupt
# cannot land between spawning a child and recording its ownership.
registering=0
interrupted=0
interrupt() {
  interrupted="$1"
  if (( registering == 0 )); then exit "$interrupted"; fi
}
finish_registration() {
  registering=0
  if (( interrupted != 0 )); then exit "$interrupted"; fi
}
trap 'interrupt 130' INT
trap 'interrupt 143' TERM
trap 'interrupt 129' HUP

# Git's per-worktree directory canonicalizes symlink aliases and is distinct
# for linked worktrees. Never unlink this file: waiters share its inode.
exec 9>"$lock_path"
if ! flock -n 9; then
  echo "Frontend build waiting up to ${lock_wait}s for ${worktree_root}/apps/frontend output (lock: $lock_path). Wait for the owning build or stop that invocation." >&2
  # Async wait lets Bash dispatch signals promptly, even during contention.
  registering=1
  flock -E 75 -w "$lock_wait" 9 &
  worker_pid=$!
  finish_registration
  lock_status=0
  wait "$worker_pid" || lock_status=$?
  worker_pid=""
  if (( lock_status != 0 )); then
    echo "ERROR: frontend build lock acquisition failed (status $lock_status): $lock_path" >&2
    exit "$lock_status"
  fi
fi

registering=1
create_ci_frontend_build_database
finish_registration
export SQLITE_DATABASE_PATH="$CI_FRONTEND_BUILD_DB_PATH"
# No command in the build tree receives fd 9, including foreground build tools.
registering=1
setsid -- "$@" 9>&- &
worker_pid=$!
finish_registration
status=0
wait "$worker_pid" || status=$?
exit "$status"
