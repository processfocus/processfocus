import type { GraphQLClient } from "graphql-request"
import { describe, expect, test } from "vitest"
import {
  type AvailableList,
  applyListFilterToSearchParams,
  applyListPageToSearchParams,
  applyListSortToSearchParams,
  buildListQueryVariables,
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

  test("reads valid descending sort state from URL parameters", () => {
    expect(parseListSort("dueDate", "desc")).toEqual({
      field: "dueDate",
      direction: "DESC",
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
