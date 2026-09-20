import { Either, Schema, SchemaAST } from "effect"
import { Email, EmailField } from "./email"
import { FormAutoComplete, FormLabel } from "./form-annotations"
import { describe, expect, it } from "bun:test"

describe("Email schema", () => {
  const decode = Schema.decodeUnknownEither(Email)

  describe("valid emails", () => {
    it("accepts standard email format", () => {
      expect(Either.isRight(decode("user@example.com"))).toBe(true)
      expect(Either.isRight(decode("john.doe@company.org"))).toBe(true)
      expect(Either.isRight(decode("test+tag@gmail.com"))).toBe(true)
    })

    it("accepts emails with subdomains", () => {
      expect(Either.isRight(decode("user@mail.example.com"))).toBe(true)
      expect(Either.isRight(decode("admin@sub.domain.org"))).toBe(true)
    })

    it("accepts emails with numeric local parts", () => {
      expect(Either.isRight(decode("123@example.com"))).toBe(true)
      expect(Either.isRight(decode("user123@example.com"))).toBe(true)
    })

    it("accepts emails with special characters in local part", () => {
      expect(Either.isRight(decode("user.name@example.com"))).toBe(true)
      expect(Either.isRight(decode("user_name@example.com"))).toBe(true)
      expect(Either.isRight(decode("user-name@example.com"))).toBe(true)
    })
  })

  describe("localhost and development emails", () => {
    it("accepts localhost emails (require_tld: false)", () => {
      expect(Either.isRight(decode("user@localhost"))).toBe(true)
      expect(Either.isRight(decode("admin@localhost"))).toBe(true)
    })

    it("accepts IP domain emails (allow_ip_domain: true)", () => {
      expect(Either.isRight(decode("user@[127.0.0.1]"))).toBe(true)
      expect(Either.isRight(decode("user@[192.168.1.1]"))).toBe(true)
    })
  })

  describe("UTF-8 and IDN support", () => {
    it("accepts UTF-8 local parts (allow_utf8_local_part: true)", () => {
      expect(Either.isRight(decode("üñîcödé@example.com"))).toBe(true)
      expect(Either.isRight(decode("用户@example.com"))).toBe(true)
      expect(Either.isRight(decode("пользователь@example.com"))).toBe(true)
    })

    it("accepts IDN/punycode domains", () => {
      expect(Either.isRight(decode("user@日本語.jp"))).toBe(true)
      expect(Either.isRight(decode("user@例え.jp"))).toBe(true)
      expect(Either.isRight(decode("user@münchen.de"))).toBe(true)
    })
  })

  describe("trimming behavior", () => {
    it("trims leading whitespace", () => {
      const result = decode("  user@example.com")
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right).toBe("user@example.com")
      }
    })

    it("trims trailing whitespace", () => {
      const result = decode("user@example.com  ")
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right).toBe("user@example.com")
      }
    })

    it("trims both leading and trailing whitespace", () => {
      const result = decode("  user@example.com  ")
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right).toBe("user@example.com")
      }
    })
  })

  describe("invalid emails", () => {
    it("rejects empty string", () => {
      expect(Either.isLeft(decode(""))).toBe(true)
    })

    it("rejects whitespace only", () => {
      expect(Either.isLeft(decode("   "))).toBe(true)
    })

    it("rejects missing @ symbol", () => {
      expect(Either.isLeft(decode("userexample.com"))).toBe(true)
    })

    it("rejects missing local part", () => {
      expect(Either.isLeft(decode("@example.com"))).toBe(true)
    })

    it("rejects missing domain", () => {
      expect(Either.isLeft(decode("user@"))).toBe(true)
    })

    it("rejects multiple @ symbols", () => {
      expect(Either.isLeft(decode("user@@example.com"))).toBe(true)
      expect(Either.isLeft(decode("user@domain@example.com"))).toBe(true)
    })

    it("rejects spaces in the middle", () => {
      expect(Either.isLeft(decode("user @example.com"))).toBe(true)
      expect(Either.isLeft(decode("user@ example.com"))).toBe(true)
      expect(Either.isLeft(decode("us er@example.com"))).toBe(true)
    })

    it("rejects invalid domain formats", () => {
      expect(Either.isLeft(decode("user@.com"))).toBe(true)
      expect(Either.isLeft(decode("user@example."))).toBe(true)
      expect(Either.isLeft(decode("user@-example.com"))).toBe(true)
    })

    it("rejects plain text", () => {
      expect(Either.isLeft(decode("not an email"))).toBe(true)
      expect(Either.isLeft(decode("justastring"))).toBe(true)
    })

    it("provides helpful error message", () => {
      const result = decode("invalid")
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        const message = result.left.message
        expect(message).toContain("must be a valid email address")
      }
    })
  })

  describe("schema annotations", () => {
    it("has correct identifier", () => {
      expect(Email.ast.annotations[SchemaAST.IdentifierAnnotationId]).toBe(
        "Email",
      )
    })

    it("has correct title", () => {
      expect(Email.ast.annotations[SchemaAST.TitleAnnotationId]).toBe(
        "Email address",
      )
    })

    it("has correct description", () => {
      expect(Email.ast.annotations[SchemaAST.DescriptionAnnotationId]).toBe(
        "A valid email address",
      )
    })
  })

  describe("usage in struct", () => {
    it("works as a field in a struct schema", () => {
      const FormSchema = Schema.Struct({
        email: Email,
        name: Schema.String,
      })

      const decode = Schema.decodeUnknownEither(FormSchema)

      const validResult = decode({ email: "user@example.com", name: "John" })
      expect(Either.isRight(validResult)).toBe(true)

      const invalidResult = decode({ email: "invalid", name: "John" })
      expect(Either.isLeft(invalidResult)).toBe(true)
    })

    it("supports EmailField helper annotations", () => {
      const field = EmailField({ label: "Email" })

      expect(field.ast.annotations[FormLabel]).toBe("Email")
      expect(field.ast.annotations[FormAutoComplete]).toBe("email")
      expect(
        Either.isRight(Schema.decodeUnknownEither(field)("user@example.com")),
      ).toBe(true)
    })
  })
})
