import { randomUUID } from "node:crypto"
import { expect } from "@playwright/test"
import { Schema } from "effect"
import { Then } from "./fixtures"
import { connectMcpTransport } from "./mcp-todos.steps"

const listPath = "/board-members"
const receiptId = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.Struct({
      structuredContent: Schema.Struct({
        status: Schema.Literal("created"),
        id: Schema.NonEmptyString,
      }),
    }),
  }),
)

Then(
  "public MCP maintains Board Member records only with the required authority",
  async ({ page, baseURL, browser }) => {
    if (!baseURL) throw new Error("Dashboard URL required")
    const acting = await connectMcpTransport({
      page,
      baseURL,
      choice: "View and act",
      signIn: "Google",
      googleAccount: "Continue as other user",
    })
    const viewOnly = await connectMcpTransport({
      page,
      baseURL,
      choice: "View work",
      signIn: "Google",
      googleAccount: "Continue as other user",
    })
    const officePage = await browser.newPage({ baseURL })
    try {
      const office = await connectMcpTransport({
        page: officePage,
        baseURL,
        choice: "View and act",
        signIn: "Google",
      })
      type Client = typeof acting
      const call = async (client: Client, name: string, args = {}) =>
        (await client(name, args)).json()
      const write = (client: Client, name: string, args: object) =>
        call(client, `${name}_list_record`, {
          listPath,
          confirmed: true,
          ...args,
        })
      const form = (operation: "create" | "update") =>
        call(acting, "inspect_list_form", { listPath, operation })
      const filter = randomUUID()
      const browse = (client = acting) =>
        call(client, "browse_list", { listPath, filter })
      const inspect = (id: string) =>
        call(acting, "inspect_list_record", { listPath, id })
      const input = {
        firstName: "MCP Test",
        lastName: filter,
        email: `${filter}@example.com`,
        officialStartDate: "2026-01-01T00:00:00.000Z",
        status: "Active",
      }

      await expect(
        call(acting, "inspect_list_form", {
          listPath: "/key-register",
          operation: "update",
        }),
      ).resolves.toMatchObject({
        result: {
          structuredContent: {
            dashboardUrl: new URL("/lists/key-register", baseURL).href,
            fields: expect.arrayContaining([
              expect.objectContaining({
                name: "keyColour",
                label: "Key Colour",
                lookup: true,
              }),
              expect.objectContaining({ name: "status", lookup: true }),
            ]),
          },
        },
      })
      await expect(
        write(acting, "update", {
          listPath: "/key-register",
          id: "example-key-id",
          input: { keyColour: "Guessed colour" },
        }),
      ).resolves.toMatchObject({
        result: {
          structuredContent: {
            status: "dashboard_required",
            dashboardUrl: new URL(
              "/lists/item/example-key-id?list=%2Fkey-register",
              baseURL,
            ).href,
          },
        },
      })

      await expect(form("create")).resolves.toMatchObject({
        result: {
          structuredContent: {
            fields: expect.arrayContaining([
              expect.objectContaining({
                name: "status",
                label: "Status",
                hasDefault: true,
                defaultValue: "Active",
                enumValues: ["Active", "Inactive"],
              }),
            ]),
          },
        },
      })
      await expect(form("update")).resolves.toMatchObject({
        result: {
          structuredContent: {
            fields: expect.arrayContaining([
              expect.objectContaining({ name: "status", hasDefault: false }),
            ]),
          },
        },
      })
      await expect(
        write(acting, "create", { input: { ...input, firstName: null } }),
      ).resolves.toMatchObject({
        result: {
          isError: true,
          structuredContent: {
            status: "rejected",
            errors: expect.arrayContaining([
              expect.objectContaining({
                message: expect.stringContaining("required fields"),
              }),
            ]),
          },
        },
      })
      await expect(
        write(acting, "create", { input: { ...input, email: "invalid" } }),
      ).resolves.toMatchObject({
        result: {
          isError: true,
          structuredContent: {
            status: "rejected",
            errors: expect.arrayContaining([
              expect.objectContaining({ field: "email" }),
            ]),
          },
        },
      })
      const created = await write(acting, "create", { input })
      const { id } = receiptId(created).result.structuredContent
      expect(created).toHaveProperty(
        "result.structuredContent.message",
        expect.stringContaining("No Process was started"),
      )
      const second = {
        ...input,
        email: `second-${input.email}`,
      }
      const duplicate = receiptId(
        await write(acting, "create", { input: second }),
      ).result.structuredContent.id
      await expect(browse(office)).resolves.toMatchObject({
        result: {
          structuredContent: {
            records: {
              totalCount: 2,
              items: expect.arrayContaining([
                expect.objectContaining({ id }),
                expect.objectContaining({ id: duplicate }),
              ]),
            },
          },
        },
      })
      const edited = { ...input, status: "Inactive" }
      for (const [name, args] of [
        ["create", { input: { ...input, email: `denied-${input.email}` } }],
        ["update", { id, input: edited }],
        ["delete", { id }],
      ] as const) {
        await expect(write(viewOnly, name, args)).resolves.toMatchObject({
          result: {
            isError: true,
            content: [{ text: expect.stringContaining("View work") }],
          },
        })
        await expect(write(office, name, args)).resolves.toMatchObject({
          result: {
            isError: true,
            content: [{ text: expect.stringContaining("did not authorize") }],
          },
        })
      }
      await expect(inspect(id)).resolves.toMatchObject({
        result: { structuredContent: { record: { status: "Active" } } },
      })
      await expect(
        write(acting, "update", { id, input: { ...edited, firstName: 42 } }),
      ).resolves.toMatchObject({
        result: { isError: true, structuredContent: { status: "rejected" } },
      })
      await expect(
        write(acting, "update", {
          id,
          input: { ...edited, status: "Unknown" },
        }),
      ).resolves.toMatchObject({
        result: { isError: true, structuredContent: { status: "rejected" } },
      })
      await expect(
        write(acting, "update", { id, input: edited }),
      ).resolves.toMatchObject({
        result: { structuredContent: { status: "updated", id } },
      })
      await expect(inspect(id)).resolves.toMatchObject({
        result: { structuredContent: { record: { status: "Inactive" } } },
      })
      for (const ambiguous of [{ filter }, { id: [id, duplicate] }]) {
        await expect(write(acting, "delete", ambiguous)).resolves.toMatchObject(
          {
            result: { isError: true },
          },
        )
      }
      await expect(write(acting, "delete", { id })).resolves.toMatchObject({
        result: { structuredContent: { status: "deleted", id } },
      })
      await expect(inspect(id)).resolves.toMatchObject({
        result: { structuredContent: { record: null } },
      })

      // Discard the public HTTP response before the client sees its tool result.
      const lost = await acting("create_list_record", {
        listPath,
        confirmed: true,
        input: { ...input, email: `lost-${input.email}` },
      })
      await lost.body?.cancel()
      await expect(browse()).resolves.toMatchObject({
        result: {
          structuredContent: {
            records: {
              totalCount: 2,
              items: expect.arrayContaining([
                expect.objectContaining({ id: duplicate }),
                expect.objectContaining({ email: `lost-${input.email}` }),
              ]),
            },
          },
        },
      })
      const outcome = await call(acting, "report_lost_list_write")
      expect(outcome).toMatchObject({
        result: {
          structuredContent: {
            status: "unknown",
            message: expect.stringContaining("Do not repeat"),
          },
        },
      })
      expect(outcome).not.toHaveProperty("result.structuredContent.id")
      await expect(browse()).resolves.toMatchObject({
        result: { structuredContent: { records: { totalCount: 2 } } },
      })
    } finally {
      await officePage.close()
    }
  },
)
