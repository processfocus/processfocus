#!/usr/bin/env bash
set -euo pipefail

# Compile for the imported organisation, its local issuer and embed origin.
export PF_RUNTIME_MODE=local
# Use the project build served by `next start`; no standalone package is needed.
export PF_DASHBOARD_PROJECT_BUILD=1
export GRAPHQL_ENDPOINT="$GRAPHQL_SERVER_URL/graphql"
export AUTH_URL="$OAUTH_ISSUER_URL"
export JWKS_URI="$OAUTH_ISSUER_URL/.well-known/jwks.json"
FRONTEND_JWT_TOKEN=$(bun cli/pfcli/src/main.ts get-frontend-jwt)
export FRONTEND_JWT_TOKEN
bash apps/frontend/scripts/prepare-build-inputs.sh
cd apps/frontend
# The journeys render against the live disposable runtime; no static export is needed.
node_modules/.bin/next build --experimental-build-mode compile "$@"
exec node_modules/.bin/next start --port "$FRONTEND_PORT"
