import {
  DockerStep,
  resolveDockerDownloadUrl,
} from "@processfocus/plugin-docker"
import { ExecutorHost, type ExecutorInvocation } from "@processfocus/runtime"
import { Effect, Schema } from "effect"
import { OrgUnit, Organisation, Process } from "processfocus"

const org = new Organisation({ name: "Plugin Fixture" })
const unit = new OrgUnit(org, "Operations", { name: "Operations" })
const process = new Process(unit, "Docker", {
  name: "Docker",
  purpose: "Exercise the Docker plugin authoring and runtime surfaces",
})

const step = new DockerStep(process, "Build", {
  dockerContext: "context",
  input: () => Effect.succeed({ ok: true }),
  output: { status: Schema.String },
})

const invocation = {
  source: {
    context: step.dockerContext,
    definition: step.dockerfile,
  },
  input: { ok: true },
} satisfies ExecutorInvocation

if (
  !step.isDockerStep ||
  typeof resolveDockerDownloadUrl !== "function" ||
  ExecutorHost.key.length === 0 ||
  invocation.source.definition.length === 0
) {
  throw new Error("Docker plugin public surfaces failed")
}
