import { PostHog, makePostHogConfiguration } from "@processfocus/plugin-posthog"
import type { ConfigurationContract } from "@processfocus/runtime"
import { Schema as ES, Effect, Layer } from "effect"
import {
  AuthenticationConfig,
  PoliciesConfig,
  localFixtureSecretClients,
} from "@pf/auth-config"
import {
  type BusinessCalendarConfig,
  NZ_HOLIDAYS,
  Saturday,
  Sunday,
  Weekdays,
} from "@pf/business-calendar"
import {
  DocumentStore,
  Form,
  Invitation,
  List,
  OrgUnit,
  Organisation,
  Process,
  Role,
} from "@pf/process"
import { BugReportFix } from "./bug-report-fix"
import { CalculatorDemo } from "./calculator-demo"
import { demoConfiguration } from "./configuration"
import { DeadlineDemo } from "./deadline-demo"
import { DependentLookups } from "./dependent-lookups"
import { FileUploadTest } from "./file-upload-test"
import { testDocumentsId } from "./file-upload-test-forms"
import { HelloSystemStart } from "./hello-system-start"
import { hostedCiClients, hostedCiPolicyFiles } from "./hosted-ci"
import { IncidentResponse } from "./incident-response"
import { OnBoarding } from "./on-boarding"
import { purchaseOrdersForm } from "./org-forms"
import { processStartDemoForm } from "./process-start-demo-form"
import { PurchaseRequest } from "./purchase-request"
import { ScheduledStart } from "./scheduled-start"
import {
  DemoOperations,
  DemoOperationsLive,
  TypedDemoDrizzleLayer,
} from "./schema"
import { TimeOffRequest } from "./time-off-request"
import { VendorOnboarding } from "./vendor-onboarding"

const demoPostHogConfiguration = makePostHogConfiguration({}, { enabled: true })

export const Configuration = {
  version: 1,
  groups: [demoConfiguration, demoPostHogConfiguration],
} satisfies ConfigurationContract

// Business calendar: Mon-Fri 8:30-17:00 with NZ public holidays
const weekdaySchedule = Weekdays.map((day) => ({
  day,
  ranges: [{ open: { hour: 8, minute: 30 }, close: { hour: 17, minute: 0 } }],
}))

const businessCalendar: BusinessCalendarConfig = {
  weeklySchedule: weekdaySchedule,
  holidays: NZ_HOLIDAYS,
  exceptions: [],
  nonWorkingDays: [Saturday, Sunday],
  periods: [],
  startDayOfWeek: Sunday,
}

export const org = new Organisation({
  name: "Demo Org",
  acronym: "Demo",
  timeZone: "Pacific/Auckland",
  businessCalendar,
})

new PostHog(org, "posthog", {
  configuration: demoPostHogConfiguration,
})

// Org-level roles
export const employee = new Role(org, "Employee", { name: "Employee" })
// Isolated API test users retain persona-specific Cedar permissions without
// sharing a fixed email, authenticated session or mutable role membership.
for (const persona of [
  "CI",
  "Employee",
  "Observer",
  "Finance",
  "Procurement",
]) {
  new Role(org, `GraphQLE2E${persona}`, { name: `GraphQL E2E ${persona}` })
}
export const administrator = new Role(org, "Administrator", {
  name: "Administrator",
})

// Departments
const engineering = new OrgUnit(org, "engineering", {
  name: "Engineering",
  type: "department",
})
const engineering_manager = new Role(engineering, "Manager", {
  name: "Manager",
})

const finance = new OrgUnit(org, "finance", {
  name: "Finance",
  type: "department",
})
export const finance_manager = new Role(finance, "Manager", { name: "Manager" })

const hr = new OrgUnit(org, "hr", {
  name: "Human Resources",
  type: "department",
})
const hr_manager = new Role(hr, "Manager", { name: "Manager" })

const operations = new OrgUnit(org, "operations", {
  name: "Operations",
  type: "department",
})
const operations_manager = new Role(operations, "Manager", {
  name: "Manager",
})
const it = new Role(operations, "IT", {
  name: "IT",
})
const facilities = new Role(operations, "Facilities", {
  name: "Facilities",
})

const procurement = new OrgUnit(org, "procurement", {
  name: "Procurement",
  type: "department",
})
export const procurement_manager = new Role(procurement, "Manager", {
  name: "Procurement",
})

// Processes
new DependentLookups(operations, "dependent-lookups", employee)
new BugReportFix(engineering, "bug-report-fix", employee, engineering_manager)
const purchaseRequest = new PurchaseRequest(
  finance,
  "purchase-request",
  employee,
  finance_manager,
  procurement_manager,
)
new OnBoarding(hr, "on-boarding", it, facilities)
const hrAutomation = new OrgUnit(hr, "automation", {
  name: "HR Automation",
  type: "team",
})
new ScheduledStart(hrAutomation, "scheduled-start", employee)
new ScheduledStart(operations, "scheduled-start", employee)
new TimeOffRequest(hr, "time-off-request", employee, hr_manager)
new IncidentResponse(
  operations,
  "incident-response",
  employee,
  operations_manager,
)
new HelloSystemStart(operations, "hello-system-start")
new VendorOnboarding(
  procurement,
  "vendor-onboarding",
  employee,
  procurement_manager,
)
new CalculatorDemo(operations, "calculator-demo", employee)
new DeadlineDemo(operations, "deadline-demo", employee, finance_manager)
new DeadlineDemo(
  operations,
  "interrupting-deadline-demo",
  employee,
  finance_manager,
  true,
)

// Document stores
new DocumentStore(org, testDocumentsId, {})

new FileUploadTest(operations, "file-upload-test", {
  role: employee,
})

const processStartDemo = new Process(operations, "start-request-demo", {
  name: "Start Request Demo",
  purpose: "Demonstrate conditional questions on a Process start form",
})
processStartDemo
  .start(
    new Form(processStartDemo, "Request", {
      form: processStartDemoForm,
      browser: {
        entrypoint: "src/process-start-demo-form.ts",
        exportName: "processStartDemoForm",
      },
      role: employee,
    }),
  )
  .end()

// Configure custom Cedar policies
new PoliciesConfig(org, "policies", {
  policyFiles: [
    "cedar/custom.cedar",
    "cedar/ci.cedar",
    ...hostedCiPolicyFiles,
    "cedar/graphql-e2e.cedar",
  ],
})

// Lists
new List(org, "purchase-orders", {
  name: "Purchase Orders",
  purpose: "View all purchase orders",
  roles: [employee],
  startProcess: purchaseRequest,
  output: {
    id: ES.String.annotate({ title: "ID" }),
    item: ES.String.annotate({ title: "Item" }),
    price: ES.Number.annotate({ title: "Price" }),
  },
  query: (ctx) =>
    Effect.gen(function* () {
      const ops = yield* DemoOperations
      return yield* ops.queryPurchaseOrders(ctx)
    }).pipe(Effect.orDie),
  form: () => purchaseOrdersForm.fields,
  browser: { entrypoint: "src/org-forms.ts", exportName: "purchaseOrdersForm" },
  itemQuery: (id) =>
    Effect.gen(function* () {
      const ops = yield* DemoOperations
      return yield* ops.queryPurchaseOrderById(id)
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logError("Item query failed", { error })
          return null
        }),
      ),
    ),
  update: (id, input) =>
    Effect.gen(function* () {
      const ops = yield* DemoOperations
      return yield* ops.updatePurchaseOrder(id, {
        item: input.item,
        price: input.price,
      })
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logError("Update failed", { error })
          return null
        }),
      ),
    ),
})

new List(org, "process-catalog-browsing", {
  name: "Process Catalog Browsing",
  purpose: "Browse imported process metadata without edits",
  roles: [employee],
  output: {
    id: ES.String.annotate({ title: "ID" }),
    name: ES.String.annotate({ title: "Name" }),
    path: ES.String.annotate({ title: "Path" }),
  },
  query: (ctx) =>
    Effect.gen(function* () {
      const ops = yield* DemoOperations
      return yield* ops.queryProcessCatalog(ctx)
    }).pipe(Effect.orDie),
})

/**
 * Combined custom database layer for job worker integration.
 *
 * Provides:
 * - TypedDemoDrizzle: Drizzle client with combined system + custom schema
 * - DemoOperations: Custom database operations for demo-specific tables
 */
export const CustomDbLayer = DemoOperationsLive.pipe(
  Layer.provideMerge(TypedDemoDrizzleLayer),
)

/**
 * Configures the org with authentication settings and invitations.
 * Uses Effect Config for parameter resolution.
 */
export const configureOrg = Effect.gen(function* () {
  const workloadClients = yield* hostedCiClients
  const googleClientId = yield* demoConfiguration.fields.googleClientId.config
  const googleClientSecret =
    yield* demoConfiguration.fields.googleClientSecret.config
  const ciPipelineSecret =
    yield* demoConfiguration.fields.ciPipelineSecret.config
  const adminEmail = yield* demoConfiguration.fields.adminEmail.config
  const passkeyEmail = yield* demoConfiguration.fields.passkeyEmail.config

  // Configure OAuth authentication
  new AuthenticationConfig(org, "auth", {
    inviteOnly: true,
    // Anonymous login presentation only; Cedar authorizes token management.
    delegatedAccess: true,
    identityProviders: {
      google: {
        clientID: googleClientId,
        clientSecret: googleClientSecret,
        scopes: ["openid", "email", "profile"],
      },
    },
    passkey: {
      rpName: "Process Focus Demo",
    },
    secretClients: yield* localFixtureSecretClients({
      // ci-pipeline is used in graphql-api tests
      "ci-pipeline": {
        secret: ciPipelineSecret._tag === "Some" ? ciPipelineSecret.value : "",
        audience: "graphql-api",
      },
    }),
    workloadClients,
  })

  new Invitation(org, "berend", {
    email: adminEmail,
    roles: [employee, administrator],
  })

  // Passkey registration target (local/dev emails often reroute here)
  new Invitation(org, "passkey", {
    email: passkeyEmail,
    roles: [employee, administrator],
  })

  // CI/E2E testing invitation: provider user will be created when ci uses the
  new Invitation(org, "ci-test", {
    email: "ci@example.com",
    roles: [employee],
  })

  // The opt-in Delegation journey accepts this Invitation as a human
  // Administrator and verifies the organisation's explicit token grants.
  new Invitation(org, "e2e-settings", {
    email: "settings-e2e@example.com",
    roles: [employee, administrator],
  })

  // Separate identities exercise each settings permission independently.
  new Invitation(org, "e2e-settings-providers", {
    email: "settings-providers@example.com",
    roles: [employee],
  })
  new Invitation(org, "e2e-settings-users", {
    email: "settings-users@example.com",
    roles: [employee],
  })

  // Named browser personas register Passkeys through these Invitations.
  new Invitation(org, "e2e-employee", {
    email: "employee@example.com",
    roles: [employee],
  })

  new Invitation(org, "e2e-employee-2", {
    email: "employee-2@example.com",
    roles: [employee],
  })

  new Invitation(org, "e2e-mcp-start-peer", {
    email: "mcp-start-peer@example.com",
    roles: [employee],
  })

  new Invitation(org, "e2e-finance-manager", {
    email: "finance-manager@example.com",
    roles: [finance_manager],
  })

  new Invitation(org, "e2e-procurement-manager", {
    email: "procurement-manager@example.com",
    roles: [procurement_manager],
  })

  new Invitation(org, "e2e-employee-finance-manager", {
    email: "employee-finance-manager@example.com",
    roles: [employee, finance_manager],
  })

  return org
})
