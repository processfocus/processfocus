import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"
import { executionTools } from "./executions"
import {
  inspectListForm,
  listWriteTools,
  reportLostListWrite,
} from "./list-writes"
import { listTools } from "./lists"
import type { McpAccess } from "./oauth"
import { callProcessTool, processTools } from "./processes"
import { completeTodoTool, inspectTodoForm, listMyTodos } from "./todos"
import { createServerGraphqlClient } from "@/lib/graphql/server-client"

const readTools = [
  listMyTodos,
  inspectTodoForm,
  ...listTools,
  inspectListForm,
  reportLostListWrite,
  ...executionTools,
]
const tools = [...readTools, completeTodoTool, ...listWriteTools]

export const handleMcp = async (
  request: Request,
  access: McpAccess,
  origin: string,
): Promise<Response> => {
  const server = new Server(
    { name: "process-focus", version: "1.0.0" },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      ...(access.canAct ? tools : readTools).map((tool) => tool.metadata),
      ...processTools,
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
    const tool = tools.find((tool) => tool.metadata.name === params.name)
    const input = params.arguments ?? {}
    const client = createServerGraphqlClient(access.accessToken)
    if (!tool)
      return Effect.runPromise(
        callProcessTool({ client, access, origin, name: params.name, input }),
      )
    return tool.call(
      {
        client,
        canAct: access.canAct,
        origin,
      },
      input,
    )
  })
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    await server.close()
  }
}
