#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="${NX_WORKSPACE_ROOT:-$(cd "${SCRIPT_DIR}/../../.." && pwd)}"
FRONTEND_ROOT="${WORKSPACE_ROOT}/apps/frontend"
OUTPUT_PATH="${FRONTEND_ROOT}/lib/generated/frontend-manifest.json"
OUTPUT_ORGANISATION_PLUGIN_MODULE="${FRONTEND_ROOT}/lib/generated/organisation-plugin-loaders.tsx"
OUTPUT_ORGANISATION_PLUGIN_PREPARATION_MODULE="${FRONTEND_ROOT}/lib/generated/organisation-plugin-preparation.ts"
OUTPUT_ORGANISATION_PLUGIN_REPORT="${FRONTEND_ROOT}/lib/generated/organisation-plugin-composition.json"
OUTPUT_ORGANISATION_FORM_MODULE="${FRONTEND_ROOT}/lib/generated/organisation-form-loaders.ts"
OUTPUT_BROWSER_FORM_DIR="${FRONTEND_ROOT}/lib/generated/browser-forms"
OUTPUT_BROWSER_PLUGIN_DIR="${FRONTEND_ROOT}/lib/generated/browser-plugins"
OUTPUT_DOCS_DIR="${FRONTEND_ROOT}/lib/generated/docs"
OUTPUT_APP_ICONS_DIR="${FRONTEND_ROOT}/public/_pf/app-icons"
OUTPUT_PUBLIC_FORM_BRANDING_DIR="${FRONTEND_ROOT}/public/_pf/public-form-branding"
LEGACY_ASSET_DIR="${FRONTEND_ROOT}/lib/generated/_pf/app-icons"
LEGACY_EMBED_OUTPUT_PATH="${FRONTEND_ROOT}/lib/generated/embed-manifest.json"
LEGACY_PLUGIN_OUTPUT_PATH="${FRONTEND_ROOT}/lib/generated/frontend-plugin-manifest.json"
LEGACY_PLUGIN_GLUE_PATH="${FRONTEND_ROOT}/lib/generated/frontend-client-plugins.ts"
LEGACY_PLUGIN_BUNDLE_DIR="${FRONTEND_ROOT}/lib/generated/frontend-client-plugin-bundles"

log() {
  printf '[frontend-prepare] %s\n' "$*"
}

remove_generated_files() {
  rm -f \
    "$OUTPUT_ORGANISATION_FORM_MODULE" \
    "$OUTPUT_PATH" \
    "$OUTPUT_ORGANISATION_PLUGIN_MODULE" \
    "$OUTPUT_ORGANISATION_PLUGIN_PREPARATION_MODULE" \
    "$OUTPUT_ORGANISATION_PLUGIN_REPORT" \
    "$LEGACY_EMBED_OUTPUT_PATH" \
    "$LEGACY_PLUGIN_OUTPUT_PATH" \
    "$LEGACY_PLUGIN_GLUE_PATH"
  rm -rf \
    "$OUTPUT_BROWSER_FORM_DIR" \
    "$OUTPUT_DOCS_DIR" \
    "$OUTPUT_APP_ICONS_DIR" \
    "$OUTPUT_PUBLIC_FORM_BRANDING_DIR" \
    "$OUTPUT_BROWSER_PLUGIN_DIR" \
    "$LEGACY_ASSET_DIR" \
    "$LEGACY_PLUGIN_BUNDLE_DIR"
}

# One identity per prepared frontend artifact, including organisation-only builds.
# Next serializes it into the standalone/OpenNext server and browser bundles.
mkdir -p "$FRONTEND_ROOT/lib/generated"
bun -e 'await Bun.write(process.argv[1], crypto.randomUUID())' "$FRONTEND_ROOT/lib/generated/deployment-id"

if [[ -z "${PF_ORG:-}" ]]; then
  remove_generated_files
  log "PF_ORG not set; cleaned generated frontend inputs"
  exit 0
fi

if [[ "$PF_ORG" == /* ]]; then
  SOURCE_DIST_DIR="${PF_ORG}/dist"
else
  SOURCE_DIST_DIR="${WORKSPACE_ROOT}/${PF_ORG}/dist"
fi

SOURCE_PATH="${SOURCE_DIST_DIR}/frontend-manifest.json"
SOURCE_DOCS_DIR="${SOURCE_DIST_DIR}/docs"
SOURCE_APP_ICONS_DIR="${SOURCE_DIST_DIR}/_pf/app-icons"
SOURCE_PUBLIC_FORM_BRANDING_DIR="${SOURCE_DIST_DIR}/_pf/public-form-branding"

if [[ ! -f "$SOURCE_PATH" ]]; then
  remove_generated_files
  log "missing $SOURCE_PATH"
  log "Run pfcli build ${PF_ORG} before building the frontend."
  exit 1
fi

remove_generated_files
mkdir -p "$(dirname "$OUTPUT_PATH")"
cp "$SOURCE_PATH" "$OUTPUT_PATH"
bun "${FRONTEND_ROOT}/scripts/generate-organisation-plugin-composition.ts" \
  "$SOURCE_PATH" \
  "$OUTPUT_ORGANISATION_PLUGIN_MODULE" \
  "$OUTPUT_ORGANISATION_PLUGIN_PREPARATION_MODULE" \
  "$OUTPUT_ORGANISATION_PLUGIN_REPORT"
bun "${FRONTEND_ROOT}/scripts/generate-organisation-form-loaders.ts" "$SOURCE_DIST_DIR" "$OUTPUT_ORGANISATION_FORM_MODULE"

rm -rf "$OUTPUT_DOCS_DIR" "$OUTPUT_APP_ICONS_DIR" "$OUTPUT_PUBLIC_FORM_BRANDING_DIR" "$LEGACY_ASSET_DIR"
if [[ -d "$SOURCE_DOCS_DIR" ]]; then
  mkdir -p "$(dirname "$OUTPUT_DOCS_DIR")"
  cp -R "$SOURCE_DOCS_DIR" "$OUTPUT_DOCS_DIR"
fi
if [[ -d "$SOURCE_APP_ICONS_DIR" ]]; then
  mkdir -p "$(dirname "$OUTPUT_APP_ICONS_DIR")"
  cp -R "$SOURCE_APP_ICONS_DIR" "$OUTPUT_APP_ICONS_DIR"
fi
if [[ -d "$SOURCE_PUBLIC_FORM_BRANDING_DIR" ]]; then
  mkdir -p "$(dirname "$OUTPUT_PUBLIC_FORM_BRANDING_DIR")"
  cp -R "$SOURCE_PUBLIC_FORM_BRANDING_DIR" "$OUTPUT_PUBLIC_FORM_BRANDING_DIR"
fi

rm -f \
  "$LEGACY_EMBED_OUTPUT_PATH" \
  "$LEGACY_PLUGIN_OUTPUT_PATH" \
  "$LEGACY_PLUGIN_GLUE_PATH"
rm -rf "$LEGACY_PLUGIN_BUNDLE_DIR"

log "staged $SOURCE_PATH, docs, and frontend public assets"
