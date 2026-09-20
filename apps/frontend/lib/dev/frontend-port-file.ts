import { writeFileSync } from "node:fs"
import { resolve } from "node:path"

const FRONTEND_PORT_FILE = ".frontend-port.json"

const getWorkspaceRoot = (): string =>
  process.env["NX_WORKSPACE_ROOT"] ?? resolve(process.cwd(), "../..")

const parsePort = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined
  }

  const port = Number.parseInt(value, 10)

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined
  }

  return port
}

const writeFrontendPortFile = (
  port: number,
  workspaceRoot = getWorkspaceRoot(),
): void => {
  const filePath = resolve(workspaceRoot, FRONTEND_PORT_FILE)

  writeFileSync(filePath, `${JSON.stringify({ port })}\n`, "utf-8")
}

export const writeFrontendPortFileFromEnv = (): number | undefined => {
  const port = parsePort(process.env["PORT"])

  if (port === undefined) {
    return undefined
  }

  writeFrontendPortFile(port)
  return port
}
