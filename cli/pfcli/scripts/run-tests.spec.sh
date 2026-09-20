#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
temp_root="$(mktemp -d)"
fake_bin="$temp_root/bin"

cleanup() {
  rm -rf "$temp_root"
}

trap cleanup EXIT
mkdir -p "$fake_bin"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "%s\n" PFCLI_TEST_INVOCATION "$@" >> "$PFCLI_TEST_CAPTURE_PATH"' \
  'exit "${PFCLI_TEST_EXIT_CODE:-0}"' \
  > "$fake_bin/bun"
chmod +x "$fake_bin/bun"

assert_exclusive_nx_test_target() {
  local parallelism
  parallelism="$(
    PFCLI_PROJECT_CONFIG="$project_root/project.json" bun -e '
      const project = await Bun.file(
        process.env["PFCLI_PROJECT_CONFIG"],
      ).json()
      process.stdout.write(String(project.targets?.test?.parallelism))
    '
  )"

  if [[ "$parallelism" != "false" ]]; then
    printf '%s\n' \
      "Expected the CLI test target to reserve the runner with parallelism=false, received: $parallelism" \
      >&2
    return 1
  fi
}

assert_isolated_test_runner() {
  local capture_path="$temp_root/args"

  (
    cd "$project_root"
    export PATH="$fake_bin:$PATH"
    export PFCLI_TEST_CAPTURE_PATH="$capture_path"
    bash "$script_dir/run-tests.sh"
  )

  local expected_invocations=0
  local test_file
  for test_file in "$project_root"/test/*.spec.ts; do
    if [[ "$test_file" == *.slow.spec.ts ]]; then
      continue
    fi
    expected_invocations=$((expected_invocations + 1))
    if [[ "$(grep -Fxc -- "test/$(basename "$test_file")" "$capture_path")" != "1" ]]; then
      printf 'Expected exactly one invocation for %s\n' "$test_file" >&2
      return 1
    fi
  done

  for argument in PFCLI_TEST_INVOCATION --isolate --max-concurrency=1 --timeout=60000; do
    if [[ "$(grep -Fxc -- "$argument" "$capture_path")" != "$expected_invocations" ]]; then
      printf 'Expected %s once per spec file\n' "$argument" >&2
      return 1
    fi
  done

  if grep -Eq -- '^--parallel(=|$)|\.slow\.spec\.ts$' "$capture_path"; then
    printf 'Expected the CLI test runner to exclude parallel workers and slow specs\n' >&2
    return 1
  fi
}

assert_test_failure_propagates() {
  local capture_path="$temp_root/failure-args"
  local status=0
  (
    cd "$project_root"
    export PATH="$fake_bin:$PATH"
    export PFCLI_TEST_CAPTURE_PATH="$capture_path"
    export PFCLI_TEST_EXIT_CODE=23
    bash "$script_dir/run-tests.sh"
  ) || status=$?

  if [[ "$status" != "23" ]] || [[ "$(grep -Fxc PFCLI_TEST_INVOCATION "$capture_path")" != "1" ]]; then
    printf 'Expected the CLI test runner to stop and propagate the first failure\n' >&2
    return 1
  fi
}

assert_exclusive_nx_test_target
assert_isolated_test_runner
assert_test_failure_propagates
