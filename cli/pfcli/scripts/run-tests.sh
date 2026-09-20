#!/usr/bin/env bash

set -euo pipefail

export PFCLI_TEST_RUN_ID="${PFCLI_TEST_RUN_ID:-$(date +%s%N)}"

shopt -s nullglob

test_files=()
for test_file in test/*.spec.ts; do
  if [[ "$test_file" == *.slow.spec.ts ]]; then
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
# Keep the shared fixture ID above stable across processes to reuse builds.
for test_file in "${test_files[@]}"; do
  bun test "$test_file" --isolate --max-concurrency=1 --timeout=60000 --dots
done
