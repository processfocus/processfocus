import { describe, expect, test } from "vitest"
import { listDetailTitle } from "../app/(protected)/lists/lib/list-detail-title"

describe("listDetailTitle", () => {
  test("uses explicit detail title when present", () => {
    expect(
      listDetailTitle({
        name: "All enrolment enquiries",
        detailName: "Enrolment enquiry",
      }),
    ).toBe("Enrolment enquiry")
  })

  test("falls back from all enquiries list names to a singular detail title", () => {
    expect(listDetailTitle({ name: "All enrolment enquiries" })).toBe(
      "Enrolment enquiry",
    )
  })

  test("ignores blank explicit detail titles", () => {
    expect(
      listDetailTitle({
        name: "All enrolment enquiries",
        detailName: "  ",
      }),
    ).toBe("Enrolment enquiry")
  })

  test("keeps names without generic all-enquiries wording", () => {
    expect(listDetailTitle({ name: "Key Register" })).toBe("Key Register")
  })

  test("returns undefined until list metadata has loaded", () => {
    expect(listDetailTitle(null)).toBeUndefined()
  })
})
