#!/usr/bin/env bash
# One build and one Playwright invocation; each worker owns a disposable runtime.
set -euo pipefail
cd "$(dirname "$0")/../../.."
export PR_REVIEW_EVIDENCE_DIR="${PR_REVIEW_EVIDENCE_DIR:-$PWD/pr-review-evidence}"
mkdir -p "$PR_REVIEW_EVIDENCE_DIR"
export PR_REVIEW_BROWSER_COUNTS="$PR_REVIEW_EVIDENCE_DIR/regular-counts.json"
export PLAYWRIGHT_JUNIT_OUTPUT_FILE="$PR_REVIEW_EVIDENCE_DIR/regular.xml"
export PR_REVIEW_PROFILE_LABEL=frontend-regular
# Never inherit a deployed target, specialised feature subset, or shared DB.
unset BASE_URL SQLITE_DATABASE_PATH PF_ORG PF_INSTANT_E2E
# Start a fresh Nx invocation even when called from an outer Nx task.
unset NX_INVOCATION_ROOT_PID
unset OAUTH_ISSUER_URL GRAPHQL_ENDPOINT E2E_CLIENT_ID
unset FRONTEND_JWT_TOKEN FRONTEND_E2E_REGISTRATION_LINKS
unset APPSYNC_EVENTS_HTTP_HOST APPSYNC_EVENTS_REALTIME_HOST
unset FRONTEND_E2E_FEATURES FRONTEND_E2E_FEATURES_ROOT FRONTEND_E2E_TAGS
unset FRONTEND_E2E_SERVER_COMMAND PLAYWRIGHT_REUSE_EXISTING_SERVER
export FRONTEND_E2E_BROWSERS=chromium
export GOOGLE_CLIENT_ID=ci-google-client-id
export GOOGLE_CLIENT_SECRET=ci-google-client-secret
export CI_PIPELINE_SECRET=ci-pipeline-secret
export E2E_SKIP_DELAYS=true
rm -f "$PR_REVIEW_BROWSER_COUNTS" "$PR_REVIEW_BROWSER_COUNTS.progress.json" "$PLAYWRIGHT_JUNIT_OUTPUT_FILE" "$PR_REVIEW_EVIDENCE_DIR/regular-safe.xml"
rm -rf "$PR_REVIEW_EVIDENCE_DIR/regular-safe-output"
result=0
if [[ "${1:-}" == --dashboard-built ]]; then
  shift
else
  bun scripts/nx-quiet.ts run @processfocus/runtime-local:dashboard-build
fi
export FRONTEND_E2E_ISOLATED_WORKERS=1
bun scripts/nx-quiet.ts run @pf/frontend-e2e:e2e "$@" \
  --retries=0 --trace=off --grep-invert='(boot-health|embedded-forms)\.feature\.spec\.js' \
  --output="$PR_REVIEW_EVIDENCE_DIR/regular-output" \
  --reporter="line,junit,$PWD/scripts/pr-review-playwright-reporter.mjs" || result=$?
if ! bun apps/frontend-e2e/scripts/sanitize-regular-reports.ts "$PR_REVIEW_EVIDENCE_DIR"; then
  # Fail closed: never upload partially sanitised reports.
  rm -f "$PR_REVIEW_EVIDENCE_DIR/regular-safe.xml"
  rm -rf "$PR_REVIEW_EVIDENCE_DIR/regular-safe-output"
  result=1
fi
bun scripts/pr-review-evidence.ts guard --directory "$PR_REVIEW_EVIDENCE_DIR" --label regular --kind playwright \
  --path "$PR_REVIEW_BROWSER_COUNTS" || result=1
exit "$result"
