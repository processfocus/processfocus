#!/usr/bin/env bash
set -euo pipefail

# The existing supervisor owns the process group, lock, and disposable database.
if [[ "${1:-}" == "--owned-worker" ]]; then
  shift
else
  exec bash scripts/ci-frontend-build-lifecycle.sh bash "$0" --owned-worker "$@"
fi

available_port() {
  bun -e 'const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); process.stdout.write(String(server.port)); await server.stop(true)'
}
AUTH_PORT="$(available_port)"
GQL_PORT="$(available_port)"
while [[ "$GQL_PORT" == "$AUTH_PORT" ]]; do GQL_PORT="$(available_port)"; done
ORG="examples/demo"
export SQLITE_DATABASE_PATH="${SQLITE_DATABASE_PATH:?Supervisor must provide temporary database}"
export OAUTH_ISSUER_URL="http://localhost:${AUTH_PORT}"
export GRAPHQL_ENDPOINT="http://localhost:${GQL_PORT}/graphql"
export GOOGLE_CLIENT_ID="ci-google-client-id"
export GOOGLE_CLIENT_SECRET="ci-google-client-secret"
export CI_PIPELINE_SECRET="ci-pipeline-secret"
export INTERNAL_API_SECRET="ci-local-internal-secret"
PFCLI_NODE_PATH="${PWD}/cli/pfcli/node_modules"

bun scripts/nx-quiet.ts run @pf/demo:build
bun scripts/nx-quiet.ts run @pf/drizzle-sqlite:migrate
NODE_PATH="$PFCLI_NODE_PATH" bun cli/pfcli/src/main.ts import "$ORG"
FRONTEND_JWT_TOKEN="$(NODE_PATH="$PFCLI_NODE_PATH" bun cli/pfcli/src/main.ts get-frontend-jwt "$ORG")"
export FRONTEND_JWT_TOKEN

PF_ORG="$ORG" NODE_ENV=development PF_BYPASS_AUTH=ci@example.com \
  bun runtime/local/src/authentication-server/authentication-server.ts --port "$AUTH_PORT" &
AUTH_PID=$!
PF_ORG="$ORG" bun runtime/local/src/graphql-server/graphql-server.ts --port "$GQL_PORT" --org "$ORG" &
GQL_PID=$!

wait_for_server() {
  local pid="$1" url="$2" require_success="$3"
  for _ in {1..60}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Build backend exited before readiness" >&2
      return 1
    fi
    if { [[ "$require_success" == true ]] && curl -sf "$url" >/dev/null; } || \
       { [[ "$require_success" == false ]] && curl -s -o /dev/null "$url"; }; then
      sleep 0.1
      kill -0 "$pid" 2>/dev/null
      return
    fi
    sleep 1
  done
  echo "Build backend readiness timed out" >&2
  return 1
}
wait_for_server "$AUTH_PID" "${OAUTH_ISSUER_URL}/.well-known/oauth-authorization-server" true
wait_for_server "$GQL_PID" "$GRAPHQL_ENDPOINT" false

# A content-derived identity also works in a freshly initialized source snapshot.
BUILD_VERSION="$(bun -e 'process.stdout.write((await Bun.file("runtime/local/package.json").json()).version)')"
BUILD_SOURCE="$(git ls-files --cached --others --exclude-standard -z | sort -z | xargs -0 sha256sum | sha256sum | cut -d ' ' -f 1)"
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  -u AWS_PROFILE -u AWS_REGION -u AWS_DEFAULT_REGION \
  -u POSTHOG_PROJECT_API_KEY -u POSTHOG_HOST -u GOOGLE_CLIENT_SECRET \
  PF_NEXT_BUILD_ID="processfocus-runtime-local-${BUILD_VERSION}-${BUILD_SOURCE}" \
  NODE_ENV=production PF_ORG="$ORG" bun scripts/nx-quiet.ts run @pf/frontend:next-build
bun apps/frontend/scripts/assert-dashboard-client-chunks.ts apps/frontend
