#!/usr/bin/env bash
# One CI job, one Playwright worker, one disposable demo DB/runtime. Do not run
# concurrently in a checkout: the local runtime owns workspace port files.
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
unset APPSYNC_EVENTS_HTTP_HOST APPSYNC_EVENTS_REALTIME_HOST
unset FRONTEND_E2E_FEATURES FRONTEND_E2E_FEATURES_ROOT FRONTEND_E2E_TAGS
unset FRONTEND_E2E_SERVER_COMMAND PLAYWRIGHT_REUSE_EXISTING_SERVER
export FRONTEND_E2E_BROWSERS=chromium
export GOOGLE_CLIENT_ID=ci-google-client-id
export GOOGLE_CLIENT_SECRET=ci-google-client-secret
export CI_PIPELINE_SECRET=ci-pipeline-secret
export E2E_SKIP_DELAYS=true
# Keep each feature on one worker/runtime. PR #4111 spent 167s in submissions
# and 148s in work before setup/reporting; give their independent features
# separate runtimes to leave headroom inside the four-minute review budget.
# Navigation is the complement, so newly added features remain covered.
group="${FRONTEND_REGULAR_GROUP:-all}"
settings_features='settings\.feature'
submissions_features='without-waiting\.feature'
policies_features='without-waiting-policies\.feature'
work_features='subscription\.feature'
completion_features='todo-completion\.feature'
grouped_features="$settings_features|$submissions_features|$policies_features|$work_features|$completion_features"
selected_features='.*'
case "$group" in
  all) ;;
  settings) selected_features="$settings_features" ;;
  submissions) selected_features="$submissions_features" ;;
  policies) selected_features="$policies_features" ;;
  work) selected_features="$work_features" ;;
  completion) selected_features="$completion_features" ;;
  navigation) ;;
  *) echo "Unknown regular frontend group: $group" >&2; exit 1 ;;
esac
excluded='Frontend boot health'
if [[ "$group" == navigation ]]; then
  excluded="$excluded|$grouped_features"
fi
rm -f "$PR_REVIEW_BROWSER_COUNTS" "$PR_REVIEW_BROWSER_COUNTS.progress.json" "$PLAYWRIGHT_JUNIT_OUTPUT_FILE" "$PR_REVIEW_EVIDENCE_DIR/regular-safe.xml"
rm -rf "$PR_REVIEW_EVIDENCE_DIR/regular-safe-output"
result=0
# Zero-plugin boot health already has a dedicated lane. The other regular
# without-waiting scenarios differ from the specialised lifecycle fixture.
bun scripts/nx-quiet.ts run @pf/frontend-e2e:e2e "$@" \
  --workers=1 --retries=0 --trace=off \
  --grep="$selected_features" --grep-invert="$excluded" \
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
