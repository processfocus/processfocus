import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import {
  DEPLOY_ARTIFACT_FILENAME,
  DEPLOY_ARTIFACT_FORMAT,
  DEPLOY_ARTIFACT_VERSION,
} from "@processfocus/runtime"
import { Effect } from "effect"
import { CliError } from "./errors"
import { CLI_PRODUCER } from "./producer"

const resolveDeployArtifactOrgPath = (orgPath: string): string => {
  const relativeOrgPath = path.relative(process.cwd(), path.resolve(orgPath))
  return relativeOrgPath && !relativeOrgPath.startsWith("..")
    ? relativeOrgPath
    : orgPath
}

export const prepareDeploymentArtifact = (
  orgPath: string,
  zipPath: string,
): Effect.Effect<void, CliError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const absoluteOrgPath = path.resolve(process.cwd(), orgPath)
      const stageDir = yield* Effect.acquireRelease(
        Effect.sync(() =>
          mkdtempSync(path.join(tmpdir(), "pfcli-deploy-stage-")),
        ),
        (dir) =>
          Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      )
      const stageDistPath = path.join(stageDir, "dist")
      const metadataPath = path.join(stageDir, DEPLOY_ARTIFACT_FILENAME)
      const drizzleConfigSourcePath = path.join(
        absoluteOrgPath,
        "drizzle.config.ts",
      )
      const drizzleConfigStagePath = path.join(stageDir, "drizzle.config.ts")
      const drizzleFolderSourcePath = path.join(absoluteOrgPath, "drizzle")
      const drizzleFolderStagePath = path.join(stageDir, "drizzle")

      const deployArtifactMetadata = JSON.stringify({
        format: DEPLOY_ARTIFACT_FORMAT,
        version: DEPLOY_ARTIFACT_VERSION,
        orgPath: resolveDeployArtifactOrgPath(orgPath),
        producer: CLI_PRODUCER,
      })

      const result = yield* Effect.try({
        try: () => {
          cpSync(path.join(absoluteOrgPath, "dist"), stageDistPath, {
            recursive: true,
          })

          const zipEntries = ["dist", DEPLOY_ARTIFACT_FILENAME]

          if (existsSync(drizzleConfigSourcePath)) {
            cpSync(drizzleConfigSourcePath, drizzleConfigStagePath)
            zipEntries.push("drizzle.config.ts")
          }

          if (existsSync(drizzleFolderSourcePath)) {
            cpSync(drizzleFolderSourcePath, drizzleFolderStagePath, {
              recursive: true,
            })
            zipEntries.push("drizzle")
          }

          writeFileSync(metadataPath, `${deployArtifactMetadata}\n`)

          return spawnSync("zip", ["-r", "-q", zipPath, ...zipEntries], {
            cwd: stageDir,
            encoding: "utf8",
          })
        },
        catch: (cause) =>
          new CliError({
            message: "Failed to execute zip command",
            cause,
          }),
      })

      if (result.error) {
        return yield* new CliError({
          message: `Failed to create deployment zip: ${result.error.message}`,
          cause: result.error,
        })
      }

      if (result.status !== 0) {
        return yield* new CliError({
          message:
            result.stderr?.trim() ||
            `zip command failed with exit code ${String(result.status)}`,
        })
      }
    }),
  )
