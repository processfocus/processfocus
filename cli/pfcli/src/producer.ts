import { CLI_PACKAGE_NAME, CLI_PACKAGE_VERSION } from "./package-metadata"

/**
 * Identity of the CLI that produces organisation artifacts and deployment
 * envelopes. This is the planned public distribution package at the ADR 0020
 * fixed release-group version from this package manifest, stamped into the deploy
 * manifest, `.pf-deploy.json` envelope, and `artifacts.json` inventory so a
 * reader can report which producer wrote an artifact.
 */
export const CLI_PRODUCER = {
  name: CLI_PACKAGE_NAME,
  version: CLI_PACKAGE_VERSION,
} as const
