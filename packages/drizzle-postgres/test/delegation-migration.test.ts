import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SQL } from "bun"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"

// Always start a private local cluster; never consume a configured database URL.
const available = Bun.which("initdb") !== null && Bun.which("pg_ctl") !== null
describe.skipIf(!available)("PostgreSQL delegation lineage concurrency", () => {
  let directory: string
  let started = false
  let observer: SQL
  let issuer: SQL
  let invalidator: SQL

  async function command(args: string[]) {
    const result = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(result.stdout).text(),
      new Response(result.stderr).text(),
      result.exited,
    ])
    if (code !== 0) throw new Error(`${args[0]} failed: ${stdout}\n${stderr}`)
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "pf-postgres-lineage-"))
    await command([
      "initdb",
      "-D",
      join(directory, "data"),
      "-A",
      "trust",
      "-U",
      "postgres",
      "--no-locale",
    ])
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    })
    const port = listener.port
    listener.stop(true)
    await command([
      "pg_ctl",
      "-D",
      join(directory, "data"),
      "-l",
      join(directory, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${port} -k ${directory}`,
      "-w",
      "start",
    ])
    started = true
    const url = `postgres://postgres@127.0.0.1:${port}/postgres`
    observer = new SQL(url, { max: 1 })
    issuer = new SQL(url, { max: 1 })
    invalidator = new SQL(url, { max: 1 })
    const migrations = await Array.fromAsync(
      new Bun.Glob("*/migration.sql").scan(
        new URL("../drizzle/", import.meta.url).pathname,
      ),
    )
    for (const migration of migrations.sort()) {
      const source = await Bun.file(
        new URL(`../drizzle/${migration}`, import.meta.url),
      ).text()
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await observer.unsafe(statement).simple()
      }
    }
    await issuer`SET statement_timeout = '10s'`
    await invalidator`SET statement_timeout = '10s'`
  }, 60_000)

  afterAll(async () => {
    await Promise.all([
      observer?.close(),
      issuer?.close(),
      invalidator?.close(),
    ])
    if (started)
      await command([
        "pg_ctl",
        "-D",
        join(directory, "data"),
        "-m",
        "immediate",
        "-w",
        "stop",
      ])
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await observer
      .unsafe(`
      TRUNCATE pf_user, pf_org_unit CASCADE;
      INSERT INTO pf_org_unit (id, name, org_unit_level, path) VALUES ('org', 'Org', 'root', '/');
      INSERT INTO pf_user (id, provider, sub, last_logged_in)
        VALUES ('user', 'google', 'user', now()), ('disabled-user', 'google', 'disabled', now()),
               ('unassigned-disabled-user', 'google', 'unassigned-disabled', now());
      UPDATE pf_user SET _deleted = true WHERE id <> 'user';
      INSERT INTO pf_provider_user (id, user_id, email, name, first_name, last_name, picture, locale, org_unit_id)
        VALUES ('owner', 'user', 'owner@example.com', 'Owner', 'Owner', '', '', 'en', 'org'),
               ('disabled-owner', 'disabled-user', 'disabled@example.com', 'Disabled', 'Disabled', '', '', 'en', 'org');
      INSERT INTO pf_delegation (id, owner_provider_user, delegation_name, active_delegation_name)
        VALUES ('root', 'owner', 'Root', 'Root'), ('parent', 'owner', 'Parent', 'Parent'), ('child', 'owner', 'Child', 'Child');
      INSERT INTO pf_secret_generation (id, delegation_id, secret_verifier, secret_issued_at, secret_expires_at)
        VALUES ('root-generation', 'root', 'root-verifier', '2026-09-01', '2026-09-15');
      INSERT INTO pf_secret_generation (id, delegation_id, secret_verifier, secret_issued_at, secret_expires_at, parent_secret_generation)
        VALUES ('parent-generation', 'parent', 'parent-verifier', '2026-09-02', '2026-09-14', 'root-generation');
      INSERT INTO pf_delegation_history (id, delegation_id, secret_generation_id, actor_provider_user, delegation_event, secret_issued_at)
        VALUES ('history', 'root', 'root-generation', 'owner', 'created', '2026-09-01');
    `)
      .simple()
  })

  const child = `INSERT INTO pf_secret_generation
    (id, delegation_id, secret_verifier, secret_issued_at, secret_expires_at, parent_secret_generation)
    VALUES ('child-generation', 'child', 'child-verifier', '2026-09-03', '2026-09-10', 'parent-generation')`
  const invalidations = [
    [
      "ancestor revocation",
      "UPDATE pf_secret_generation SET secret_revoked_at = now() WHERE id = 'root-generation'",
    ],
    [
      "parent revocation",
      "UPDATE pf_secret_generation SET secret_revoked_at = now() WHERE id = 'parent-generation'",
    ],
    [
      "ancestor deletion",
      "UPDATE pf_secret_generation SET _deleted = true WHERE id = 'root-generation'",
    ],
    [
      "ancestor expiry",
      "UPDATE pf_secret_generation SET secret_expires_at = '2026-09-02' WHERE id = 'root-generation'",
    ],
    [
      "delegation revocation",
      "UPDATE pf_delegation SET secret_revoked_at = now() WHERE id = 'root'",
    ],
    [
      "delegation deletion",
      "UPDATE pf_delegation SET _deleted = true WHERE id = 'root'",
    ],
    [
      "delegation owner change",
      "UPDATE pf_delegation SET owner_provider_user = 'disabled-owner' WHERE id = 'root'",
    ],
    [
      "provider-user deletion",
      "UPDATE pf_provider_user SET _deleted = true WHERE id = 'owner'",
    ],
    [
      "provider-user identity change",
      "UPDATE pf_provider_user SET user_id = 'unassigned-disabled-user' WHERE id = 'owner'",
    ],
    ["user deletion", "UPDATE pf_user SET _deleted = true WHERE id = 'user'"],
    [
      "replacement insertion",
      `INSERT INTO pf_delegation_history
      (id, delegation_id, secret_generation_id, actor_provider_user, delegation_event, secret_issued_at)
      VALUES ('replacement', 'root', 'root-generation', 'owner', 'replaced', '2026-09-01')`,
    ],
    [
      "replacement update",
      "UPDATE pf_delegation_history SET delegation_event = 'replaced' WHERE id = 'history'",
    ],
  ] satisfies [string, string][]

  async function waitForBlock(connection: SQL, blocker: SQL) {
    const [waiting] = await connection<
      { pid: number }[]
    >`SELECT pg_backend_pid() AS pid`
    const [holding] = await blocker<
      { pid: number }[]
    >`SELECT pg_backend_pid() AS pid`
    return async () => {
      const deadline = performance.now() + 3_000
      while (performance.now() < deadline) {
        const [row] = await observer<
          { blocked: boolean }[]
        >`SELECT ${holding!.pid} = ANY(pg_blocking_pids(${waiting!.pid})) AS blocked`
        if (row?.blocked) return
        await Bun.sleep(10)
      }
      throw new Error(
        "Expected the competing transaction to wait for a row lock",
      )
    }
  }

  for (const [name, mutation] of invalidations) {
    it(`rejects child after committed ${name}`, async () => {
      const blocked = await waitForBlock(issuer, invalidator)
      await invalidator`BEGIN ISOLATION LEVEL READ COMMITTED`
      await issuer`BEGIN ISOLATION LEVEL READ COMMITTED`
      try {
        await invalidator.unsafe(mutation)
        const result = issuer
          .unsafe(child)
          .execute()
          .then(
            () => null,
            (error: unknown) => error,
          )
        await blocked()
        await invalidator`COMMIT`
        expect(await result).toBeInstanceOf(Error)
        expect(String(await result)).toContain(
          "Invalid Secret Generation lineage",
        )
      } finally {
        await invalidator`ROLLBACK`
        await issuer`ROLLBACK`
      }
      expect(
        await observer`SELECT id FROM pf_secret_generation WHERE id = 'child-generation'`,
      ).toHaveLength(0)
    }, 15_000)

    it(`holds ${name} until child issuance commits`, async () => {
      const blocked = await waitForBlock(invalidator, issuer)
      await issuer`BEGIN ISOLATION LEVEL READ COMMITTED`
      await invalidator`BEGIN ISOLATION LEVEL READ COMMITTED`
      try {
        await issuer.unsafe(child)
        const result = invalidator
          .unsafe(mutation)
          .execute()
          .then(
            () => null,
            (error: unknown) => error,
          )
        await blocked()
        await issuer`COMMIT`
        expect(await result).toBeNull()
        await invalidator`COMMIT`
      } finally {
        await issuer`ROLLBACK`
        await invalidator`ROLLBACK`
      }
      expect(
        await observer`SELECT id FROM pf_secret_generation WHERE id = 'child-generation'`,
      ).toHaveLength(1)
    }, 15_000)
  }
})
