#!/usr/bin/env bash

set -euo pipefail

export PFCLI_TEST_FIXTURE_ROOT
PFCLI_TEST_FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pfcli-fixtures-XXXXXX")"
trap 'rm -rf -- "$PFCLI_TEST_FIXTURE_ROOT"' EXIT

shopt -s nullglob

slow_test_files=(test/*.slow.spec.ts)

if [ ${#slow_test_files[@]} -eq 0 ]; then
  exit 0
fi

# Match the fast runner's process isolation: these specs mutate globals and
# exercise child processes and sockets. Keep the fixture ID shared across files.
for test_file in "${slow_test_files[@]}"; do
  bun test "$test_file" --isolate --max-concurrency=1 --timeout=60000
done
