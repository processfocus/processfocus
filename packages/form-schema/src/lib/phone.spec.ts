import { Either, Schema, SchemaAST } from "effect"
import { FormAutoComplete, FormLabel } from "./form-annotations"
import { Phone, PhoneField } from "./phone"
import { describe, expect, it } from "bun:test"

describe("Phone schema", () => {
  const decode = Schema.decodeUnknownEither(Phone)

  describe("valid phone numbers", () => {
    it("accepts numbers with country code", () => {
      expect(Either.isRight(decode("+14155551234"))).toBe(true)
      expect(Either.isRight(decode("+1 415 555 1234"))).toBe(true)
      expect(Either.isRight(decode("+447911123456"))).toBe(true)
      expect(Either.isRight(decode("+49 151 12345678"))).toBe(true)
    })

    it("accepts formatted numbers with parentheses and dashes", () => {
      expect(Either.isRight(decode("(415) 555-1234"))).toBe(true)
      expect(Either.isRight(decode("+1 (415) 555-1234"))).toBe(true)
      expect(Either.isRight(decode("+1-415-555-1234"))).toBe(true)
      expect(Either.isRight(decode("+61 (2) 9876 5432"))).toBe(true)
    })

    it("accepts numbers with varying spacing", () => {
      expect(Either.isRight(decode("4155551234"))).toBe(true)
      expect(Either.isRight(decode("415 555 1234"))).toBe(true)
      expect(Either.isRight(decode("415-555-1234"))).toBe(true)
    })

    it("accepts international formats", () => {
      expect(Either.isRight(decode("+4915112345678"))).toBe(true)
      expect(Either.isRight(decode("+86 138 1234 5678"))).toBe(true)
      expect(Either.isRight(decode("+81 90 1234 5678"))).toBe(true)
      expect(Either.isRight(decode("+61 412 345 678"))).toBe(true)
    })

    it("accepts minimum length (7 digits)", () => {
      expect(Either.isRight(decode("1234567"))).toBe(true)
      expect(Either.isRight(decode("+1 234 567"))).toBe(true)
    })

    it("accepts maximum length (15 digits)", () => {
      expect(Either.isRight(decode("+123456789012345"))).toBe(true)
      expect(Either.isRight(decode("123456789012345"))).toBe(true)
    })
  })

  describe("trimming behavior", () => {
    it("trims leading whitespace", () => {
      const result = decode("  +1 415 555 1234")
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right).toBe("+1 415 555 1234")
      }
    })

    it("trims trailing whitespace", () => {
      const result = decode("+1 415 555 1234  ")
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right).toBe("+1 415 555 1234")
      }
    })

    it("trims both leading and trailing whitespace", () => {
      const result = decode("  +1 415 555 1234  ")
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right).toBe("+1 415 555 1234")
      }
    })
  })

  describe("invalid phone numbers", () => {
    it("rejects empty string", () => {
      expect(Either.isLeft(decode(""))).toBe(true)
    })

    it("rejects whitespace only", () => {
      expect(Either.isLeft(decode("   "))).toBe(true)
    })

    it("rejects too short numbers (less than 7 digits)", () => {
      expect(Either.isLeft(decode("123"))).toBe(true)
      expect(Either.isLeft(decode("123456"))).toBe(true)
      expect(Either.isLeft(decode("+1 1"))).toBe(true)
    })

    it("rejects too long numbers (more than 15 digits)", () => {
      expect(Either.isLeft(decode("+1234567890123456"))).toBe(true)
      expect(Either.isLeft(decode("1234567890123456"))).toBe(true)
    })

    it("rejects plain text", () => {
      expect(Either.isLeft(decode("not a phone"))).toBe(true)
      expect(Either.isLeft(decode("call me"))).toBe(true)
    })

    it("rejects email addresses", () => {
      expect(Either.isLeft(decode("user@example.com"))).toBe(true)
    })

    it("rejects special characters not in valid positions", () => {
      expect(Either.isLeft(decode("555@123@4567"))).toBe(true)
      expect(Either.isLeft(decode("555#123"))).toBe(true)
      expect(Either.isLeft(decode("555.123.4567"))).toBe(true)
    })

    it("rejects plus sign not at start", () => {
      expect(Either.isLeft(decode("555+123"))).toBe(true)
      expect(Either.isLeft(decode("1+234567"))).toBe(true)
      expect(Either.isLeft(decode("++1234567890"))).toBe(true)
    })

    it("provides helpful error message", () => {
      const result = decode("123")
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        const message = result.left.message
        expect(message).toContain("must be a valid phone number")
      }
    })
  })

  describe("schema annotations", () => {
    it("has correct identifier", () => {
      expect(Phone.ast.annotations[SchemaAST.IdentifierAnnotationId]).toBe(
        "Phone",
      )
    })

    it("has correct title", () => {
      expect(Phone.ast.annotations[SchemaAST.TitleAnnotationId]).toBe(
        "Phone number",
      )
    })

    it("has correct description", () => {
      expect(Phone.ast.annotations[SchemaAST.DescriptionAnnotationId]).toBe(
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

      const decode = Schema.decodeUnknownEither(FormSchema)

      const validResult = decode({ phone: "+1 415 555 1234", name: "John" })
      expect(Either.isRight(validResult)).toBe(true)

      const invalidResult = decode({ phone: "invalid", name: "John" })
      expect(Either.isLeft(invalidResult)).toBe(true)
    })

    it("supports PhoneField helper annotations", () => {
      const field = PhoneField({ label: "Phone number" })

      expect(field.ast.annotations[FormLabel]).toBe("Phone number")
      expect(field.ast.annotations[FormAutoComplete]).toBe("tel")
      expect(
        Either.isRight(Schema.decodeUnknownEither(field)("+1 415 555 1234")),
      ).toBe(true)
    })
  })
})
