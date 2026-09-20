import assert from "node:assert/strict"
import { Effect } from "effect"
import {
  NoAvailablePortError,
  PortInUseError,
  serveOnExactPort,
  serveWithPortFallback,
  writePortFile,
} from "../server-utils"
import { decodePortFromFileContent } from "../services/port-file"

const port = Number(process.argv[2])
const portFile = process.argv[3]
assert(Number.isInteger(port) && port > 0)
assert(portFile)

const options = {
  development: false,
  fetch: () => new Response("second organisation"),
}

const server = await Effect.runPromise(serveWithPortFallback(port, options))
try {
  assert(server.port > port && server.port < port + 10)
  await Effect.runPromise(writePortFile(portFile, server.port))
  const discoveredPort = decodePortFromFileContent(
    await Bun.file(portFile).text(),
  )
  assert.equal(discoveredPort, server.port)
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal(
      await (
        await fetch(`http://localhost:${discoveredPort}`, { keepalive: false })
      ).text(),
      "second organisation",
    )
    assert.equal(
      await (
        await fetch(`http://localhost:${port}`, { keepalive: false })
      ).text(),
      "first organisation",
    )
  }

  for (const exactOptions of [options, { ...options, reusePort: true }]) {
    const error = await Effect.runPromise(
      serveOnExactPort(port, exactOptions).pipe(Effect.flip),
    )
    assert(error instanceof PortInUseError)
    assert.equal(error.port, port)
  }
  const exhausted = await Effect.runPromise(
    serveWithPortFallback(port, options, 1).pipe(Effect.flip),
  )
  assert(exhausted instanceof NoAvailablePortError)
  assert.equal(exhausted.startPort, port)
  assert.equal(exhausted.endPort, port)
} finally {
  await server.stop(true)
}
process.exit(0)
