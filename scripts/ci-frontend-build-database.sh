#!/usr/bin/env bash

# Ownership contract for ci-frontend-build.sh's temporary SQLite database:
# - allocation always creates a new directory for the current invocation;
# - cleanup only removes the fixed database artifacts inside that directory;
# - the invocation-specific marker must still match before anything is removed.
#
# An ambient database path is never ownership proof. Callers must not populate
# these CI_FRONTEND_BUILD_* variables themselves. If any ownership check fails,
# cleanup fails closed and leaves every artifact in place.

create_ci_frontend_build_database() {
  CI_FRONTEND_BUILD_DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ci-frontend-build.XXXXXX")"
  CI_FRONTEND_BUILD_DB_PATH="${CI_FRONTEND_BUILD_DB_DIR}/runtime.db"
  CI_FRONTEND_BUILD_DB_MARKER="${CI_FRONTEND_BUILD_DB_DIR}/.owner"
  CI_FRONTEND_BUILD_DB_OWNER="${BASHPID}-${RANDOM}-${RANDOM}"

  printf '%s\n' "$CI_FRONTEND_BUILD_DB_OWNER" >"$CI_FRONTEND_BUILD_DB_MARKER"
}

cleanup_ci_frontend_build_database() {
  local database_dir="${CI_FRONTEND_BUILD_DB_DIR:-}"
  local database_path="${CI_FRONTEND_BUILD_DB_PATH:-}"
  local marker_path="${CI_FRONTEND_BUILD_DB_MARKER:-}"
  local expected_owner="${CI_FRONTEND_BUILD_DB_OWNER:-}"
  local actual_owner=""

  if [[ -z "$database_dir" || -z "$database_path" || -z "$marker_path" || -z "$expected_owner" ]]; then
    return 0
  fi

  if [[ -L "$database_dir" || ! -d "$database_dir" ||
    "$database_path" != "${database_dir}/runtime.db" ||
    "$marker_path" != "${database_dir}/.owner" ]]; then
    echo "Refusing SQLite cleanup: temporary database ownership could not be proved" >&2
    return 0
  fi

  if ! IFS= read -r actual_owner <"$marker_path" || [[ "$actual_owner" != "$expected_owner" ]]; then
    echo "Refusing SQLite cleanup: temporary database ownership marker does not match" >&2
    return 0
  fi

  rm -f -- \
    "$database_path" \
    "${database_path}-shm" \
    "${database_path}-tshm" \
    "${database_path}-twal" \
    "${database_path}-wal" \
    "$marker_path"
  rmdir -- "$database_dir" 2>/dev/null || true
}
