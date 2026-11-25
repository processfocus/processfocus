import * as childProcess from "node:child_process"
import * as fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import * as net from "node:net"
import * as localDatabase from "@tursodatabase/database"
import * as remoteDatabase from "@tursodatabase/serverless"
import * as syncDatabase from "@tursodatabase/sync"
import { generateWithReport } from "usage-spec-effect"
// The only intentional application file read at import is its own manifest.
import { CLI_PACKAGE_VERSION as version } from "../../src/package-metadata"
import * as sqlite from "bun:sqlite"
import { mock, spyOn } from "bun:test"

const attempts: string[] = []
const deny = (name: string) => (): never => {
  attempts.push(name)
  throw new Error(`Offline export attempted ${name}`)
}
spyOn(fs, "readFileSync").mockImplementation(deny("file/credential read"))
spyOn(fs, "writeFileSync").mockImplementation(deny("file/credential write"))
spyOn(fsPromises, "readFile").mockImplementation(deny("async file read"))
spyOn(fsPromises, "writeFile").mockImplementation(deny("async file write"))
spyOn(Bun, "file").mockImplementation(deny("Bun file access"))
spyOn(Bun, "write").mockImplementation(deny("Bun file write"))
spyOn(Bun, "spawn").mockImplementation(deny("process launch"))
spyOn(Bun, "spawnSync").mockImplementation(deny("sync process launch"))
spyOn(Bun, "build").mockImplementation(deny("organisation build"))
spyOn(Bun, "serve").mockImplementation(deny("listener"))
spyOn(localDatabase, "connect").mockImplementation(deny("local database"))
spyOn(remoteDatabase, "connect").mockImplementation(deny("remote database"))
spyOn(syncDatabase, "connect").mockImplementation(deny("database download"))
mock.module("bun:sqlite", () => ({
  ...sqlite,
  Database: class {
    constructor() {
      deny("SQLite database")()
    }
  },
}))
spyOn(childProcess, "spawn").mockImplementation(deny("node process launch"))
spyOn(childProcess, "spawnSync").mockImplementation(deny("node sync launch"))
spyOn(net.Socket.prototype, "connect").mockImplementation(deny("socket"))
spyOn(net.Server.prototype, "listen").mockImplementation(deny("node listener"))
spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(deny("network"), { preconnect: deny("network preconnect") }),
)

const { pfcliCommand } = await import("../../src/main")
const report = generateWithReport(pfcliCommand, { version })
if (attempts.length || report.unsupported.length) {
  throw new Error(JSON.stringify({ attempts, unsupported: report.unsupported }))
}
// Positive control through the actual transitive module's named fs import.
// readCredentials catches IO failures, so verify the denied attempt as well.
const { readCredentials } = await import("../../src/utils/credentials")
const credentials = readCredentials()
if (
  credentials !== null ||
  attempts.length !== 1 ||
  attempts[0] !== "file/credential read"
) {
  throw new Error("Offline guard failed to intercept transitive credential IO")
}
process.stdout.write(report.kdl)
