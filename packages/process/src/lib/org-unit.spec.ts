import { Schema as ES } from "effect"
import { Form } from "./form"
import { OrgUnit } from "./org-unit"
import { Organisation } from "./organisation"
import { Process } from "./process"
import { Role } from "./role"
import { beforeEach, describe, expect, it } from "bun:test"

describe("OrgUnit - Organizational hierarchy", () => {
  let organisation: Organisation

  beforeEach(() => {
    organisation = new Organisation({ name: "Acme Corp" })
  })

  it("should create a root-level org unit", () => {
    const board = new OrgUnit(organisation, "board", {
      name: "Board of Directors",
      type: "board",
    })

    expect(board).toBeDefined()
    expect(board.name).toBe("Board of Directors")
    expect(board.type).toBe("board")
  })

  it("should prevent creating OrgUnit with type 'organisation'", () => {
    const board = new OrgUnit(organisation, "board", {
      name: "Board of Directors",
      type: "board",
    })

    // Attempting to create an OrgUnit with type "organisation" should throw
    expect(() => {
      new OrgUnit(board, "invalid", {
        name: "Invalid Org",
        type: "organisation",
      })
    }).toThrow(
      "Cannot create OrgUnit with type 'organisation'. Use Organisation class instead.",
    )
  })

  it("should allow Organisation to have type 'organisation'", () => {
    // Organisation should automatically have type "organisation"
    expect(organisation.type).toBe("organisation")
  })

  it("should create nested org units", () => {
    const board = new OrgUnit(organisation, "board", {
      name: "Board of Directors",
      type: "board",
    })

    const operations = new OrgUnit(board, "operations", {
      name: "Operations Division",
      type: "division",
    })

    const finance = new OrgUnit(operations, "finance", {
      name: "Finance Department",
      type: "department",
    })

    expect(operations).toBeDefined()
    expect(operations.name).toBe("Operations Division")
    expect(finance).toBeDefined()
    expect(finance.name).toBe("Finance Department")
  })

  it("should support arbitrarily deep hierarchies", () => {
    const level1 = new OrgUnit(organisation, "level1", {
      name: "Level 1",
      type: "division",
    })

    const level2 = new OrgUnit(level1, "level2", {
      name: "Level 2",
      type: "department",
    })

    const level3 = new OrgUnit(level2, "level3", {
      name: "Level 3",
      type: "team",
    })

    const level4 = new OrgUnit(level3, "level4", {
      name: "Level 4",
      type: "unit",
    })

    expect(level4).toBeDefined()
    expect(level4.name).toBe("Level 4")
  })

  it("should generate correct Construct paths", () => {
    const board = new OrgUnit(organisation, "board", {
      name: "Board of Directors",
      type: "board",
    })

    const operations = new OrgUnit(board, "operations", {
      name: "Operations Division",
      type: "division",
    })

    const finance = new OrgUnit(operations, "finance", {
      name: "Finance Department",
      type: "department",
    })

    expect(finance.node.path).toBe("board/operations/finance")
  })
})

describe("Role - Scoping to org units", () => {
  let organisation: Organisation
  let orgUnit: OrgUnit

  beforeEach(() => {
    organisation = new Organisation({ name: "Acme Corp" })
    orgUnit = new OrgUnit(organisation, "finance", {
      name: "Finance Department",
      type: "department",
    })
  })

  it("should create a role scoped to an org unit", () => {
    const accountant = new Role(orgUnit, "accountant", {
      name: "Accountant",
    })

    expect(accountant).toBeDefined()
    expect(accountant.name).toBe("Accountant")
    expect(accountant.orgUnit).toBe(orgUnit)
  })

  it("should create multiple roles in the same org unit", () => {
    const accountant = new Role(orgUnit, "accountant", {
      name: "Accountant",
    })

    const manager = new Role(orgUnit, "manager", {
      name: "Finance Manager",
    })

    expect(accountant.orgUnit).toBe(orgUnit)
    expect(manager.orgUnit).toBe(orgUnit)
  })

  it("should create roles in different org units", () => {
    const itUnit = new OrgUnit(organisation, "it", {
      name: "IT Department",
      type: "department",
    })

    const accountant = new Role(orgUnit, "accountant", {
      name: "Accountant",
    })

    const developer = new Role(itUnit, "developer", {
      name: "Software Developer",
    })

    expect(accountant.orgUnit).toBe(orgUnit)
    expect(developer.orgUnit).toBe(itUnit)
    expect(accountant.orgUnit).not.toBe(developer.orgUnit)
  })
})

describe("Process - Scoping to org units", () => {
  let organisation: Organisation
  let orgUnit: OrgUnit

  beforeEach(() => {
    organisation = new Organisation({ name: "Acme Corp" })
    orgUnit = new OrgUnit(organisation, "finance", {
      name: "Finance Department",
      type: "department",
    })
  })

  it("should create a process scoped to an org unit", () => {
    const process = new Process(orgUnit, "expense-approval", {
      name: "Expense Approval",
      purpose: "Approve employee expenses",
    })

    expect(process).toBeDefined()
    expect(process.props.name).toBe("Expense Approval")
    expect(process.orgUnit).toBe(orgUnit)
  })

  it("should create multiple processes in the same org unit", () => {
    const process1 = new Process(orgUnit, "expense-approval", {
      name: "Expense Approval",
      purpose: "Approve employee expenses",
    })

    const process2 = new Process(orgUnit, "invoice-processing", {
      name: "Invoice Processing",
      purpose: "Process vendor invoices",
    })

    expect(process1.orgUnit).toBe(orgUnit)
    expect(process2.orgUnit).toBe(orgUnit)
  })
})

describe("Cross-department process flows", () => {
  let organisation: Organisation
  let financeUnit: OrgUnit
  let itUnit: OrgUnit
  let financeRole: Role
  let itRole: Role

  beforeEach(() => {
    organisation = new Organisation({ name: "Acme Corp" })

    financeUnit = new OrgUnit(organisation, "finance", {
      name: "Finance Department",
      type: "department",
    })

    itUnit = new OrgUnit(organisation, "it", {
      name: "IT Department",
      type: "department",
    })

    financeRole = new Role(financeUnit, "accountant", {
      name: "Accountant",
    })

    itRole = new Role(itUnit, "developer", {
      name: "Software Developer",
    })
  })

  it("should support steps with roles from different departments", () => {
    const process = new Process(financeUnit, "system-integration", {
      name: "System Integration",
      purpose: "Integrate financial systems",
    })

    const step1 = new Form(process, "define-requirements", {
      role: financeRole,
      form: () => ({
        requirements: ES.String,
      }),
    })

    const step2 = new Form(process, "implement-integration", {
      role: itRole,
      form: () => ({
        technology: ES.String,
      }),
    })

    const step3 = new Form(process, "verify-results", {
      role: financeRole,
      form: () => ({
        verified: ES.Boolean,
      }),
    })

    const flow = process.start(step1).next(step2).end(step3)

    expect(flow).toBeDefined()
    expect(step1.props.role?.orgUnit).toBe(financeUnit)
    expect(step2.props.role?.orgUnit).toBe(itUnit)
    expect(step3.props.role?.orgUnit).toBe(financeUnit)
  })

  it("should track the owning org unit of a process separate from step roles", () => {
    const process = new Process(financeUnit, "cross-dept-process", {
      name: "Cross Department Process",
      purpose: "Process spanning multiple departments",
    })

    const step1 = new Form(process, "step1", {
      role: itRole,
      form: () => ({}),
    })

    expect(process.orgUnit).toBe(financeUnit)
    expect(step1.props.role?.orgUnit).toBe(itUnit)
    expect(process.orgUnit).not.toBe(step1.props.role?.orgUnit)
  })
})

describe("Hierarchical org structure example", () => {
  it("should support the example from the design document", () => {
    const myCompany = new Organisation({ name: "Acme Corp" })

    const board = new OrgUnit(myCompany, "board", {
      name: "Board of Directors",
      type: "board",
    })

    const operations = new OrgUnit(board, "operations", {
      name: "Operations Division",
      type: "division",
    })

    const finance = new OrgUnit(operations, "finance", {
      name: "Finance Department",
      type: "department",
    })

    const it = new OrgUnit(operations, "it", {
      name: "IT Department",
      type: "department",
    })

    const accountant = new Role(finance, "accountant", {
      name: "Accountant",
    })

    const developer = new Role(it, "developer", {
      name: "Software Developer",
    })

    const expenseApproval = new Process(finance, "expense-approval", {
      name: "Expense Approval",
      purpose: "Approve employee expenses",
    })

    const step1 = new Form(expenseApproval, "submit", {
      role: accountant,
      form: () => ({}),
    })

    const step2 = new Form(expenseApproval, "validate-system", {
      role: developer,
      form: () => ({}),
    })

    expenseApproval.start(step1).next(step2)

    expect(myCompany.name).toBe("Acme Corp")
    expect(board.name).toBe("Board of Directors")
    expect(operations.name).toBe("Operations Division")
    expect(finance.name).toBe("Finance Department")
    expect(it.name).toBe("IT Department")
    expect(accountant.name).toBe("Accountant")
    expect(developer.name).toBe("Software Developer")
    expect(expenseApproval.props.name).toBe("Expense Approval")
    expect(step1.props.role).toBe(accountant)
    expect(step2.props.role).toBe(developer)
  })
})
