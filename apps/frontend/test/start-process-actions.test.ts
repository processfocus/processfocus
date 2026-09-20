import { describe, expect, test } from "vitest"
import { getNoSchemaStartActionLabels } from "../app/(protected)/processes/lib/start-process-actions"

describe("getNoSchemaStartActionLabels", () => {
  test("uses confirmation-style labels for zero-field starts", () => {
    expect(getNoSchemaStartActionLabels(0)).toEqual({
      cancelLabel: "Cancel",
      submitLabel: "Start",
    })
  })

  test("keeps the existing labels when fields are present", () => {
    expect(getNoSchemaStartActionLabels(2)).toEqual({
      cancelLabel: "Discard",
      submitLabel: "Done",
    })
  })
})
