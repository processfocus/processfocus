import { describe, expect, it } from "vitest"
import { getRxDbDatabaseName } from "../lib/collections/rxdb-database-name"

describe("session database names", () => {
  const session = {
    orgId: "school",
    userId: "berend",
    roles: ["/Administrator", "/Career Counsellor"],
  }
  it("isolates each exclusive Role from the combined login", () => {
    const combined = getRxDbDatabaseName(session)
    const admin = getRxDbDatabaseName({ ...session, roles: ["/Administrator"] })
    const counsellor = getRxDbDatabaseName({
      ...session,
      roles: ["/Career Counsellor"],
    })
    expect(new Set([combined, admin, counsellor]).size).toBe(3)
    expect(combined).not.toBe("pf-school")
    expect(
      getRxDbDatabaseName({ ...session, userId: "another-user" }),
    ).not.toBe(combined)
    expect(getRxDbDatabaseName({ ...session, orgId: "another-org" })).not.toBe(
      combined,
    )
  })
  it("normalizes ordering and duplicate Roles without conflating different sets", () => {
    expect(
      getRxDbDatabaseName({
        ...session,
        roles: ["/Career Counsellor", "/Administrator", "/Administrator"],
      }),
    ).toBe(getRxDbDatabaseName(session))
    expect(getRxDbDatabaseName({ ...session, roles: ["a,b"] })).not.toBe(
      getRxDbDatabaseName({ ...session, roles: ["a", "b"] }),
    )
  })
})
