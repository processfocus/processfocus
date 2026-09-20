import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit, Option } from "effect"
import {
  materializeTursoDbDownload,
  streamDumpToPrivateFile,
  validateTursoDbDownloadArtifact,
  writeAllBytes,
} from "../src/commands/db/tursodb-download"
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"

const AUTH_TOKEN = "secret-download-token"

const completeDump = `PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE parents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  notes TEXT,
  payload BLOB,
  optional_value TEXT
);
INSERT INTO parents VALUES(1,'Alice','line1\nline2 with ''quoted'' text',X'deadbeef',NULL);
INSERT INTO parents VALUES(2,'Bob','simple',NULL,'present');
INSERT INTO parents VALUES(3,'Deleted high water',NULL,NULL,NULL);
DELETE FROM parents WHERE id=3;
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence VALUES('parents',3);
CREATE TABLE children (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER NOT NULL REFERENCES parents(id),
  label TEXT NOT NULL
);
INSERT INTO children VALUES(1,1,'child-of-alice');
CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL);
CREATE TABLE __turso_internal_mvcc_meta(k TEXT, v TEXT);
INSERT INTO __turso_internal_mvcc_meta VALUES('engine','mvcc');
CREATE TABLE __turso_internal_seq_parents(
  value INTEGER,
  is_called INTEGER
);
INSERT INTO __turso_internal_seq_parents VALUES(
  3,
  1
);
CREATE INDEX idx_children_parent ON children(parent_id);
CREATE TRIGGER parents_insert_audit
AFTER INSERT ON parents
BEGIN
  INSERT INTO audit_log(message) VALUES('parent=' || NEW.name);
END;
COMMIT;
`

const responseFetch = (
  response: Response,
  inspect?: (url: string, init?: RequestInit) => void,
): typeof fetch => {
  const fetchImpl: typeof fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    inspect?.(String(input), init)
    return response
  }
  fetchImpl.preconnect = fetch.preconnect
  return fetchImpl
}

const getFailureMessage = (exit: Exit.Exit<unknown, unknown>): string => {
  if (!Exit.isFailure(exit)) {
    return ""
  }
  const failure = Cause.failureOption(exit.cause)
  if (Option.isNone(failure)) {
    return ""
  }
  const value = failure.value
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message
  }
  return value instanceof Error ? value.message : String(value)
}

describe("TursoDB logical download materializer", () => {
  const tempDirectories: Array<string> = []

  afterEach(() => {
    for (const directory of tempDirectories) {
      rmSync(directory, { recursive: true, force: true })
    }
    tempDirectories.length = 0
  })

  const makeTempDirectory = (): string => {
    const directory = mkdtempSync(join(tmpdir(), "pfcli-tursodb-download-"))
    tempDirectories.push(directory)
    return directory
  }

  it("completes partial writes before accepting a streamed chunk", async () => {
    const source = new TextEncoder().encode("complete streamed dump chunk")
    const destination = new Uint8Array(source.byteLength)
    let writeCalls = 0

    await Effect.runPromise(
      writeAllBytes({
        bytes: source,
        write: async (bytes, offset, length) => {
          const bytesWritten = Math.min(3, length)
          destination.set(bytes.subarray(offset, offset + bytesWritten), offset)
          writeCalls += 1
          return { bytesWritten }
        },
      }),
    )

    expect(destination).toEqual(source)
    expect(writeCalls).toBeGreaterThan(1)
  })

  it("returns the timeout without awaiting a stalled write during file close", async () => {
    let closeStarted = false
    let finishClose: (() => void) | undefined
    let finishWrite: (() => void) | undefined

    const exit = await Effect.runPromiseExit(
      streamDumpToPrivateFile({
        sourceUrl: "libsql://download.example.turso.io",
        authToken: AUTH_TOKEN,
        dumpPath: "unused-source.sql",
        fetchImpl: responseFetch(new Response("streamed chunk")),
        openDumpFile: async () => ({
          close: () => {
            closeStarted = true
            return new Promise<void>((resolve) => {
              finishClose = resolve
            })
          },
          sync: async () => undefined,
          write: () =>
            new Promise((resolve) => {
              finishWrite = () => resolve({ bytesWritten: 1 })
            }),
        }),
        timeoutMs: 5,
      }),
    )
    finishWrite?.()
    finishClose?.()

    expect(getFailureMessage(exit)).toBe("TursoDB dump request timed out")
    expect(closeStarted).toBe(true)
  })

  it("streams, filters, validates, and atomically replaces a complete SQLite snapshot", async () => {
    const directory = makeTempDirectory()
    const outputPath = join(directory, "snapshot.sqlite")
    writeFileSync(outputPath, "existing-output-must-be-replaced")
    const requests: Array<{
      readonly url: string
      readonly auth: string | null
    }> = []

    await Effect.runPromise(
      materializeTursoDbDownload({
        sourceUrl: "libsql://download.example.turso.io:8443/",
        authToken: AUTH_TOKEN,
        outputPath,
        fetch: responseFetch(new Response(completeDump), (url, init) => {
          requests.push({
            url,
            auth: new Headers(init?.headers).get("Authorization"),
          })
        }),
      }),
    )

    expect(requests).toEqual([
      {
        url: "https://download.example.turso.io:8443/dump",
        auth: `Bearer ${AUTH_TOKEN}`,
      },
    ])
    expect(requests[0]?.url).not.toContain(AUTH_TOKEN)
    expect(statSync(outputPath).mode & 0o777).toBe(0o600)
    expect(
      readdirSync(directory).filter((name) => name.includes(".download-")),
    ).toEqual([])

    const database = new Database(outputPath)
    try {
      expect(
        database
          .query<{ readonly integrity_check: string }, []>(
            "PRAGMA integrity_check",
          )
          .get()?.integrity_check,
      ).toBe("ok")
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
      expect(
        database
          .query<{ readonly count: number }, []>(
            "SELECT count(*) AS count FROM sqlite_schema WHERE name GLOB '__turso_internal_*'",
          )
          .get()?.count,
      ).toBe(0)
      expect(
        database
          .query<{ readonly value: string }, []>(
            "SELECT hex(payload) AS value FROM parents WHERE name = 'Alice'",
          )
          .get()?.value,
      ).toBe("DEADBEEF")
      expect(
        database
          .query<{ readonly value: string | null }, []>(
            "SELECT optional_value AS value FROM parents WHERE name = 'Alice'",
          )
          .get()?.value,
      ).toBeNull()
      expect(
        database
          .query<{ readonly seq: number }, []>(
            "SELECT seq FROM sqlite_sequence WHERE name = 'parents'",
          )
          .get()?.seq,
      ).toBe(3)
      expect(
        database
          .query<{ readonly count: number }, []>(
            "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'index' AND name = 'idx_children_parent'",
          )
          .get()?.count,
      ).toBe(1)
      expect(
        database
          .query<{ readonly count: number }, []>(
            "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND name = 'parents_insert_audit'",
          )
          .get()?.count,
      ).toBe(1)

      database.exec(
        "INSERT INTO parents(name, notes, payload, optional_value) VALUES('After snapshot', NULL, NULL, NULL)",
      )
      expect(
        database
          .query<{ readonly id: number }, []>(
            "SELECT id FROM parents WHERE name = 'After snapshot'",
          )
          .get()?.id,
      ).toBeGreaterThan(3)
      expect(
        database
          .query<{ readonly count: number }, []>(
            "SELECT count(*) AS count FROM audit_log WHERE message = 'parent=After snapshot'",
          )
          .get()?.count,
      ).toBe(1)
    } finally {
      database.close()
    }
  })

  it("rejects non-2xx, empty, malformed, and truncated responses without replacing output", async () => {
    const directory = makeTempDirectory()
    const cases: ReadonlyArray<{
      readonly name: string
      readonly response: Response
      readonly message: string
    }> = [
      {
        name: "http",
        response: new Response(`token=${AUTH_TOKEN}`, { status: 503 }),
        message: "TursoDB dump request failed with HTTP 503",
      },
      {
        name: "empty",
        response: new Response(""),
        message: "TursoDB dump response was empty",
      },
      {
        name: "malformed",
        response: new Response('{"error":"not sql"}'),
        message: "TursoDB dump response was not valid logical SQL",
      },
      {
        name: "truncated",
        response: new Response(
          "PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n",
        ),
        message: "TursoDB dump response was truncated or malformed",
      },
    ]

    for (const testCase of cases) {
      const outputPath = join(directory, `${testCase.name}.sqlite`)
      writeFileSync(outputPath, "existing-output")
      const exit = await Effect.runPromiseExit(
        materializeTursoDbDownload({
          sourceUrl: "libsql://download.example.turso.io",
          authToken: AUTH_TOKEN,
          outputPath,
          fetch: responseFetch(testCase.response),
        }),
      )

      expect(getFailureMessage(exit)).toBe(testCase.message)
      expect(getFailureMessage(exit)).not.toContain(AUTH_TOKEN)
      expect(Bun.file(outputPath).text()).resolves.toBe("existing-output")
    }

    expect(
      readdirSync(directory).filter((name) => name.includes(".download-")),
    ).toEqual([])
  })

  it("aborts stalled dump streams, cleans staging files, and leaves output untouched", async () => {
    const directory = makeTempDirectory()
    const outputPath = join(directory, "snapshot.sqlite")
    writeFileSync(outputPath, "existing-output")
    let cancelled = false
    let requestAborted = false
    let finishCancellation: (() => void) | undefined
    const stalled = new ReadableStream<Uint8Array>({
      cancel: () =>
        new Promise<void>((resolve) => {
          finishCancellation = resolve
          cancelled = true
        }),
    })

    const exit = await Effect.runPromiseExit(
      materializeTursoDbDownload({
        sourceUrl: "libsql://download.example.turso.io",
        authToken: AUTH_TOKEN,
        outputPath,
        fetch: responseFetch(new Response(stalled), (_url, init) => {
          init?.signal?.addEventListener("abort", () => {
            requestAborted = true
          })
        }),
        timeoutMs: 5,
      }),
    )
    finishCancellation?.()

    expect(getFailureMessage(exit)).toBe("TursoDB dump request timed out")
    expect(cancelled).toBe(true)
    expect(requestAborted).toBe(true)
    expect(Bun.file(outputPath).text()).resolves.toBe("existing-output")
    expect(
      readdirSync(directory).filter((name) => name.includes(".download-")),
    ).toEqual([])
  })

  it("preserves operation and staging cleanup failures", async () => {
    const directory = makeTempDirectory()
    const outputPath = join(directory, "snapshot.sqlite")

    const exit = await Effect.runPromiseExit(
      materializeTursoDbDownload({
        sourceUrl: "libsql://download.example.turso.io",
        authToken: AUTH_TOKEN,
        outputPath,
        fetch: responseFetch(new Response('{"error":"not sql"}'), () =>
          chmodSync(directory, 0o500),
        ),
      }),
    ).finally(() => chmodSync(directory, 0o700))

    expect(getFailureMessage(exit)).toBe(
      "TursoDB dump response was not valid logical SQL",
    )
    if (!Exit.isFailure(exit)) {
      throw new Error("Expected materialization and cleanup to fail")
    }
    expect(
      [...Cause.failures(exit.cause)].map((error) => error.message),
    ).toEqual([
      "TursoDB dump response was not valid logical SQL",
      "Failed to materialize TursoDB snapshot",
    ])
    expect(
      readdirSync(directory).filter((name) => name.includes(".download-")),
    ).toHaveLength(1)
  })

  it("rejects foreign-key violations before atomic publication", async () => {
    const directory = makeTempDirectory()
    const outputPath = join(directory, "snapshot.sqlite")
    writeFileSync(outputPath, "existing-output")
    const invalidDump = `PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE parent(id INTEGER PRIMARY KEY);
CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
INSERT INTO child VALUES(1,999);
COMMIT;
`

    const exit = await Effect.runPromiseExit(
      materializeTursoDbDownload({
        sourceUrl: "libsql://download.example.turso.io",
        authToken: AUTH_TOKEN,
        outputPath,
        fetch: responseFetch(new Response(invalidDump)),
      }),
    )

    expect(getFailureMessage(exit)).toBe(
      "Downloaded TursoDB snapshot failed PRAGMA foreign_key_check",
    )
    expect(Bun.file(outputPath).text()).resolves.toBe("existing-output")
  })

  it("rejects corrupt SQLite artifacts through the production integrity validator", async () => {
    const directory = makeTempDirectory()
    const corruptPath = join(directory, "corrupt.sqlite")
    writeFileSync(corruptPath, "not a sqlite database")

    const exit = await Effect.runPromiseExit(
      validateTursoDbDownloadArtifact(corruptPath),
    )

    expect(getFailureMessage(exit)).toBe(
      "Downloaded TursoDB snapshot failed PRAGMA integrity_check",
    )
  })

  it("redacts credentials from invalid URLs and transport failures", async () => {
    const directory = makeTempDirectory()
    const outputPath = join(directory, "snapshot.sqlite")
    const credentialUrl =
      "libsql://download.example.turso.io?authToken=url-secret"

    const invalidUrlExit = await Effect.runPromiseExit(
      materializeTursoDbDownload({
        sourceUrl: credentialUrl,
        authToken: AUTH_TOKEN,
        outputPath,
        fetch: responseFetch(new Response(completeDump)),
      }),
    )
    expect(getFailureMessage(invalidUrlExit)).toBe(
      "Database Download session returned an invalid database URL",
    )
    expect(getFailureMessage(invalidUrlExit)).not.toContain("url-secret")
    expect(getFailureMessage(invalidUrlExit)).not.toContain(AUTH_TOKEN)

    const transportCause = new Error(`failed with ${AUTH_TOKEN}`)
    const failingFetch = async () => {
      throw transportCause
    }
    failingFetch.preconnect = fetch.preconnect
    const transportExit = await Effect.runPromiseExit(
      materializeTursoDbDownload({
        sourceUrl: "libsql://download.example.turso.io",
        authToken: AUTH_TOKEN,
        outputPath,
        fetch: failingFetch,
      }),
    )
    expect(getFailureMessage(transportExit)).toBe("TursoDB dump request failed")
    expect(getFailureMessage(transportExit)).not.toContain(AUTH_TOKEN)
    if (!Exit.isFailure(transportExit)) {
      throw new Error("Expected the transport failure to fail the Effect")
    }
    const failure = Cause.failureOption(transportExit.cause)
    if (Option.isNone(failure)) {
      throw new Error("Expected a typed transport failure")
    }
    expect(failure.value.cause).toBeInstanceOf(Error)
    if (!(failure.value.cause instanceof Error)) {
      throw new Error("Expected the CLI error to preserve its wrapped cause")
    }
    expect(failure.value.cause.cause).toEqual({
      _tag: "SanitizedBoundaryCause",
      errorType: "Error",
    })
    expect(String(failure.value.cause)).not.toContain(AUTH_TOKEN)
    expect(JSON.stringify(failure.value.cause.cause)).not.toContain(AUTH_TOKEN)
  })
})
