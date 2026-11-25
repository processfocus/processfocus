import { connect } from "@tursodatabase/database"

const path = process.argv[2]
if (!path) throw new Error("Database path required")
const db = await connect(path, { experimental: ["multiprocess_wal"] })
try {
  await db.exec("PRAGMA journal_mode = wal")
  await db.exec("BEGIN IMMEDIATE")
  await db.exec("INSERT INTO immediate_values VALUES ('competitor')")
  process.stdout.write("ready\n")
  for await (const _chunk of Bun.stdin.stream()) break
  await db.exec("COMMIT")
} finally {
  await db.close()
}
