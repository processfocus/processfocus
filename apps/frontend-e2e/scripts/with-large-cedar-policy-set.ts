#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import { appendFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

// Run only inside run-temp-org's disposable copy. These policies exercise the
// real parser without granting any additional rights to the browser persona.
const org = realpathSync(process.env["PF_ORG"] ?? "")
if (
  dirname(org) !== realpathSync(tmpdir()) ||
  !basename(org).startsWith("pf-temp-org-demo-")
) {
  throw new Error("The large Cedar fixture requires a disposable demo copy")
}

const policies = Array.from(
  { length: 4096 },
  (_, index) => `permit (
    principal == PF::ProviderUser::"cedar-scale-${index}@example.test",
    action == PF::Action::"login",
    resource == PF::Application::"default"
);`,
).join("\n")
appendFileSync(join(org, "cedar/ci.cedar"), `\n${policies}\n`)

const args = process.argv
  .slice(2)
  .filter((arg, index) => index !== 0 || arg !== "--")
const [command, ...rest] = args
if (!command)
  throw new Error("Expected a command to run with the large Cedar fixture")
const result = spawnSync(command, rest, { stdio: "inherit", env: process.env })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
