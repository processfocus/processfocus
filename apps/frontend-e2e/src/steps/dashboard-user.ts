import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import {
  getEffectiveAuthUrl,
  getEffectiveGraphqlEndpoint,
} from "@pf/frontend-endpoints/port-files"
import { VirtualCredential } from "./passkey-user"

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  )
  return Object.fromEntries(Object.entries(value))
}

/** A run-private cache of real registered devices, never fabricated sessions. */
export const dashboardAccount = (origin: string, email: string) => {
  const directory = process.env["FRONTEND_E2E_PASSKEY_DIRECTORY"]
  assert.ok(
    directory,
    "Dashboard E2E requires its run-private Passkey directory",
  )
  const path = join(
    directory,
    createHash("sha256").update(`${origin}\0${email}`).digest("hex"),
  )
  const credentials = existsSync(path)
    ? Schema.decodeUnknownSync(Schema.Array(VirtualCredential))(
        JSON.parse(readFileSync(path, "utf8")),
      )
    : undefined
  return {
    account: credentials
      ? { kind: "login" as const, email, credentials }
      : { kind: "register" as const, email },
    save: (value: readonly VirtualCredential[]) =>
      writeFileSync(path, JSON.stringify(value), { mode: 0o600 }),
  }
}

export async function dashboardRegistrationLink(
  email: string,
): Promise<string> {
  const linksFile = process.env["FRONTEND_E2E_REGISTRATION_LINKS"]
  if (linksFile) {
    const links = Schema.decodeUnknownSync(
      Schema.Record(Schema.String, Schema.String),
    )(JSON.parse(readFileSync(linksFile, "utf8")))
    const link = links[email]
    assert.ok(link, `No deployment-provisioned Registration Link for ${email}`)
    return link
  }
  const origin = new URL(process.env["BASE_URL"] ?? "")
  assert.ok(
    ["localhost", "127.0.0.1"].includes(origin.hostname),
    "Deployed Dashboard requires deployment-provisioned Registration Links",
  )
  const auth = await fetch(`${getEffectiveAuthUrl()}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`ci-pipeline:${process.env["CI_PIPELINE_SECRET"] ?? ""}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  })
  assert.ok(auth.ok, "Invitation setup authentication failed")
  const token = record(await auth.json())["access_token"]
  assert.equal(typeof token, "string")
  const query = async (query: string, variables: Record<string, unknown>) => {
    const response = await fetch(getEffectiveGraphqlEndpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    })
    const result = record(await response.json())
    assert.ok(!result["errors"], "Invitation setup request failed")
    return record(result["data"])
  }
  const result = await query(
    "query { allInvitations(limit: 100) { items { id email } } }",
    {},
  )
  const invitations = record(result["allInvitations"])["items"]
  assert.ok(Array.isArray(invitations))
  const invitation = invitations
    .map(record)
    .find((row) => row["email"] === email)
  assert.ok(invitation, `Missing Dashboard fixture Invitation for ${email}`)
  const generated = record(
    (
      await query(
        `mutation($id: ID!) { generateRegistrationLink(invitationId: $id) {
          __typename ... on RegistrationLinkActionSuccess { registrationLinkUrl }
        } }`,
        { id: invitation["id"] },
      )
    )["generateRegistrationLink"],
  )
  assert.equal(
    generated["__typename"],
    "RegistrationLinkActionSuccess",
    "Dashboard fixture requires a pending Invitation or its previously registered device",
  )
  const link = generated["registrationLinkUrl"]
  assert.ok(typeof link === "string")
  return link
}
