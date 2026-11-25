import { Result, Schema, SchemaAST } from "effect"
import { FormAutoComplete, FormLabel } from "./form-annotations"
import { Phone, PhoneField } from "./phone"
import { describe, expect, it } from "bun:test"

describe("Phone schema", () => {
  const decode = Schema.decodeUnknownResult(Phone)

  describe("valid phone numbers", () => {
    it("accepts numbers with country code", () => {
      expect(Result.isSuccess(decode("+14155551234"))).toBe(true)
      expect(Result.isSuccess(decode("+1 415 555 1234"))).toBe(true)
      expect(Result.isSuccess(decode("+447911123456"))).toBe(true)
      expect(Result.isSuccess(decode("+49 151 12345678"))).toBe(true)
    })

    it("accepts formatted numbers with parentheses and dashes", () => {
      expect(Result.isSuccess(decode("(415) 555-1234"))).toBe(true)
      expect(Result.isSuccess(decode("+1 (415) 555-1234"))).toBe(true)
      expect(Result.isSuccess(decode("+1-415-555-1234"))).toBe(true)
      expect(Result.isSuccess(decode("+61 (2) 9876 5432"))).toBe(true)
    })

    it("accepts numbers with varying spacing", () => {
      expect(Result.isSuccess(decode("4155551234"))).toBe(true)
      expect(Result.isSuccess(decode("415 555 1234"))).toBe(true)
      expect(Result.isSuccess(decode("415-555-1234"))).toBe(true)
    })

    it("accepts international formats", () => {
      expect(Result.isSuccess(decode("+4915112345678"))).toBe(true)
      expect(Result.isSuccess(decode("+86 138 1234 5678"))).toBe(true)
      expect(Result.isSuccess(decode("+81 90 1234 5678"))).toBe(true)
      expect(Result.isSuccess(decode("+61 412 345 678"))).toBe(true)
    })

    it("accepts minimum length (7 digits)", () => {
      expect(Result.isSuccess(decode("1234567"))).toBe(true)
      expect(Result.isSuccess(decode("+1 234 567"))).toBe(true)
    })

    it("accepts maximum length (15 digits)", () => {
      expect(Result.isSuccess(decode("+123456789012345"))).toBe(true)
      expect(Result.isSuccess(decode("123456789012345"))).toBe(true)
    })
  })

  describe("trimming behavior", () => {
    it("trims leading whitespace", () => {
      const result = decode("  +1 415 555 1234")
      expect(Result.isSuccess(result)).toBe(true)
      if (Result.isSuccess(result)) {
        expect(result.success).toBe("+1 415 555 1234")
      }
    })

    it("trims trailing whitespace", () => {
      const result = decode("+1 415 555 1234  ")
      expect(Result.isSuccess(result)).toBe(true)
      if (Result.isSuccess(result)) {
        expect(result.success).toBe("+1 415 555 1234")
      }
    })

    it("trims both leading and trailing whitespace", () => {
      const result = decode("  +1 415 555 1234  ")
      expect(Result.isSuccess(result)).toBe(true)
      if (Result.isSuccess(result)) {
        expect(result.success).toBe("+1 415 555 1234")
      }
    })
  })

  describe("invalid phone numbers", () => {
    it("rejects empty string", () => {
      expect(Result.isFailure(decode(""))).toBe(true)
    })

    it("rejects whitespace only", () => {
      expect(Result.isFailure(decode("   "))).toBe(true)
    })

    it("rejects too short numbers (less than 7 digits)", () => {
      expect(Result.isFailure(decode("123"))).toBe(true)
      expect(Result.isFailure(decode("123456"))).toBe(true)
      expect(Result.isFailure(decode("+1 1"))).toBe(true)
    })

    it("rejects too long numbers (more than 15 digits)", () => {
      expect(Result.isFailure(decode("+1234567890123456"))).toBe(true)
      expect(Result.isFailure(decode("1234567890123456"))).toBe(true)
    })

    it("rejects plain text", () => {
      expect(Result.isFailure(decode("not a phone"))).toBe(true)
      expect(Result.isFailure(decode("call me"))).toBe(true)
    })

    it("rejects email addresses", () => {
      expect(Result.isFailure(decode("user@example.com"))).toBe(true)
    })

    it("rejects special characters not in valid positions", () => {
      expect(Result.isFailure(decode("555@123@4567"))).toBe(true)
      expect(Result.isFailure(decode("555#123"))).toBe(true)
      expect(Result.isFailure(decode("555.123.4567"))).toBe(true)
    })

    it("rejects plus sign not at start", () => {
      expect(Result.isFailure(decode("555+123"))).toBe(true)
      expect(Result.isFailure(decode("1+234567"))).toBe(true)
      expect(Result.isFailure(decode("++1234567890"))).toBe(true)
    })

    it("provides helpful error message", () => {
      const result = decode("123")
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        const message = result.failure.message
        expect(message).toContain("must be a valid phone number")
      }
    })
  })

  describe("schema annotations", () => {
    it("has correct identifier", () => {
      expect(SchemaAST.resolveIdentifier(Phone.ast)).toBe("Phone")
    })

    it("has correct title", () => {
      expect(SchemaAST.resolveTitle(Phone.ast)).toBe("Phone number")
    })

    it("has correct description", () => {
      expect(SchemaAST.resolveDescription(Phone.ast)).toBe(
        "A valid phone number",
      )
    })
  })

  describe("usage in struct", () => {
    it("works as a field in a struct schema", () => {
      const FormSchema = Schema.Struct({
        phone: Phone,
        name: Schema.String,
      })

      const decode = Schema.decodeUnknownResult(FormSchema)

      const validResult = decode({ phone: "+1 415 555 1234", name: "John" })
      expect(Result.isSuccess(validResult)).toBe(true)

      const invalidResult = decode({ phone: "invalid", name: "John" })
      expect(Result.isFailure(invalidResult)).toBe(true)
    })

    it("supports PhoneField helper annotations", () => {
      const field = PhoneField({ label: "Phone number" })

      expect(Reflect.get(SchemaAST.resolve(field.ast) ?? {}, FormLabel)).toBe(
        "Phone number",
      )
      expect(
        Reflect.get(SchemaAST.resolve(field.ast) ?? {}, FormAutoComplete),
      ).toBe("tel")
      expect(
        Result.isSuccess(Schema.decodeUnknownResult(field)("+1 415 555 1234")),
      ).toBe(true)
    })
  })
})
