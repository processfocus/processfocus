import { describe, expect, it } from "vitest"
import {
  canonicalTursoLibsqlUrl,
  filterTursoInternalStatements,
  httpsDumpUrlFromTursoLibsqlUrl,
  httpsUrlFromTursoLibsqlUrl,
  isPlausibleTursoSqlDumpPrefix,
  isPlausibleTursoSqlDumpSuffix,
} from "./turso-transfer.js"

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)

describe("Turso transfer contract", () => {
  it("normalizes canonical libsql URLs for HTTPS and dump requests", () => {
    expect(
      canonicalTursoLibsqlUrl("libsql://Primary.Example.turso.io:8443/"),
    ).toBe("libsql://primary.example.turso.io:8443")
    expect(
      httpsUrlFromTursoLibsqlUrl("libsql://primary.example.turso.io/"),
    ).toBe("https://primary.example.turso.io")
    expect(
      httpsDumpUrlFromTursoLibsqlUrl("libsql://primary.example.turso.io:8443"),
    ).toBe("https://primary.example.turso.io:8443/dump")
  })

  it("rejects credential-bearing and non-canonical source URLs safely", () => {
    for (const sourceUrl of [
      "https://primary.example.turso.io",
      "libsql://user:secret@primary.example.turso.io",
      "libsql://primary.example.turso.io/not-root",
      "libsql://primary.example.turso.io?authToken=secret",
      "libsql://primary.example.turso.io#secret",
    ]) {
      expect(() => httpsDumpUrlFromTursoLibsqlUrl(sourceUrl)).toThrow(
        "Turso database URL must be a bare libsql: host URL",
      )
      try {
        httpsDumpUrlFromTursoLibsqlUrl(sourceUrl)
      } catch (error) {
        expect(String(error)).not.toContain("secret")
      }
    }
  })

  it("recognizes complete logical dump boundaries", () => {
    const dump = bytes(
      "PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE example(id INTEGER);\nCOMMIT;\n",
    )
    expect(isPlausibleTursoSqlDumpPrefix(dump)).toBe(true)
    expect(isPlausibleTursoSqlDumpSuffix(dump)).toBe(true)
    expect(isPlausibleTursoSqlDumpPrefix(bytes("<html>nope</html>"))).toBe(
      false,
    )
    expect(isPlausibleTursoSqlDumpSuffix(bytes("BEGIN TRANSACTION;\n"))).toBe(
      false,
    )
  })

  it("filters Turso internal objects without filtering user values", () => {
    const dump = `PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE user_data(id INTEGER, note TEXT);
INSERT INTO user_data VALUES(1,'__turso_internal_mvcc_meta');
CREATE TABLE __turso_internal_mvcc_meta(k TEXT, v TEXT);
INSERT INTO __turso_internal_mvcc_meta VALUES('engine','mvcc');
CREATE TABLE __turso_internal_seq_example(
  value INTEGER
);
INSERT INTO __turso_internal_seq_example VALUES(
  7
);
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence VALUES('user_data',7);
COMMIT;
`
    const filtered = filterTursoInternalStatements(dump)

    expect(filtered).toContain(
      "INSERT INTO user_data VALUES(1,'__turso_internal_mvcc_meta')",
    )
    expect(filtered).toContain("INSERT INTO sqlite_sequence")
    expect(filtered).not.toContain("CREATE TABLE __turso_internal")
    expect(filtered).not.toContain("INSERT INTO __turso_internal")
    expect(filtered).not.toMatch(/^\s*7\s*$/mu)
    expect(filtered).toContain("COMMIT;")
  })

  it("preserves multiline user text that resembles internal SQL", () => {
    const dump = `PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE notes(id INTEGER, body TEXT);
INSERT INTO notes VALUES(1,'first line
CREATE TABLE __turso_internal_user_text;
UPDATE __turso_internal_user_text SET value = 1;
last line');
CREATE TABLE __turso_internal_mvcc_meta(k TEXT, v TEXT);
INSERT INTO __turso_internal_mvcc_meta VALUES('engine','mvcc');
COMMIT;
`
    const filtered = filterTursoInternalStatements(dump)

    expect(filtered).toContain(`INSERT INTO notes VALUES(1,'first line
CREATE TABLE __turso_internal_user_text;
UPDATE __turso_internal_user_text SET value = 1;
last line');`)
    expect(filtered).not.toContain("CREATE TABLE __turso_internal_mvcc_meta")
    expect(filtered).not.toContain("INSERT INTO __turso_internal_mvcc_meta")
  })
})
