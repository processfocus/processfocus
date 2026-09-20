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

const readDraftStorageKeys = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    Object.keys(localStorage).filter(
      (key) =>
        key.startsWith("RxDB-ls-doc-") &&
        key.includes("--draftProcessExecution--") &&
        key.includes("-pst-"),
    ),
  )

When(
  "I save the process form as a server-side draft",
  async ({ page, scenarioState }) => {
    const draftKeysBeforeSave = await readDraftStorageKeys(page)
    const pushResponsePromise = page.waitForResponse(isDraftPushResponse)
    await page.getByRole("button", { name: "Save draft" }).click()
    const pushResponse = await pushResponsePromise
    expect(pushResponse.ok()).toBe(true)

    await expect
      .poll(
        async () => {
          const currentKeys = await readDraftStorageKeys(page)
          return currentKeys.some((key) => !draftKeysBeforeSave.includes(key))
        },
        { message: "Waiting for the new draft document in RxDB" },
      )
      .toBe(true)
    const draftStorageKey = (await readDraftStorageKeys(page)).find(
      (key) => !draftKeysBeforeSave.includes(key),
    )
    if (!draftStorageKey)
      throw new Error("New RxDB draft document was not found")
    const draftIdStart = draftStorageKey.lastIndexOf("-pst-") + 1
    const draftId = draftStorageKey.slice(draftIdStart)
    scenarioState.set("rxdbLifecycleDraftId", draftId)

    await expect
      .poll(
        () =>
          page.evaluate(
            (id) =>
              Object.keys(localStorage).some(
                (key) =>
                  key.includes("--draftProcessExecution--") &&
                  key.endsWith(`-${id}`),
              ),
            draftId,
          ),
        { message: "Waiting for the server-side draft to persist in RxDB" },
      )
      .toBe(true)

    await page.goto("/processes", { waitUntil: "domcontentloaded" })
    await expect(
      page.getByRole("link", { name: "Continue" }).first(),
    ).toBeVisible({ timeout: 15_000 })
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
  "the server-side draft should be pulled into the fresh database",
  async ({ page, scenarioState }) => {
    const draftId = scenarioState.get("rxdbLifecycleDraftId")
    if (typeof draftId !== "string") {
      throw new Error("Server-side draft id was not recorded")
    }
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) =>
              Object.keys(localStorage).some(
                (key) =>
                  key.includes("--draftProcessExecution--") &&
                  key.endsWith(`-${id}`) &&
                  localStorage.getItem(key) !== null,
              ),
            draftId,
          ),
        { message: "Waiting for the server-side draft to be pulled" },
      )
      .toBe(true)
    await expect(
      page.getByRole("link", { name: "Continue" }).first(),
    ).toBeVisible({ timeout: 15_000 })
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

    const pageReloaded = page.waitForEvent(
      "framenavigated",
      (frame) => frame === page.mainFrame(),
    )
    const peerReloaded = peer.waitForEvent(
      "framenavigated",
      (frame) => frame === peer.mainFrame(),
    )
    await Promise.all([
      page.evaluate("window.dispatchEvent(new Event('pageshow'))"),
      peer.evaluate("window.dispatchEvent(new Event('pageshow'))"),
    ])
    await Promise.all([pageReloaded, peerReloaded])
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
