#!/usr/bin/env bash

set -euo pipefail

export PFCLI_TEST_FIXTURE_ROOT
PFCLI_TEST_FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pfcli-fixtures-XXXXXX")"
trap 'rm -rf -- "$PFCLI_TEST_FIXTURE_ROOT"' EXIT

shopt -s nullglob

# Cross-project build/distribution specs run in @pf/build-tests:cli-contract,
# whose private dependency edges include deployment and organisation fixtures.
test_files=()
for test_file in test/*.spec.ts; do
  if [[ "$test_file" == *.slow.spec.ts || "$test_file" == */build.spec.ts || "$test_file" == */distribution-build.spec.ts ]]; then
    continue
  fi

  test_files+=("$test_file")
done

if [ ${#test_files[@]} -eq 0 ]; then
  exit 0
fi

# Several pfcli specs mutate process-wide state. Use a fresh Bun process for
# each file: reusing one runner across isolated files can leave exited children
# unreaped and make both subprocess and archive-command tests time out.
# Keep the owned fixture root above stable across processes to reuse builds.
for test_file in "${test_files[@]}"; do
  bun test "$test_file" --isolate --max-concurrency=1 --timeout=60000 --dots
done
