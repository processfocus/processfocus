#!/usr/bin/env bun

import { Effect } from "effect"
import { prepareDeploymentArtifact } from "./prepare-deployment-artifact"

const organisationPath = process.argv[2]
const artifactPath = process.argv[3]

if (organisationPath === undefined || artifactPath === undefined) {
  throw new Error(
    "Usage: prepare-deployment-artifact <organisation-path> <artifact-path>",
  )
}

await Effect.runPromise(
  prepareDeploymentArtifact(organisationPath, artifactPath),
)
