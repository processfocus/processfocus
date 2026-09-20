import { PostHog } from "@processfocus/plugin-posthog"
import { Config, Schema as ES, Effect, Layer } from "effect"
import { AuthenticationConfig, PoliciesConfig } from "@pf/auth-config"
import {
  type BusinessCalendarConfig,
  NZ_HOLIDAYS,
  Saturday,
  Sunday,
  Weekdays,
} from "@pf/business-calendar"
import { FormReadOnly } from "@pf/form-schema"
import {
  DocumentStore,
  Invitation,
  List,
  OrgUnit,
  Organisation,
  Role,
} from "@pf/process"
import { BugReportFix } from "./bug-report-fix"
import { CalculatorDemo } from "./calculator-demo"
import { FileUploadTest } from "./file-upload-test"
import { HelloSystemStart } from "./hello-system-start"
import { IncidentResponse } from "./incident-response"
import { OnBoarding } from "./on-boarding"
import { PurchaseRequest } from "./purchase-request"
import { ScheduledStart } from "./scheduled-start"
import {
  DemoOperations,
  DemoOperationsLive,
  TypedDemoDrizzleLayer,
} from "./schema"
import { TimeOffRequest } from "./time-off-request"
import { VendorOnboarding } from "./vendor-onboarding"

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

if (process.env["POSTHOG_PROJECT_API_KEY"]) {
  new PostHog(org, "posthog", {
    apiKey: Config.string("POSTHOG_PROJECT_API_KEY"),
    enabled: true,
    host: process.env["POSTHOG_HOST"] ?? "",
  })
}

// Org-level roles
export const employee = new Role(org, "Employee", { name: "Employee" })
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
new BugReportFix(engineering, "bug-report-fix", employee, engineering_manager)
new PurchaseRequest(
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

// Document stores
const testDocuments = new DocumentStore(org, "test-documents", {})

new FileUploadTest(operations, "file-upload-test", {
  role: employee,
  documentStore: testDocuments,
})

// Configure custom Cedar policies
new PoliciesConfig(org, "policies", {
  policyFiles: ["cedar/custom.cedar", "cedar/ci.cedar"],
})

// Lists
new List(org, "purchase-orders", {
  name: "Purchase Orders",
  purpose: "View all purchase orders",
  roles: [employee],
  output: {
    id: ES.String.annotations({ title: "ID" }),
    item: ES.String.annotations({ title: "Item" }),
    price: ES.Number.annotations({ title: "Price" }),
  },
  query: (ctx) =>
    Effect.gen(function* () {
      const ops = yield* DemoOperations
      return yield* ops.queryPurchaseOrders(ctx)
    }).pipe(Effect.orDie),
  form: () => ({
    id: ES.String.annotations({ title: "ID", [FormReadOnly]: true }),
    item: ES.String.annotations({ title: "Item" }),
    price: ES.Number.annotations({ title: "Price" }),
  }),
  itemQuery: (id) =>
    Effect.gen(function* () {
      const ops = yield* DemoOperations
      return yield* ops.queryPurchaseOrderById(id)
    }).pipe(
      Effect.catchAll((error) =>
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
      Effect.catchAll((error) =>
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
    id: ES.String.annotations({ title: "ID" }),
    name: ES.String.annotations({ title: "Name" }),
    path: ES.String.annotations({ title: "Path" }),
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
  const googleClientId = yield* Config.string("GOOGLE_CLIENT_ID")
  const googleClientSecret = yield* Config.string("GOOGLE_CLIENT_SECRET")
  const ciPipelineSecret = yield* Config.option(
    Config.string("CI_PIPELINE_SECRET"),
  )
  const adminEmail = yield* Config.string("MY_EMAIL").pipe(
    Config.withDefault("test@example.com"),
  )
  const passkeyEmail = yield* Config.string("RESEND_REROUTE_EMAIL").pipe(
    Config.withDefault("passkey@example.com"),
  )

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
      rpID: "localhost",
      // TODO: fix, hard-coded frontend
      origin: "http://localhost:3000",
    },
    secretClients: {
      // ci-pipeline is used in graphql-api tests
      "ci-pipeline": {
        secret: ciPipelineSecret._tag === "Some" ? ciPipelineSecret.value : "",
        audience: "graphql-api",
      },
      // e2e-employee is used in frontend tests
      "e2e-employee": {
        secret: ciPipelineSecret._tag === "Some" ? ciPipelineSecret.value : "",
        audience: "graphql-api",
      },
      // e2e-employee-finance-manager is used for subscription tests requiring both roles
      "e2e-employee-finance-manager": {
        secret: ciPipelineSecret._tag === "Some" ? ciPipelineSecret.value : "",
        audience: "graphql-api",
      },
    },
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
  // graphql mutation request requestProviderUserPermissions
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

  // E2E multi-user subscription test invitations
  // These allow M2M clients to authenticate as separate provider users with different roles
  new Invitation(org, "e2e-employee", {
    email: "employee@example.com",
    roles: [employee],
  })

  new Invitation(org, "e2e-employee-2", {
    email: "employee-2@example.com",
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
