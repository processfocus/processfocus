import { buildSchema, graphql as executeGraphql } from "graphql"
import { GraphQLClient } from "graphql-request"
import { describe, expect, test } from "vitest"
import {
  type AvailableList,
  applyListFilterToSearchParams,
  applyListPageToSearchParams,
  applyListSortToSearchParams,
  buildListQueryVariables,
  fetchFreshListData,
  fetchListData,
  parseListPageNumber,
  parseListPageSize,
  parseListSort,
} from "../lib/graphql/list-queries"

const testList: AvailableList = {
  id: "list-1",
  path: "/things",
  name: "Things",
  detailName: null,
  purpose: null,
  queryName: "allThings",
  outputColumns: [
    {
      field: "id",
      label: "ID",
      description: null,
      visibleInList: true,
      sortable: true,
    },
  ],
  itemQueryName: null,
  updateMutationName: null,
  updateInputTypeName: null,
  deleteMutationName: null,
  editableColumns: [],
}

describe("list URL sort state", () => {
  test("reads valid ascending sort state from URL parameters", () => {
    expect(parseListSort("dueDate", "asc")).toEqual({
      field: "dueDate",
      direction: "ASC",
    })
  })

  test("ignores invalid or incomplete sort URL state", () => {
    expect(parseListSort(null, "asc")).toBeNull()
    expect(parseListSort("", "asc")).toBeNull()
    expect(parseListSort("dueDate", "up")).toBeNull()
    expect(parseListSort("dueDate", "ASC")).toBeNull()
    expect(parseListSort("due-date", "asc")).toBeNull()
  })

  test("maps parsed sort state into GraphQL list variables", () => {
    const sort = parseListSort("dueDate", "desc")

    expect(
      buildListQueryVariables({
        page: 2,
        limit: 50,
        filter: "urgent",
        sort,
      }),
    ).toEqual({
      page: 2,
      limit: 50,
      filter: "urgent",
      sort: { field: "dueDate", direction: "DESC" },
    })
  })

  test("sends null filter and omits sort for empty or invalid URL state", () => {
    expect(
      buildListQueryVariables({
        page: 1,
        limit: 20,
        filter: "",
        sort: parseListSort("dueDate", "up"),
      }),
    ).toEqual({
      page: 1,
      limit: 20,
      filter: null,
    })
  })

  test("normalizes list page size from URL state", () => {
    expect(parseListPageSize(undefined, 20)).toBe(20)
    expect(parseListPageSize("not-a-number", 20)).toBe(20)
    expect(parseListPageSize("-5", 20)).toBe(20)
    expect(parseListPageSize("0", 20)).toBe(20)
    expect(parseListPageSize("50", 20)).toBe(50)
    expect(parseListPageSize("100000", 20)).toBe(100)
  })

  test("normalizes list page number from URL state", () => {
    expect(parseListPageNumber(undefined, 1)).toBe(1)
    expect(parseListPageNumber("not-a-number", 1)).toBe(1)
    expect(parseListPageNumber("-5", 1)).toBe(1)
    expect(parseListPageNumber("0", 1)).toBe(1)
    expect(parseListPageNumber("7", 1)).toBe(7)
  })

  test("ignores sort URL state without a direction", () => {
    expect(parseListSort("dueDate", null)).toBeNull()
  })

  test("filter changes reset page while preserving sort state", () => {
    const search = new URLSearchParams(
      "page=4&limit=50&filter=old&sort=dueDate&dir=desc",
    )

    expect(applyListFilterToSearchParams(search, "new")).toBe(
      "page=1&limit=50&filter=new&sort=dueDate&dir=desc",
    )
  })

  test("pagination changes preserve filter and sort state", () => {
    const search = new URLSearchParams(
      "page=1&limit=50&filter=urgent&sort=dueDate&dir=asc",
    )

    expect(applyListPageToSearchParams(search, 3)).toBe(
      "page=3&limit=50&filter=urgent&sort=dueDate&dir=asc",
    )
  })

  test("pagination changes clamp invalid page numbers", () => {
    const search = new URLSearchParams("page=3&limit=50")

    expect(applyListPageToSearchParams(search, 0)).toBe("page=1&limit=50")
  })

  test("sort changes cycle default list order to ascending to descending to default", () => {
    const ascending = applyListSortToSearchParams(
      new URLSearchParams("page=4&limit=50&filter=urgent"),
      "dueDate",
    )
    expect(ascending).toBe("page=1&limit=50&filter=urgent&sort=dueDate&dir=asc")

    const descending = applyListSortToSearchParams(
      new URLSearchParams(ascending),
      "dueDate",
    )
    expect(descending).toBe(
      "page=1&limit=50&filter=urgent&sort=dueDate&dir=desc",
    )

    const defaultOrder = applyListSortToSearchParams(
      new URLSearchParams(descending),
      "dueDate",
    )
    expect(defaultOrder).toBe("page=1&limit=50&filter=urgent")
  })

  test("sort changes preserve filter and reset page to one", () => {
    const search = new URLSearchParams(
      "page=7&limit=25&filter=blocked&sort=priority&dir=desc",
    )

    expect(applyListSortToSearchParams(search, "dueDate")).toBe(
      "page=1&limit=25&filter=blocked&sort=dueDate&dir=asc",
    )
  })

  test("sort changes ignore invalid field names", () => {
    const search = new URLSearchParams("page=7&limit=25&filter=blocked")

    expect(applyListSortToSearchParams(search, "due-date")).toBe(
      "page=7&limit=25&filter=blocked",
    )
  })

  test("refreshes rows and totals with a valid page in one GraphQL operation after deletion", async () => {
    const schema = buildSchema(`
      enum SortDirection { ASC DESC }
      input ListSortInput { field: String!, direction: SortDirection! }
      type Item { id: String! }
      type Page { items: [Item!]!, totalCount: Int!, page: Int!, limit: Int!, hasNextPage: Boolean! }
      type Query { allThings(page: Int!, limit: Int!, filter: String, sort: ListSortInput): Page! }
    `)
    let requests = 0
    const client = new GraphQLClient("http://list.test/graphql", {
      fetch: async (input, init) => {
        requests++
        const body: { query: string; variables: Record<string, unknown> } =
          await new Request(input, init).json()
        return Response.json(
          await executeGraphql({
            schema,
            source: body.query,
            variableValues: body.variables,
            rootValue: {
              allThings: ({
                page,
                limit,
                filter,
                sort,
              }: {
                page: number
                limit: number
                filter: string
                sort: { field: string; direction: string }
              }) => {
                expect(filter).toBe("mine")
                expect(sort).toEqual({ field: "id", direction: "DESC" })
                const remaining = [{ id: "2" }, { id: "1" }]
                return {
                  items: remaining.slice((page - 1) * limit, page * limit),
                  totalCount: 2,
                  page,
                  limit,
                  hasNextPage: page * limit < 2,
                }
              },
            },
          }),
        )
      },
    })
    const query = {
      page: 3,
      limit: 1,
      filter: "mine",
      sort: { field: "id", direction: "DESC" as const },
    }
    expect(await fetchFreshListData(client, testList, query)).toEqual({
      items: [{ id: "2" }],
      totalCount: 2,
      page: 1,
      limit: 1,
      hasNextPage: true,
    })
    expect(requests).toBe(1)
    expect(
      await fetchFreshListData(client, testList, { ...query, page: 2 }),
    ).toEqual({
      items: [{ id: "1" }],
      totalCount: 2,
      page: 2,
      limit: 1,
      hasNextPage: false,
    })
    expect(requests).toBe(2)
  })

  test("fetchListData validates dynamic GraphQL names", async () => {
    const client = {
      request: async () => ({
        allThings: {
          items: [{ id: "thing-1" }],
          totalCount: 1,
          page: 1,
          limit: 20,
          hasNextPage: false,
        },
      }),
    } as unknown as GraphQLClient

    await expect(
      fetchListData(client, testList, {
        page: 1,
        limit: 20,
        filter: null,
      }),
    ).resolves.toEqual({
      items: [{ id: "thing-1" }],
      totalCount: 1,
      page: 1,
      limit: 20,
      hasNextPage: false,
    })

    await expect(
      fetchListData(
        client,
        { ...testList, queryName: "all-things" },
        { page: 1, limit: 20, filter: null },
      ),
    ).rejects.toThrow("Invalid GraphQL query name")

    await expect(
      fetchListData(
        client,
        {
          ...testList,
          outputColumns: [{ ...testList.outputColumns[0], field: "bad-field" }],
        },
        { page: 1, limit: 20, filter: null },
      ),
    ).rejects.toThrow("Invalid GraphQL field name")
  })
})
