import { Effect } from "effect"
import { AuthorizedPageTimeoutError } from "@pf/graphql-schema"
import {
  type PaginatedCollectionResult,
  type PaginationWindow,
  buildPaginatedCollectionPayload,
  clampPaginationWindow,
  createPaginatedCollectionResolver,
  queryAuthorizedPage,
} from "../src/lib/collection-resolvers"
import { describe, expect, it } from "bun:test"

describe("collection-resolvers", () => {
  describe("queryAuthorizedPage", () => {
    it("returns a dense authorized page with one-row lookahead", async () => {
      const rows = Array.from({ length: 12 }, (_, index) => index)

      const result = await Effect.runPromise(
        queryAuthorizedPage({
          pagination: { page: 2, limit: 2 },
          queryRows: ({ offset, limit }) =>
            Effect.succeed(rows.slice(offset, offset + limit)),
          authorizeRows: (pageRows) =>
            Effect.succeed(pageRows.filter((row) => row % 2 === 0)),
        }),
      )

      expect(result).toEqual({
        nodes: [4, 6],
        page: 2,
        limit: 2,
        hasNextPage: true,
      })
    })

    it("can page beyond 10,000 authorized rows", async () => {
      const rows = Array.from({ length: 10_102 }, (_, index) => index)
      const result = await Effect.runPromise(
        queryAuthorizedPage({
          pagination: { page: 101, limit: 100 },
          queryRows: ({ offset, limit }) =>
            Effect.succeed(rows.slice(offset, offset + limit)),
          authorizeRows: (pageRows) => Effect.succeed(pageRows),
        }),
      )

      expect(result.nodes).toEqual(
        Array.from({ length: 100 }, (_, index) => 10_000 + index),
      )
      expect(result.hasNextPage).toBe(true)
    })

    it("bounds the time spent finding an authorized page", async () => {
      const deniedRows = Array.from({ length: 100 }, (_, index) => index)
      const error = await Effect.runPromise(
        queryAuthorizedPage({
          pagination: { page: 1, limit: 100 },
          timeBudget: "10 millis",
          queryRows: () => Effect.succeed(deniedRows),
          authorizeRows: () => Effect.succeed([]),
        }).pipe(Effect.flip),
      )

      expect(error).toBeInstanceOf(AuthorizedPageTimeoutError)
      expect(error).toMatchObject({
        page: 1,
        limit: 100,
      })
    })
  })

  describe("clampPaginationWindow", () => {
    it("should use provided page and limit when valid", () => {
      const result = clampPaginationWindow({ page: 5, limit: 20 })
      expect(result).toEqual({ page: 5, limit: 20 })
    })

    it("should clamp page to minimum of 1", () => {
      expect(clampPaginationWindow({ page: 0, limit: 20 })).toEqual({
        page: 1,
        limit: 20,
      })
      expect(clampPaginationWindow({ page: -5, limit: 20 })).toEqual({
        page: 1,
        limit: 20,
      })
    })

    it("should clamp limit to minimum of 1", () => {
      expect(clampPaginationWindow({ page: 1, limit: 0 })).toEqual({
        page: 1,
        limit: 1,
      })
      expect(clampPaginationWindow({ page: 1, limit: -10 })).toEqual({
        page: 1,
        limit: 1,
      })
    })

    it("should clamp limit to MAX_PAGE_SIZE (100)", () => {
      expect(clampPaginationWindow({ page: 1, limit: 200 })).toEqual({
        page: 1,
        limit: 100,
      })
      expect(clampPaginationWindow({ page: 1, limit: 1000 })).toEqual({
        page: 1,
        limit: 100,
      })
    })

    it("should handle edge case of page=1, limit=1", () => {
      expect(clampPaginationWindow({ page: 1, limit: 1 })).toEqual({
        page: 1,
        limit: 1,
      })
    })
  })

  describe("buildPaginatedCollectionPayload", () => {
    it("should build payload with correct pagination info", () => {
      const pagination: PaginationWindow = { page: 2, limit: 20 }
      const result: PaginatedCollectionResult<string> = {
        items: ["a", "b", "c"],
        totalCount: 50,
      }

      const payload = buildPaginatedCollectionPayload(pagination, result)

      expect(payload).toEqual({
        items: ["a", "b", "c"],
        totalCount: 50,
        page: 2,
        limit: 20,
        hasNextPage: true, // 2 * 20 = 40 < 50
      })
    })

    it("should calculate hasNextPage correctly on last page", () => {
      const pagination: PaginationWindow = { page: 3, limit: 20 }
      const result: PaginatedCollectionResult<string> = {
        items: ["x", "y"],
        totalCount: 50,
      }

      const payload = buildPaginatedCollectionPayload(pagination, result)

      expect(payload.hasNextPage).toBe(false) // 3 * 20 = 60 > 50
    })

    it("should calculate hasNextPage correctly on exact boundary", () => {
      const pagination: PaginationWindow = { page: 3, limit: 20 }
      const result: PaginatedCollectionResult<string> = {
        items: [],
        totalCount: 60,
      }

      const payload = buildPaginatedCollectionPayload(pagination, result)

      expect(payload.hasNextPage).toBe(false) // 3 * 20 = 60, not < 60
    })

    it("should handle empty result", () => {
      const pagination: PaginationWindow = { page: 1, limit: 20 }
      const result: PaginatedCollectionResult<string> = {
        items: [],
        totalCount: 0,
      }

      const payload = buildPaginatedCollectionPayload(pagination, result)

      expect(payload).toEqual({
        items: [],
        totalCount: 0,
        page: 1,
        limit: 20,
        hasNextPage: false,
      })
    })

    it("should handle single item", () => {
      const pagination: PaginationWindow = { page: 1, limit: 20 }
      const result: PaginatedCollectionResult<string> = {
        items: ["single"],
        totalCount: 1,
      }

      const payload = buildPaginatedCollectionPayload(pagination, result)

      expect(payload.hasNextPage).toBe(false)
    })
  })

  describe("createPaginatedCollectionResolver", () => {
    it("should resolve and return paginated payload", async () => {
      const mockResolve = (
        _args: { page: number; limit: number },
        pagination: PaginationWindow,
      ) =>
        Effect.succeed({
          items: [`item-${pagination.page}`],
          totalCount: 100,
        })

      const resolver = createPaginatedCollectionResolver(mockResolve)

      const result = await Effect.runPromise(
        resolver(
          null as unknown as Record<string, unknown>,
          { page: 5, limit: 10 },
          null as unknown as Parameters<typeof resolver>[2],
          null as unknown as Parameters<typeof resolver>[3],
        ),
      )

      expect(result).toEqual({
        items: ["item-5"],
        totalCount: 100,
        page: 5,
        limit: 10,
        hasNextPage: true, // 5 * 10 = 50 < 100
      })
    })

    it("should clamp invalid pagination args before calling resolve", async () => {
      const mockResolve = (
        _args: { page: number; limit: number },
        pagination: PaginationWindow,
      ) =>
        Effect.succeed({
          items: [`page-${pagination.page}-limit-${pagination.limit}`],
          totalCount: 1000,
        })

      const resolver = createPaginatedCollectionResolver(mockResolve)

      const result = await Effect.runPromise(
        resolver(
          null as unknown as Record<string, unknown>,
          { page: -5, limit: 500 }, // Invalid args
          null as unknown as Parameters<typeof resolver>[2],
          null as unknown as Parameters<typeof resolver>[3],
        ),
      )

      // Should be clamped to page=1, limit=100
      expect(result.items[0]).toBe("page-1-limit-100")
      expect(result.page).toBe(1)
      expect(result.limit).toBe(100)
    })
  })
})
