import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "../../..")
const directory = mkdtempSync(join(tmpdir(), "pf-delegation-artifact-safety-"))
const canary = randomUUID()
const env = {
  ...process.env,
  BASE_URL: "http://localhost:3198",
  FRONTEND_E2E_FEATURES: "./src/features-delegated-access-artifacts/*.feature",
  FRONTEND_E2E_BROWSERS: "chromium",
  FRONTEND_E2E_ARTIFACT_CANARY: canary,
}
try {
  const generated = spawnSync(
    "bun",
    ["bddgen", "--config", "apps/frontend-e2e/playwright.config.ts"],
    { cwd: root, env },
  )
  assert.equal(generated.status, 0, "Artifact probe BDD generation failed")
  const result = spawnSync(
    "bun",
    [
      "playwright",
      "test",
      "--config",
      "apps/frontend-e2e/playwright.config.ts",
      "--output",
      directory,
      "--reporter=json",
      "--retries=0",
    ],
    { cwd: root, env },
  )
  assert.equal(result.status, 1, "Expected the intentional probe failure")
  const output = Buffer.concat([result.stdout, result.stderr])
  assert.ok(
    output.includes("Intentional secret-safe artifact probe failure"),
    "Probe failed before verifying cleanup and leaving the secret visible",
  )
  assert.ok(!output.includes(canary), "Secret leaked into reporter output")
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
  for (const file of files) {
    if (!file.isFile()) continue
    assert.ok(
      !/\.(png|jpe?g|webm|zip)$/i.test(file.name),
      "Unexpected screenshot, video, or trace artifact",
    )
    const content = readFileSync(join(file.parentPath, file.name))
    assert.ok(
      !content.includes(canary),
      "Secret leaked into a failure artifact",
    )
    assert.ok(
      !content.includes("# Page snapshot"),
      "Unexpected failure accessibility snapshot",
    )
  }
  const unsafeOverride = spawnSync(
    "bun",
    [
      "playwright",
      "test",
      "--config",
      "apps/frontend-e2e/playwright.config.ts",
      "--output",
      join(directory, "unsafe-override"),
      "--reporter=json",
      "--retries=0",
      "--trace=on",
    ],
    { cwd: root, env },
  )
  assert.equal(unsafeOverride.status, 1, "Unsafe CLI override was not rejected")
  const unsafeOutput = Buffer.concat([
    unsafeOverride.stdout,
    unsafeOverride.stderr,
  ])
  assert.ok(
    unsafeOutput.includes(
      "Delegation journeys require secret-safe artifact settings",
    ),
    "Unsafe override did not fail at the pre-disclosure guard",
  )
  assert.ok(
    !unsafeOutput.includes("Intentional secret-safe artifact probe failure"),
    "Unsafe override reached secret disclosure",
  )
  assert.ok(
    !unsafeOutput.includes(canary),
    "Unsafe override disclosed the canary",
  )
  console.log(
    "Artifact safety passed: forced failure, clipboard cleanup, unchanged name, no canary disclosure, no page snapshot/trace/screenshot/video; unsafe CLI trace override rejected before disclosure.",
  )
} finally {
  rmSync(directory, { recursive: true, force: true })
}
