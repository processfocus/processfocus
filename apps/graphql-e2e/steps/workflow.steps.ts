import assert from "node:assert"
import { Then, When } from "@cucumber/cucumber"
import type { TestWorld } from "../support/world"

interface WorkflowQueryResult {
  processWorkflow: TestWorld["workflowResult"]
}

When(
  "I query the workflow for process {string}",
  async function (this: TestWorld, processPath: string) {
    const query = `
      query ProcessWorkflow($processPath: String!) {
        processWorkflow(processPath: $processPath) {
          processId
          processName
          processPurpose
          responsibilities {
            responsibility
            roleName
          }
          steps {
            column
            name
            phase {
              name
            }
          }
        }
      }
    `

    const result = await this.executeGraphQL<WorkflowQueryResult>(query, {
      processPath,
    })

    this.workflowResult = result.processWorkflow
  },
)

Then(
  "the workflow should have process name {string}",
  function (this: TestWorld, expectedName: string) {
    assert.ok(this.workflowResult, "Workflow result should be defined")
    assert.strictEqual(
      this.workflowResult.processName,
      expectedName,
      `Expected process name "${expectedName}" but got "${this.workflowResult.processName}"`,
    )
  },
)

Then(
  "the workflow should have {int} responsibilities",
  function (this: TestWorld, expectedCount: number) {
    assert.ok(this.workflowResult, "Workflow result should be defined")
    assert.strictEqual(
      this.workflowResult.responsibilities.length,
      expectedCount,
      `Expected ${expectedCount} responsibilities but got ${this.workflowResult.responsibilities.length}`,
    )
  },
)

Then(
  "the workflow should have a responsibility {string} for role {string}",
  function (this: TestWorld, responsibility: string, roleName: string) {
    assert.ok(this.workflowResult, "Workflow result should be defined")

    const found = this.workflowResult.responsibilities.find(
      (r) => r.roleName === roleName && r.responsibility === responsibility,
    )

    assert.ok(
      found,
      `Expected responsibility "${responsibility}" for role "${roleName}" but not found. ` +
        `Available: ${JSON.stringify(this.workflowResult.responsibilities)}`,
    )
  },
)

Then(
  "the workflow should have at least {int} steps",
  function (this: TestWorld, minSteps: number) {
    assert.ok(this.workflowResult, "Workflow result should be defined")
    assert.ok(
      this.workflowResult.steps.length >= minSteps,
      `Expected at least ${minSteps} steps but got ${this.workflowResult.steps.length}`,
    )
  },
)

Then(
  "the workflow should have a step {string} in phase {string}",
  function (this: TestWorld, stepName: string, phaseName: string) {
    assert.ok(this.workflowResult, "Workflow result should be defined")

    const found = this.workflowResult.steps.find(
      (s) => s.name === stepName && s.phase?.name === phaseName,
    )

    assert.ok(
      found,
      `Expected step "${stepName}" in phase "${phaseName}" but not found. ` +
        `Steps with phases: ${JSON.stringify(
          this.workflowResult.steps
            .filter((s) => s.phase)
            .map((s) => ({ name: s.name, phase: s.phase?.name })),
        )}`,
    )
  },
)

Then(
  "the workflow should have a step {string} without a phase",
  function (this: TestWorld, stepName: string) {
    assert.ok(this.workflowResult, "Workflow result should be defined")

    const found = this.workflowResult.steps.find(
      (s) => s.name === stepName && s.phase === null,
    )

    assert.ok(
      found,
      `Expected step "${stepName}" without a phase but not found. ` +
        `Steps: ${JSON.stringify(
          this.workflowResult.steps.map((s) => ({
            name: s.name,
            phase: s.phase?.name ?? null,
          })),
        )}`,
    )
  },
)
