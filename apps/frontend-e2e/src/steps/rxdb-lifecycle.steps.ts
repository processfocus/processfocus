import type { Page, Response } from "@playwright/test"
import { expect } from "@playwright/test"
import { Given, Then, When } from "./fixtures"

const FIVE_DAYS_MS = 432_000_000
const LAST_SUCCESSFUL_USE_SUFFIX = ":rxdb:last-successful-use:v1"
const RESET_GENERATION_SUFFIX = ":rxdb:reset-generation:v1"

interface StorageEntry {
  readonly key: string
  readonly value: string
}

const readLifecycleMarkerKey = (page: Page): Promise<string | null> =>
  page.evaluate(
    (suffix) =>
      Object.keys(localStorage).find((key) => key.endsWith(suffix)) ?? null,
    LAST_SUCCESSFUL_USE_SUFFIX,
  )

const readGeneration = (page: Page): Promise<number> =>
  page.evaluate((suffix) => {
    const key = Object.keys(localStorage).find((item) => item.endsWith(suffix))
    if (!key) return 0
    const value = Number(localStorage.getItem(key))
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  }, RESET_GENERATION_SUFFIX)

const readReplicationCheckpoints = (page: Page): Promise<StorageEntry[]> =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .filter(
        (key) =>
          key.startsWith("RxDB-ls-doc-") &&
          key.includes("--rx-replication-meta-"),
      )
      .flatMap((key) => {
        const value = localStorage.getItem(key)
        return value === null ? [] : [{ key, value }]
      }),
  )

const isDraftPushResponse = (response: Response): boolean =>
  response.request().postData()?.includes("PushDraftProcessExecution") === true

When(
  "I edit the purchase request item to {string} and then {string}",
  async ({ page }, first: string, latest: string) => {
    const item = page.getByRole("textbox", { name: "Item", exact: true })
    for (const value of [first, latest]) {
      const pushResponsePromise = page.waitForResponse(isDraftPushResponse)
      await item.fill(value)
      const pushResponse = await pushResponsePromise
      expect(pushResponse.ok()).toBe(true)
      expect(await pushResponse.json()).toMatchObject({
        data: { pushDraftProcessExecution: [] },
      })
    }
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(localStorage).some((key) =>
            key.startsWith("process-start-draft-"),
          ),
        ),
      )
      .toBe(false)
    await page.getByRole("button", { name: "Close", exact: true }).click()
  },
)

When(
  "I record the current RxDB lifecycle and replication checkpoint",
  async ({ page, scenarioState }) => {
    const markerKey = await readLifecycleMarkerKey(page)
    expect(markerKey).not.toBeNull()
    if (!markerKey) throw new Error("RxDB lifecycle marker was not written")

    await expect
      .poll(() => readReplicationCheckpoints(page), {
        message: "Waiting for RxDB replication checkpoints",
        timeout: 30_000,
      })
      .not.toHaveLength(0)

    scenarioState.set("rxdbLifecycleMarkerKey", markerKey)
    scenarioState.set("rxdbLifecycleGeneration", await readGeneration(page))
    scenarioState.set(
      "rxdbLifecycleCheckpoints",
      await readReplicationCheckpoints(page),
    )
  },
)

When(
  "I make the current RxDB lifecycle marker exactly five days old",
  async ({ page, scenarioState }) => {
    const markerKey = scenarioState.get("rxdbLifecycleMarkerKey")
    if (typeof markerKey !== "string") {
      throw new Error("RxDB lifecycle marker was not recorded")
    }
    await page.evaluate(
      ({ key, thresholdMs }) => {
        localStorage.setItem(key, String(Date.now() - thresholdMs))
      },
      { key: markerKey, thresholdMs: FIVE_DAYS_MS },
    )
  },
)

When(
  "I reload the Dashboard without changing authentication",
  async ({ page }) => {
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(
      page.getByRole("heading", { name: "Processes", exact: true }),
    ).toBeVisible({ timeout: 30_000 })
  },
)

Then(
  "the RxDB reset generation should advance once",
  async ({ page, scenarioState }) => {
    const initialGeneration = scenarioState.get("rxdbLifecycleGeneration")
    if (typeof initialGeneration !== "number") {
      throw new Error("RxDB reset generation was not recorded")
    }
    await expect.poll(() => readGeneration(page)).toBe(initialGeneration + 1)

    const markerKey = scenarioState.get("rxdbLifecycleMarkerKey")
    if (typeof markerKey !== "string") {
      throw new Error("RxDB lifecycle marker was not recorded")
    }
    await expect
      .poll(() =>
        page.evaluate(
          ({ key, thresholdMs }) => {
            const value = Number(localStorage.getItem(key))
            return Date.now() - value < thresholdMs
          },
          { key: markerKey, thresholdMs: FIVE_DAYS_MS },
        ),
      )
      .toBe(true)
  },
)

Then(
  "the previous replication checkpoint should be replaced",
  async ({ page, scenarioState }) => {
    const checkpoints = scenarioState.get("rxdbLifecycleCheckpoints")
    if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
      throw new Error("RxDB replication checkpoints were not recorded")
    }
    const recordedEntries = checkpoints.filter(
      (entry): entry is StorageEntry =>
        typeof entry === "object" &&
        entry !== null &&
        "key" in entry &&
        typeof entry.key === "string" &&
        "value" in entry &&
        typeof entry.value === "string",
    )
    expect(recordedEntries).toHaveLength(checkpoints.length)

    await expect
      .poll(
        () =>
          page.evaluate(
            (entries) =>
              entries.every(
                ({ key, value }) => localStorage.getItem(key) !== value,
              ),
            recordedEntries,
          ),
        { message: "Waiting for old replication checkpoints to be replaced" },
      )
      .toBe(true)
  },
)

Then(
  "the purchase request item should be {string}",
  async ({ page }, item: string) => {
    await expect(
      page.getByRole("textbox", { name: "Item", exact: true }),
    ).toHaveValue(item, { timeout: 15_000 })
  },
)

Given(
  "another tab is using the same organisation database",
  async ({ context, page, scenarioState }) => {
    const peerPage = await context.newPage()
    await peerPage.goto("/processes", { waitUntil: "domcontentloaded" })
    await expect(
      peerPage.getByRole("heading", { name: "Processes", exact: true }),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      peerPage.getByRole("heading", {
        name: "Purchase Request",
        exact: true,
      }),
    ).toBeVisible({ timeout: 30_000 })
    scenarioState.set("rxdbLifecycleGeneration", await readGeneration(page))
  },
)

When(
  "both tabs resume with a five-day-old lifecycle marker",
  async ({ context, page }) => {
    const peer = context.pages().find((candidate) => candidate !== page)
    if (!peer) throw new Error("Peer Dashboard tab was not opened")
    const markerKey = await readLifecycleMarkerKey(page)
    if (!markerKey) throw new Error("RxDB lifecycle marker was not written")

    await page.evaluate(
      ({ key, thresholdMs }) => {
        localStorage.setItem(key, String(Date.now() - thresholdMs))
      },
      { key: markerKey, thresholdMs: FIVE_DAYS_MS },
    )

    const tabs = [page, peer]
    const reloads = tabs.map((tab) =>
      tab.waitForEvent("framenavigated", (frame) => frame === tab.mainFrame()),
    )
    const resumes = tabs.map(async (tab) => {
      try {
        await tab.evaluate("window.dispatchEvent(new Event('pageshow'))")
      } catch (error) {
        // Either tab can trigger the coordinated reload before evaluate returns.
        // Both main-frame navigations and the new generation still must be observed.
        if (
          !(error instanceof Error) ||
          !error.message.includes("Execution context was destroyed")
        )
          throw error
      }
    })
    await Promise.all([...resumes, ...reloads])
  },
)

Then(
  "both tabs should reload onto one new reset generation",
  async ({ context, page, scenarioState }) => {
    const peer = context.pages().find((candidate) => candidate !== page)
    if (!peer) throw new Error("Peer Dashboard tab was not opened")
    const initialGeneration = scenarioState.get("rxdbLifecycleGeneration")
    if (typeof initialGeneration !== "number") {
      throw new Error("RxDB reset generation was not recorded")
    }

    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      peer.waitForLoadState("domcontentloaded"),
    ])
    await expect
      .poll(async () => [
        await readGeneration(page),
        await readGeneration(peer),
      ])
      .toEqual([initialGeneration + 1, initialGeneration + 1])
    await expect(
      page.getByRole("heading", { name: "Processes", exact: true }),
    ).toBeVisible({ timeout: 30_000 })
    await expect(
      peer.getByRole("heading", { name: "Processes", exact: true }),
    ).toBeVisible({ timeout: 30_000 })
    await peer.close()
  },
)
