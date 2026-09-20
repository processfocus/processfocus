#!/usr/bin/env bash

set -euo pipefail

export PFCLI_TEST_RUN_ID="${PFCLI_TEST_RUN_ID:-$(date +%s%N)}"

shopt -s nullglob

slow_test_files=(test/*.slow.spec.ts)

if [ ${#slow_test_files[@]} -eq 0 ]; then
  exit 0
fi

bun test "${slow_test_files[@]}" --max-concurrency=1
