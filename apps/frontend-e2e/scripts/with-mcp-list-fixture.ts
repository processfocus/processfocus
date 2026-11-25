import { spawnSync } from "node:child_process"
import { appendFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

const orgPath = process.env["PF_ORG"]
if (!orgPath)
  throw new Error("The MCP List fixture needs a disposable demo copy")
const org = realpathSync(orgPath)
if (
  dirname(org) !== realpathSync(tmpdir()) ||
  !basename(org).startsWith("pf-temp-org-demo-")
) {
  throw new Error("The MCP List fixture needs a disposable demo copy")
}

const args = process.argv.slice(2)
const [command, ...rest] = args[0] === "--" ? args.slice(1) : args
if (!command)
  throw new Error("Expected a command to run with the MCP List fixture")

// Extend only the copied organisation, using the same Purchase Order data.
appendFileSync(
  join(org, "src/org.ts"),
  `
const mcpPurchaseOrdersView = {
  startProcess: purchaseRequest,
  defaultPageSize: 1,
  output: { id: ES.String, item: ES.String, price: ES.Number },
  query: (ctx: import("@pf/process").ListQueryContext) =>
    Effect.gen(function* () {
      const ops = yield* DemoOperations
      return yield* ops.queryPurchaseOrders(ctx)
    }).pipe(Effect.orDie),
}

new List(org, "purchase-orders-browse-only", {
  ...mcpPurchaseOrdersView,
  name: "Purchase Orders (Browse Only)",
  roles: [employee],
})

new List(org, "purchase-orders-restricted-detail", {
  ...mcpPurchaseOrdersView,
  name: "Purchase Orders (Restricted Detail)",
  roles: [employee],
  form: () => purchaseOrdersForm.fields,
  itemQuery: (id) =>
    Effect.gen(function* () {
      const ops = yield* DemoOperations
      return yield* ops.queryPurchaseOrderById(id)
    }).pipe(Effect.orDie),
})
`,
)
appendFileSync(
  join(org, "cedar/ci.cedar"),
  `
forbid (
    principal is PF::ProviderUser,
    action == PF::Action::"query",
    resource == PF::GraphQLField::"Query.listItemPurchaseOrdersRestrictedDetail"
);
`,
)

const result = spawnSync(command, rest, { stdio: "inherit" })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
