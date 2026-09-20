import { Effect } from "effect"
import { NodeStep, type OrgUnit, Process } from "@pf/process"

export class HelloSystemStart extends Process {
  constructor(scope: OrgUnit, id: string) {
    super(scope, id, {
      name: "Hello System Start",
      purpose: "Proves a system-start process runs in the worker",
    })

    const hello = new NodeStep(this, "Hello", {
      name: "Say hello",
      input: () => Effect.succeed({}),
      output: {},
      execute: () =>
        Effect.gen(function* () {
          yield* Effect.log("hello")
          return {}
        }),
    })

    this.start(hello).end()
  }
}
