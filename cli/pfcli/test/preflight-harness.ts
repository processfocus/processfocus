import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/** Fast contract/diagnostic tests only. Real isolation belongs to sandbox-integration.sh. */
export const createPreflightHarness = () => {
  if (process.env["PF_SANDBOX_DIRECTORY"])
    return {
      env: {
        PF_SANDBOX_DIRECTORY: process.env["PF_SANDBOX_DIRECTORY"],
        PF_TEST_PREFLIGHT_PYTHON: "/usr/bin/python3",
        PATH: process.env["PATH"] ?? "",
      },
      cleanup: () => {},
    }
  const directory = mkdtempSync(join(tmpdir(), "pf-preflight-harness-"))
  writeFileSync(join(directory, "image-id"), `sha256:${"0".repeat(64)}`)
  const python = join(directory, "python3")
  writeFileSync(
    python,
    `#!/usr/bin/python3
import json, os, subprocess, sys
if "--preflight-result" not in sys.argv:
    os.execv("/usr/bin/python3", ["/usr/bin/python3", *sys.argv[1:]])
args = sys.argv
output = args[args.index("--preflight-result") + 1]
timeout = float(args[args.index("--execution-timeout") + 1])
org = args[args.index("--execution-timeout") + 4]
snapshot = json.load(sys.stdin)["PF_CONFIGURATION_PREFLIGHT_INPUT"]
try:
    result = subprocess.run([os.environ["PF_TEST_REAL_BUN"], "--no-env-file",
        os.environ["PF_TEST_PREFLIGHT_SCRIPT"], "--child", org + "/dist"],
        cwd=os.environ["PF_TEST_PREFLIGHT_WORKSPACE_ROOT"],
        input=snapshot.encode(), env={"PATH": os.environ["PATH"]},
        capture_output=True, timeout=timeout)
except subprocess.TimeoutExpired:
    sys.exit(124)
records = [line.removeprefix(b"__PF_CONFIGURATION_RESULT__") for line in result.stdout.splitlines()
           if line.startswith(b"__PF_CONFIGURATION_RESULT__")]
if result.returncode or len(records) != 1 or len(records[0]) > 65536:
    sys.exit(1)
open(output, "xb").write(records[0])
`,
  )
  chmodSync(python, 0o755)
  const bun = join(directory, "bun")
  writeFileSync(
    bun,
    `#!/usr/bin/env bash
if [[ "$*" == *launch-sandbox.ts* ]]; then
  exec "${python}" "$@"
fi
exec "${process.execPath}" "$@"
`,
  )
  chmodSync(bun, 0o755)
  return {
    env: {
      PF_SANDBOX_DIRECTORY: directory,
      PF_TEST_PREFLIGHT_PYTHON: python,
      PF_TEST_REAL_BUN: process.execPath,
      // Match launch-sandbox.ts's --workdir=/workspace for bundle dependencies.
      PF_TEST_PREFLIGHT_WORKSPACE_ROOT: resolve(import.meta.dir, "../../.."),
      PF_TEST_PREFLIGHT_SCRIPT: join(
        import.meta.dir,
        "../../../cloud/org/src/docker/deploy-project/configuration-preflight.ts",
      ),
      PATH: `${directory}:${process.env["PATH"] ?? ""}`,
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  }
}
