import { describe, expect, test } from "vitest"
import {
  canInitializeCollectionForScope,
  shouldResetCollectionBinding,
  shouldResetCollectionScope,
} from "../lib/collections/collection-provider-scope"

describe("collection provider scope", () => {
  test("requires a reset when the active org scope changes", () => {
    expect(shouldResetCollectionScope("ou-demo", "ou-cloud-org")).toBe(true)
    expect(shouldResetCollectionScope("ou-demo", "ou-demo")).toBe(false)
    expect(shouldResetCollectionScope(null, "ou-cloud-org")).toBe(false)
  })

  test("requires a reset when the backing collection changes within the same org", () => {
    const activeCollection = {}

    expect(
      shouldResetCollectionBinding({
        activeCollection,
        activeScopeKey: "ou-demo",
        nextCollection: {},
        nextScopeKey: "ou-demo",
      }),
    ).toBe(true)

    expect(
      shouldResetCollectionBinding({
        activeCollection,
        activeScopeKey: "ou-demo",
        nextCollection: activeCollection,
        nextScopeKey: "ou-demo",
      }),
    ).toBe(false)
  })

  test("does not reset for a missing active or next collection unless the org changes", () => {
    expect(
      shouldResetCollectionBinding({
        activeCollection: null,
        activeScopeKey: "ou-demo",
        nextCollection: {},
        nextScopeKey: "ou-demo",
      }),
    ).toBe(false)

    expect(
      shouldResetCollectionBinding({
        activeCollection: {},
        activeScopeKey: "ou-demo",
        nextCollection: null,
        nextScopeKey: "ou-demo",
      }),
    ).toBe(false)

    expect(
      shouldResetCollectionBinding({
        activeCollection: {},
        activeScopeKey: "ou-demo",
        nextCollection: null,
        nextScopeKey: "ou-cloud-org",
      }),
    ).toBe(true)
  })

  test("blocks initialization when initialization is already in progress", () => {
    expect(
      canInitializeCollectionForScope({
        activeScopeKey: null,
        initializationInProgress: true,
        nextScopeKey: "ou-cloud-org",
        persistentStatus: "waiting-for-rxdb",
      }),
    ).toBe(false)
  })

  test("blocks initialization when persistent status is not waiting-for-rxdb", () => {
    expect(
      canInitializeCollectionForScope({
        activeScopeKey: null,
        initializationInProgress: false,
        nextScopeKey: "ou-cloud-org",
        persistentStatus: "initializing",
      }),
    ).toBe(false)

    expect(
      canInitializeCollectionForScope({
        activeScopeKey: null,
        initializationInProgress: false,
        nextScopeKey: "ou-cloud-org",
        persistentStatus: "ready",
      }),
    ).toBe(false)

    expect(
      canInitializeCollectionForScope({
        activeScopeKey: null,
        initializationInProgress: false,
        nextScopeKey: "ou-cloud-org",
        persistentStatus: "error",
      }),
    ).toBe(false)
  })

  test("blocks initialization when active scope differs from next scope", () => {
    expect(
      canInitializeCollectionForScope({
        activeScopeKey: "ou-demo",
        initializationInProgress: false,
        nextScopeKey: "ou-cloud-org",
        persistentStatus: "waiting-for-rxdb",
      }),
    ).toBe(false)
  })

  test("blocks initialization for the same scope when status is no longer waiting", () => {
    expect(
      canInitializeCollectionForScope({
        activeScopeKey: "ou-cloud-org",
        initializationInProgress: false,
        nextScopeKey: "ou-cloud-org",
        persistentStatus: "ready",
      }),
    ).toBe(false)
  })

  test("allows initialization when active scope matches next scope and waiting", () => {
    expect(
      canInitializeCollectionForScope({
        activeScopeKey: "ou-cloud-org",
        initializationInProgress: false,
        nextScopeKey: "ou-cloud-org",
        persistentStatus: "waiting-for-rxdb",
      }),
    ).toBe(true)
  })

  test("allows initialization when no active scope and waiting for rxdb", () => {
    expect(
      canInitializeCollectionForScope({
        activeScopeKey: null,
        initializationInProgress: false,
        nextScopeKey: "ou-cloud-org",
        persistentStatus: "waiting-for-rxdb",
      }),
    ).toBe(true)
  })
})
