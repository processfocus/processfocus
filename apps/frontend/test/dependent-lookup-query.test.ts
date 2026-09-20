import { describe, expect, test } from "vitest"
import { fetchDependentLookupSuggestions } from "../lib/graphql/dependent-lookup-query"

describe("fetchDependentLookupSuggestions", () => {
  test("returns suggestions from a dynamic dependent lookup query", async () => {
    const requests: Array<{
      document: string
      variables: Record<string, unknown> | undefined
    }> = []
    const client = {
      async request<TResponse>(
        document: string,
        variables?: Record<string, unknown>,
      ): Promise<TResponse> {
        requests.push({ document, variables })
        if (!document.includes("schoolClassLookup")) {
          return {} as TResponse
        }
        return {
          schoolClassLookup: [{ value: "class-1", label: "Class 1" }],
        } as TResponse
      },
    }

    const suggestions = await fetchDependentLookupSuggestions(
      client,
      "schoolClassLookup",
      { input: { filter: "cla", schoolId: "school-1" }, limit: 20 },
    )

    expect(suggestions).toEqual([{ value: "class-1", label: "Class 1" }])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.variables).toEqual({
      filter: "cla",
      schoolId: "school-1",
      limit: 20,
    })
  })

  test("omits optional limit when it is not provided", async () => {
    const requests: Array<{
      variables: Record<string, unknown> | undefined
    }> = []
    const client = {
      async request<TResponse>(
        _document: string,
        variables?: Record<string, unknown>,
      ): Promise<TResponse> {
        requests.push({ variables })
        return {
          filteredLookup: [{ value: "item-1", label: "Item 1" }],
        } as TResponse
      },
    }

    const suggestions = await fetchDependentLookupSuggestions(
      client,
      "filteredLookup",
      { input: { filter: "item", parentId: "parent-1" } },
    )

    expect(suggestions).toEqual([{ value: "item-1", label: "Item 1" }])
    expect(requests[0]?.variables).toEqual({
      filter: "item",
      parentId: "parent-1",
    })
  })

  test("supports lookups without dependency keys", async () => {
    const requests: Array<{
      variables: Record<string, unknown> | undefined
    }> = []
    const client = {
      async request<TResponse>(
        _document: string,
        variables?: Record<string, unknown>,
      ): Promise<TResponse> {
        requests.push({ variables })
        return {
          filteredLookup: [{ value: "item-1", label: "Item 1" }],
        } as TResponse
      },
    }

    const suggestions = await fetchDependentLookupSuggestions(
      client,
      "filteredLookup",
      { input: { filter: "item" } },
    )

    expect(suggestions).toEqual([{ value: "item-1", label: "Item 1" }])
    expect(requests[0]?.variables).toEqual({ filter: "item" })
  })

  test("rejects invalid dynamic GraphQL identifiers", async () => {
    const client = {
      async request<TResponse>(): Promise<TResponse> {
        throw new Error("request should not be sent")
      },
    }

    await expect(
      fetchDependentLookupSuggestions(client, "not valid", {
        input: { filter: "item" },
      }),
    ).rejects.toThrow("Dependent lookup query name")

    await expect(
      fetchDependentLookupSuggestions(client, "filteredLookup", {
        input: { filter: "item", "bad-key": "parent-1" },
      }),
    ).rejects.toThrow("Dependent lookup input key")
  })

  test("rejects input keys reserved for lookup request variables", async () => {
    const client = {
      async request<TResponse>(): Promise<TResponse> {
        throw new Error("request should not be sent")
      },
    }

    await expect(
      fetchDependentLookupSuggestions(client, "filteredLookup", {
        input: { filter: "item", limit: "20" },
      }),
    ).rejects.toThrow("reserved")
  })

  test("rejects missing dependent lookup input", async () => {
    const client = {
      async request<TResponse>(): Promise<TResponse> {
        throw new Error("request should not be sent")
      },
    }

    await expect(
      fetchDependentLookupSuggestions(client, "filteredLookup", {}),
    ).rejects.toThrow("Dependent lookup input")

    await expect(
      fetchDependentLookupSuggestions(client, "filteredLookup", { input: {} }),
    ).rejects.toThrow("Dependent lookup input")
  })
})
