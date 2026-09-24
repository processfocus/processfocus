import { spawn } from "node:child_process"
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The normal demo never imports these authored test processes or policies.
export const prepareLifecycleOrganisation = async (
  root: string,
): Promise<string> => {
  const org = await mkdtemp(join(tmpdir(), "pf-lifecycle-org-"))
  try {
    await cp(join(root, "examples/demo"), org, { recursive: true })
    await rm(join(org, "db"), { recursive: true, force: true })
    await cp(
      join(root, "examples/demo/test/fixtures/without-waiting-lifecycle.ts"),
      join(org, "src/lifecycle.ts"),
    )
    await appendFile(
      join(org, "src/org.ts"),
      '\nimport { addLifecycleFixtures } from "./lifecycle"\naddLifecycleFixtures(org, employee)\n',
    )
    await appendFile(
      join(org, "cedar/ci.cedar"),
      `
// Exercise caller-specific execution capabilities without changing demo policy.
permit(principal == PF::ProviderUser::"finance-manager@example.com", action == PF::Action::"abandon", resource is PF::Step)
when { resource in PF::Process::"/finance/purchase-request" };
// Only the disposable acceptance organisation uses these ordinary-work grants.
permit(principal, action == PF::Action::"view", resource is PF::Execution)
when { principal in PF::Role::"/Employee" && (resource in PF::Process::"/lifecycle" || resource in PF::Process::"/handled" || resource in PF::Process::"/invalid-schedule") };
// Service accounts retain their own identity when reading execution projections.
permit(principal == PF::ServiceAccount::"ci-pipeline", action == PF::Action::"view", resource is PF::Execution)
when { resource in PF::Process::"/lifecycle" || resource in PF::Process::"/handled" || resource in PF::Process::"/invalid-schedule" };
permit(principal, action == PF::Action::"restart", resource is PF::Execution)
when { principal in PF::Role::"/hr/HR" && resource in PF::Process::"/lifecycle" };
permit(principal == PF::ServiceAccount::"ci-pipeline", action == PF::Action::"skipScheduleWaits", resource is PF::Process)
when { resource == PF::Process::"/lifecycle" || resource == PF::Process::"/handled" || resource == PF::Process::"/invalid-schedule" };
`,
    )
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "bun",
        [join(root, "cli", "pfcli", "src", "main.ts"), "build", org],
        {
          cwd: root,
          env: {
            ...process.env,
            PF_TEMP_ORG_NODE_MODULES: join(root, "node_modules"),
          },
          stdio: "inherit",
        },
      )
      child.on("error", reject)
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Lifecycle organisation build exited ${code}`)),
      )
    })
    return org
  } catch (error) {
    await rm(org, { recursive: true, force: true })
    throw error
  }
}
