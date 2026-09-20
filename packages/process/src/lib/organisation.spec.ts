import { Schema as ES, Effect } from "effect"
import { Form } from "./form"
import { NodeStep } from "./node_step"
import { OrgUnit } from "./org-unit"
import { Organisation } from "./organisation"
import { Process } from "./process"
import { Role } from "./role"
import { beforeEach, describe, expect, it } from "bun:test"

describe("Organisation", () => {
  let org: Organisation

  beforeEach(() => {
    org = new Organisation({ name: "Test Corp" })
  })

  describe("stepByPath", () => {
    it("should find a step by its full path", () => {
      const dept = new OrgUnit(org, "engineering", {
        name: "Engineering",
        type: "department",
      })
      const role = new Role(dept, "developer", { name: "Developer" })
      const process = new Process(dept, "bug-fix", {
        name: "Bug Fix",
        purpose: "Fix bugs",
      })
      const step = new Form(process, "report", { role, form: () => ({}) })

      process.start(step)

      const found = org.stepByPath("engineering/bug-fix/report")
      expect(found).toBeDefined()
      expect(found?.node.id).toBe("report")
    })

    it("should return undefined for non-existent path", () => {
      const found = org.stepByPath("nonexistent/path/step")
      expect(found).toBeUndefined()
    })

    it("should return undefined when path points to non-Step construct", () => {
      new OrgUnit(org, "engineering", {
        name: "Engineering",
        type: "department",
      })

      const found = org.stepByPath("engineering")
      expect(found).toBeUndefined()
    })

    it("should find steps in nested org units", () => {
      const division = new OrgUnit(org, "operations", {
        name: "Operations",
        type: "division",
      })
      const dept = new OrgUnit(division, "engineering", {
        name: "Engineering",
        type: "department",
      })
      const role = new Role(dept, "developer", { name: "Developer" })
      const process = new Process(dept, "deploy", {
        name: "Deploy",
        purpose: "Deploy code",
      })
      const step = new Form(process, "review", { role, form: () => ({}) })

      process.start(step)

      const found = org.stepByPath("operations/engineering/deploy/review")
      expect(found).toBeDefined()
      expect(found?.node.id).toBe("review")
    })

    it("should handle paths with empty segments", () => {
      const dept = new OrgUnit(org, "engineering", {
        name: "Engineering",
        type: "department",
      })
      const role = new Role(dept, "developer", { name: "Developer" })
      const process = new Process(dept, "bug-fix", {
        name: "Bug Fix",
        purpose: "Fix bugs",
      })
      const step = new Form(process, "report", { role, form: () => ({}) })

      process.start(step)

      // Path with extra slashes should still work
      const found = org.stepByPath("engineering//bug-fix///report")
      expect(found).toBeDefined()
      expect(found?.node.id).toBe("report")
    })

    it("should find Form steps", () => {
      const dept = new OrgUnit(org, "hr", {
        name: "HR",
        type: "department",
      })
      const role = new Role(dept, "manager", { name: "Manager" })
      const process = new Process(dept, "onboarding", {
        name: "Onboarding",
        purpose: "Onboard employees",
      })
      const form = new Form(process, "employee-info", {
        role,
        form: () => ({ name: ES.String }),
      })

      process.start(form)

      const found = org.stepByPath("hr/onboarding/employee-info")
      expect(found).toBeDefined()
      expect(found?.node.id).toBe("employee-info")
    })
  })

  describe("formByPath", () => {
    it("should find a Form by its path", () => {
      const dept = new OrgUnit(org, "hr", {
        name: "HR",
        type: "department",
      })
      const role = new Role(dept, "manager", { name: "Manager" })
      const process = new Process(dept, "onboarding", {
        name: "Onboarding",
        purpose: "Onboard employees",
      })
      const form = new Form(process, "employee-info", {
        role,
        form: () => ({ name: ES.String }),
      })

      process.start(form)

      const found = org.formByPath("hr/onboarding/employee-info")
      expect(found).toBeDefined()
      expect(found?.node.id).toBe("employee-info")
    })

    it("should return undefined for non-existent path", () => {
      const found = org.formByPath("nonexistent/path/form")
      expect(found).toBeUndefined()
    })

    it("should return undefined when path points to SystemStep (not Form)", () => {
      const dept = new OrgUnit(org, "engineering", {
        name: "Engineering",
        type: "department",
      })
      const role = new Role(dept, "developer", { name: "Developer" })
      const process = new Process(dept, "bug-fix", {
        name: "Bug Fix",
        purpose: "Fix bugs",
      })
      // Create a form as start node, then add a system step
      const startForm = new Form(process, "start", { role, form: () => ({}) })
      const flow = process.start(startForm)

      // Create a SystemStep (NodeStep) - not a Form
      const systemStep = new NodeStep(flow, "report", {
        input: () => Effect.succeed({}),
        output: {},
        execute: () => Effect.succeed({}),
      })
      flow.next(systemStep)

      // formByPath should return undefined for a SystemStep
      const found = org.formByPath("engineering/bug-fix/report")
      expect(found).toBeUndefined()
    })

    it("should return undefined when path points to non-Step construct", () => {
      new OrgUnit(org, "engineering", {
        name: "Engineering",
        type: "department",
      })

      const found = org.formByPath("engineering")
      expect(found).toBeUndefined()
    })
  })
})
