import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ExecutorHost } from "@processfocus/runtime"
import { Effect, Exit } from "effect"
import {
  type RunCommand,
  acquireDockerStepWorkDir,
  makeLocalExecutorHostLayer,
} from "./docker-step-runtime"
import { describe, expect, it } from "bun:test"

const invocation = {
  source: { context: "docker/build", definition: "Dockerfile" },
  input: { requested: true },
} as const

const jobContext = {
  stepPath: "/operations/build",
  todoId: "todo-1",
} as const

const hostWorkDirectory = (args: readonly string[]) => {
  const mount = args.find((arg) => arg.endsWith(":/pf/work"))
  if (!mount) throw new Error("Docker work-directory mount was not supplied")
  return mount.slice(0, -":/pf/work".length)
}

const executeWith = (runCommand: RunCommand) =>
  Effect.flatMap(ExecutorHost, (host) => host.run(invocation, jobContext)).pipe(
    Effect.provide(
      makeLocalExecutorHostLayer("/tmp/example-org", { runCommand }),
    ),
  )

describe("local executor host", () => {
  it("returns completed output after a successful build and run", async () => {
    const commands: string[][] = []
    const result = await Effect.runPromise(
      executeWith(async (command, args) => {
        commands.push([command, ...args])
        if (args[0] === "run") {
          writeFileSync(
            join(hostWorkDirectory(args), "result.json"),
            JSON.stringify({ status: "success", output: { built: true } }),
          )
        }
        return { exitCode: 0, stdout: "", stderr: "" }
      }),
    )

    expect(result).toEqual({ _tag: "Completed", output: { built: true } })
    expect(commands.map((command) => command[1])).toEqual(["build", "run"])
  })

  it("classifies a failed image build as an ExecutorError", async () => {
    const exit = await Effect.runPromiseExit(
      executeWith(async () => ({
        exitCode: 17,
        stdout: "build output",
        stderr: "invalid Dockerfile",
      })),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain("ExecutorError")
      expect(exit.cause.toString()).toContain("Docker build failed")
      expect(exit.cause.toString()).toContain("invalid Dockerfile")
    }
  })
})

describe("acquireDockerStepWorkDir", () => {
  it("removes the work directory when the scoped run succeeds", async () => {
    const hostWorkDir = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* acquireDockerStepWorkDir
          writeFileSync(join(dir, "input.json"), "{}")
          expect(existsSync(dir)).toBe(true)
          expect(existsSync(join(dir, "input.json"))).toBe(true)
          return dir
        }),
      ),
    )

    expect(existsSync(hostWorkDir)).toBe(false)
  })

  it("removes the work directory when the scoped run fails", async () => {
    let hostWorkDir: string | undefined

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          hostWorkDir = yield* acquireDockerStepWorkDir
          writeFileSync(join(hostWorkDir, "result.json"), "{}")
          expect(existsSync(hostWorkDir)).toBe(true)
          return yield* Effect.fail("step failed")
        }),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(hostWorkDir).toBeDefined()
    expect(existsSync(hostWorkDir!)).toBe(false)
  })

  it("removes the work directory when the fiber is interrupted", async () => {
    let hostWorkDir: string | undefined

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          hostWorkDir = yield* acquireDockerStepWorkDir
          writeFileSync(join(hostWorkDir, "input.json"), "{}")
          expect(existsSync(hostWorkDir)).toBe(true)
          return yield* Effect.interrupt
        }),
      ),
    )

    expect(Exit.isInterrupted(exit)).toBe(true)
    expect(hostWorkDir).toBeDefined()
    expect(existsSync(hostWorkDir!)).toBe(false)
  })
})
