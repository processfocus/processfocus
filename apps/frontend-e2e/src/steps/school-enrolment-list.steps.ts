import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type Locator, type Page, expect } from "@playwright/test"
import { createBdd } from "playwright-bdd"
import { Given, Then, When, appDialog, test } from "./fixtures"

const { After } = createBdd(test)
const otherInformation = `not\n\nmore\nthan this\n<b>plain text</b>\n${"Long information that should wrap safely. ".repeat(8)}`
const enquiry = (scenarioState: Map<string, unknown>) => {
  const list = scenarioState.get("enrolmentList")
  if (list !== "pre-enrolments" && list !== "all-enrolment-enquiries") {
    throw new Error("Expected an enrolment List")
  }
  return { list, id: `enrol-e2e-${list}`, child: `List regression ${list}` }
}

// Playwright runs on Node; only fixture setup/cleanup uses the runtime's local Turso layer.
// Never resolve a database from remote configuration or a developer's school DB.
const fixtureDatabase = (action: "seed" | "delete", list: string) => {
  const base = new URL(process.env["BASE_URL"] ?? "http://invalid")
  const marker = process.env["SCHOOL_E2E_RUNTIME_FILE"]
  if (!marker || !["localhost", "127.0.0.1"].includes(base.hostname)) {
    throw new Error(
      "Enrolment fixtures require the disposable local school runtime",
    )
  }
  const org = readFileSync(marker, "utf8")
  if (!org.startsWith(join(tmpdir(), "pf-temp-org-school-"))) {
    throw new Error("Refusing to seed a non-disposable school database")
  }
  execFileSync(
    "bun",
    [
      "-e",
      `
    import { Effect } from "effect";
    import { SqlClient } from "effect/sql/SqlClient";
    import { makeTursoLive } from "./packages/layer-turso-local/src/index.ts";
    const [file, action, list, information] = process.argv.slice(1);
    process.env.SQLITE_DATABASE_PATH = file;
    const id = "enrol-e2e-" + list;
    await Effect.runPromise(Effect.gen(function* () {
      const db = yield* SqlClient;
      yield* db.withTransaction(Effect.gen(function* () {
      yield* db.unsafe("DELETE FROM enrolment_status_change WHERE enrolment_id = ?", [id]);
      yield* db.unsafe("DELETE FROM enrolment WHERE id = ?", [id]);
      if (action === "seed") yield* db.unsafe(
        "INSERT INTO enrolment (id, status, first_name, last_name, child_name, child_enrolment_type, child_current_school, child_current_school_year, child_has_special_learning_needs, email, phone_number, other_information, selected_enrolment_slot_starts_at, created_at) VALUES (?, 'received', 'Synthetic', 'Parent', ?, 'transfer', 'Fixture Primary', 'Year 4', 1, 'list-detail@example.com', '+64210000000', ?, julianday('2030-02-12T01:30:00Z'), julianday('2030-02-01T00:00:00Z'))"
      , [id, "List regression " + list, information]);
      }));
    }).pipe(Effect.provide(makeTursoLive({ busy_timeout: 5000 }))));
  `,
      resolve(org, "db/pf.db"),
      action,
      list,
      otherInformation,
    ],
    { timeout: 10_000, cwd: resolve(__dirname, "../../../..") },
  )
}

Given(
  "a synthetic enrolment for the {string} List",
  async ({ scenarioState }, list: string) => {
    scenarioState.set("enrolmentList", list)
    fixtureDatabase("seed", enquiry(scenarioState).list)
  },
)

After({ tags: "@school-local-db" }, async ({ scenarioState }) => {
  if (scenarioState.has("enrolmentList"))
    fixtureDatabase("delete", enquiry(scenarioState).list)
})

const row = (page: Page, child: string) =>
  page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: child, exact: true }) })

When(
  "I open the synthetic enrolment from its List row",
  async ({ page, scenarioState }) => {
    const { list, child } = enquiry(scenarioState)
    await page.goto(`/lists/${list}?filter=${encodeURIComponent(child)}`, {
      waitUntil: "domcontentloaded",
    })
    await row(page, child)
      .getByRole("cell", { name: child, exact: true })
      .click()
    await expect(appDialog(page)).toBeVisible()
  },
)

const assertDetails = async (
  form: Locator,
  page: Page,
  state: Map<string, unknown>,
  status: string,
) => {
  const { list, id, child } = enquiry(state)
  const values = {
    ID: id,
    "Parent first name": "Synthetic",
    "Parent last name": "Parent",
    "Child name": child,
    "Enrolment type": "transfer",
    "Current school": "Fixture Primary",
    "Current school year": "Year 4",
    Email: "list-detail@example.com",
    "Phone number": "+64210000000",
    Received: "Feb 1, 2030, 13:00",
    ...(list === "pre-enrolments"
      ? { "Special learning needs": "true" }
      : { "Tour date": "Feb 12, 2030, 14:30" }),
  }
  const information = form.locator("#otherInformation")
  await expect(information).toBeVisible()
  expect(await information.textContent()).toBe(otherInformation)
  await expect(information.locator("b, input, textarea")).toHaveCount(0)
  const layout = await information.evaluate((element) => {
    const text = element.firstChild
    if (!text) throw new Error("Missing information text")
    const rect = (start: number, end: number) => {
      const range = document.createRange()
      range.setStart(text, start)
      range.setEnd(text, end)
      return range.getBoundingClientRect()
    }
    const first = rect(0, 3)
    const second = rect(5, 9)
    const third = rect(10, 14)
    return {
      blankLineHeight: second.top - first.top,
      // Compare rendered distances so the modal's scale animation cancels out.
      lineHeight: third.top - second.top,
      overflows: element.scrollWidth > element.clientWidth,
      withinViewport: element.getBoundingClientRect().right <= innerWidth,
    }
  })
  expect(layout.lineHeight).toBeGreaterThan(0)
  expect(layout.blankLineHeight).toBeGreaterThanOrEqual(
    layout.lineHeight * 2 - 1,
  )
  expect(layout.overflows).toBe(false)
  expect(layout.withinViewport).toBe(true)
  for (const [label, value] of Object.entries(values)) {
    const field = form.getByRole("textbox", { name: label, exact: true })
    await expect(field).toHaveValue(value)
    await expect(field).not.toBeEditable()
  }
  await expect(form.getByRole("combobox")).toHaveValue(status)
  await expect(
    page.getByText("This page couldn’t load", { exact: true }),
  ).toHaveCount(0)
}

When("I use a narrow enrolment detail viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
})

Then(
  "the enrolment modal shows the submitted details and status {string}",
  async ({ page, scenarioState }, status: string) => {
    await assertDetails(appDialog(page), page, scenarioState, status)
  },
)

When(
  "I navigate directly to the synthetic enrolment and reload",
  async ({ page, scenarioState }) => {
    const { list, id } = enquiry(scenarioState)
    await page.goto(
      `/lists/item/${id}?list=${encodeURIComponent(`/${list}`)}`,
      { waitUntil: "domcontentloaded" },
    )
    await expect(appDialog(page)).toHaveCount(0)
    await assertDetails(
      page.locator("main"),
      page,
      scenarioState,
      scenarioState.get("savedStatus") === true ? "tour booked" : "received",
    )
    await page.reload({ waitUntil: "domcontentloaded" })
  },
)

Then(
  "the full-page enrolment shows the submitted details and status {string}",
  async ({ page, scenarioState }, status: string) => {
    await expect(appDialog(page)).toHaveCount(0)
    await assertDetails(page.locator("main"), page, scenarioState, status)
  },
)

When(
  "I change the enrolment status to {string} and save",
  async ({ page, scenarioState }, status: string) => {
    const form = appDialog(page)
    const input = form.getByRole("combobox")
    await expect(input).toBeEnabled()
    await input.click()
    await page.getByRole("option", { name: status, exact: true }).click()
    await form.getByRole("button", { name: "Save", exact: true }).click()
    await expect(form).toBeHidden()
    scenarioState.set("savedStatus", true)
  },
)

Then(
  "the originating enrolment List immediately shows {string}",
  async ({ page, scenarioState }, status: string) => {
    // No reload, navigation, filter change or explicit Refresh between save and this assertion.
    const { list, child } = enquiry(scenarioState)
    await expect(page).toHaveURL(new RegExp(`/lists/${list}\\?`))
    await expect(
      row(page, child).getByRole("combobox", {
        name: "Update status",
        exact: true,
      }),
    ).toHaveText(status)
  },
)

When(
  "I reopen the synthetic enrolment from the refreshed List",
  async ({ page, scenarioState }) => {
    await row(page, enquiry(scenarioState).child)
      .getByRole("cell", { name: enquiry(scenarioState).child, exact: true })
      .click()
    await expect(appDialog(page)).toBeVisible()
  },
)
