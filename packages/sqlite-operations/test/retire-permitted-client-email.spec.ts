import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"

test("retires email permissions without modifying the identities and grants they refer to", () => {
  using db = new Database(":memory:")
  const folder = join(import.meta.dirname, "../../drizzle-sqlite/drizzle")
  const retirement = "20261119223342_lucky_lester"
  const apply = (migration: string) =>
    db.exec(readFileSync(join(folder, migration, "migration.sql"), "utf8"))
  for (const migration of readdirSync(folder).sort()) {
    if (migration >= retirement) break
    apply(migration)
  }
  db.exec(`
    PRAGMA foreign_keys = ON;
    INSERT INTO pf_org_unit (id, name, org_unit_level, path)
      VALUES ('ou-root', 'Root', 'root', '/');
    INSERT INTO pf_role (id, org_unit_id, name, path)
      VALUES ('role-ci', 'ou-root', 'CI', '/CI');
    INSERT INTO pf_user (id, provider, sub)
      VALUES ('usr-owner', 'google', 'google-owner');
    INSERT INTO pf_provider_user
      (id, user_id, email, name, first_name, last_name, picture, locale, org_unit_id)
      VALUES ('pu-owner', 'usr-owner', 'owner@example.test', 'Owner', 'Owner', '', '', 'en', 'ou-root');
    INSERT INTO pf_oauth_client (id, client_id, client_secret_hash, audience, workload_trust)
      VALUES ('ocl-ci', 'ci-client', 'existing-hash', 'graphql-api', NULL),
             ('ocl-fed', 'github-federation', '', 'graphql-api',
              '{"owner":"project","projectId":"prj-1","name":"Existing deployer","targetIssuer":"https://backend.example.test","assertionAudience":"pf:prj-1","repository":"example/repo","ref":"refs/heads/trunk","workflowRef":"example/repo/.github/workflows/deploy.yml@refs/heads/trunk","environment":"ci","events":["push"],"permissions":["deploy"],"enabled":true,"identity":{"kind":"enrolled","repositoryId":"1","repositoryOwnerId":"2"},"providerUserId":"usr-owner","providerUserEmail":"owner@example.test"}');
    INSERT INTO pf_permitted_client_role (id, oauth_client_id, role_id)
      VALUES ('pcr-ci', 'ocl-ci', 'role-ci');
    INSERT INTO pf_delegation (id, owner_provider_user, delegation_name, active_delegation_name)
      VALUES ('dlg-owner', 'pu-owner', 'agent', 'agent');
    INSERT INTO pf_secret_generation (id, delegation_id, secret_verifier, secret_issued_at, secret_expires_at)
      VALUES ('dsg-owner', 'dlg-owner', 'existing-verifier', 2460000, 2460010);
    INSERT INTO pf_permitted_client_email (id, oauth_client_id, email)
      VALUES ('pce-old', 'ocl-ci', 'owner@example.test');
  `)
  const identities = () => [
    db.query("SELECT * FROM pf_oauth_client ORDER BY id").all(),
    db.query("SELECT * FROM pf_permitted_client_role").all(),
    db.query("SELECT * FROM pf_user").all(),
    db.query("SELECT * FROM pf_provider_user").all(),
    db.query("SELECT * FROM pf_delegation").all(),
    db.query("SELECT * FROM pf_secret_generation").all(),
  ]
  const before = identities()
  apply(retirement)
  expect(identities()).toEqual(before)
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
  expect(() =>
    db.query("SELECT * FROM pf_permitted_client_email").all(),
  ).toThrow("no such table")
})
