import { Result, Schema, SchemaAST } from "effect"
import { Email, EmailField } from "./email"
import { FormAutoComplete, FormLabel } from "./form-annotations"
import { describe, expect, it } from "bun:test"

describe("Email schema", () => {
  const decode = Schema.decodeUnknownResult(Email)

  describe("valid emails", () => {
    it("accepts standard email format", () => {
      expect(Result.isSuccess(decode("user@example.com"))).toBe(true)
      expect(Result.isSuccess(decode("john.doe@company.org"))).toBe(true)
      expect(Result.isSuccess(decode("test+tag@gmail.com"))).toBe(true)
    })

    it("accepts emails with subdomains", () => {
      expect(Result.isSuccess(decode("user@mail.example.com"))).toBe(true)
      expect(Result.isSuccess(decode("admin@sub.domain.org"))).toBe(true)
    })

    it("accepts emails with numeric local parts", () => {
      expect(Result.isSuccess(decode("123@example.com"))).toBe(true)
      expect(Result.isSuccess(decode("user123@example.com"))).toBe(true)
    })

    it("accepts emails with special characters in local part", () => {
      expect(Result.isSuccess(decode("user.name@example.com"))).toBe(true)
      expect(Result.isSuccess(decode("user_name@example.com"))).toBe(true)
      expect(Result.isSuccess(decode("user-name@example.com"))).toBe(true)
    })
  })

  describe("localhost and development emails", () => {
    it("accepts localhost emails (require_tld: false)", () => {
      expect(Result.isSuccess(decode("user@localhost"))).toBe(true)
      expect(Result.isSuccess(decode("admin@localhost"))).toBe(true)
    })

    it("accepts IP domain emails (allow_ip_domain: true)", () => {
      expect(Result.isSuccess(decode("user@[127.0.0.1]"))).toBe(true)
      expect(Result.isSuccess(decode("user@[192.168.1.1]"))).toBe(true)
    })
  })

  describe("UTF-8 and IDN support", () => {
    it("accepts UTF-8 local parts (allow_utf8_local_part: true)", () => {
      expect(Result.isSuccess(decode("üñîcödé@example.com"))).toBe(true)
      expect(Result.isSuccess(decode("用户@example.com"))).toBe(true)
      expect(Result.isSuccess(decode("пользователь@example.com"))).toBe(true)
    })

    it("accepts IDN/punycode domains", () => {
      expect(Result.isSuccess(decode("user@日本語.jp"))).toBe(true)
      expect(Result.isSuccess(decode("user@例え.jp"))).toBe(true)
      expect(Result.isSuccess(decode("user@münchen.de"))).toBe(true)
    })
  })

  describe("trimming behavior", () => {
    it("trims leading whitespace", () => {
      const result = decode("  user@example.com")
      expect(Result.isSuccess(result)).toBe(true)
      if (Result.isSuccess(result)) {
        expect(result.success).toBe("user@example.com")
      }
    })

    it("trims trailing whitespace", () => {
      const result = decode("user@example.com  ")
      expect(Result.isSuccess(result)).toBe(true)
      if (Result.isSuccess(result)) {
        expect(result.success).toBe("user@example.com")
      }
    })

    it("trims both leading and trailing whitespace", () => {
      const result = decode("  user@example.com  ")
      expect(Result.isSuccess(result)).toBe(true)
      if (Result.isSuccess(result)) {
        expect(result.success).toBe("user@example.com")
      }
    })
  })

  describe("invalid emails", () => {
    it("rejects empty string", () => {
      expect(Result.isFailure(decode(""))).toBe(true)
    })

    it("rejects whitespace only", () => {
      expect(Result.isFailure(decode("   "))).toBe(true)
    })

    it("rejects missing @ symbol", () => {
      expect(Result.isFailure(decode("userexample.com"))).toBe(true)
    })

    it("rejects missing local part", () => {
      expect(Result.isFailure(decode("@example.com"))).toBe(true)
    })

    it("rejects missing domain", () => {
      expect(Result.isFailure(decode("user@"))).toBe(true)
    })

    it("rejects multiple @ symbols", () => {
      expect(Result.isFailure(decode("user@@example.com"))).toBe(true)
      expect(Result.isFailure(decode("user@domain@example.com"))).toBe(true)
    })

    it("rejects spaces in the middle", () => {
      expect(Result.isFailure(decode("user @example.com"))).toBe(true)
      expect(Result.isFailure(decode("user@ example.com"))).toBe(true)
      expect(Result.isFailure(decode("us er@example.com"))).toBe(true)
    })

    it("rejects invalid domain formats", () => {
      expect(Result.isFailure(decode("user@.com"))).toBe(true)
      expect(Result.isFailure(decode("user@example."))).toBe(true)
      expect(Result.isFailure(decode("user@-example.com"))).toBe(true)
    })

    it("rejects plain text", () => {
      expect(Result.isFailure(decode("not an email"))).toBe(true)
      expect(Result.isFailure(decode("justastring"))).toBe(true)
    })

    it("provides helpful error message", () => {
      const result = decode("invalid")
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        const message = result.failure.message
        expect(message).toContain("must be a valid email address")
      }
    })
  })

  describe("schema annotations", () => {
    it("has correct identifier", () => {
      expect(SchemaAST.resolveIdentifier(Email.ast)).toBe("Email")
    })

    it("has correct title", () => {
      expect(SchemaAST.resolveTitle(Email.ast)).toBe("Email address")
    })

    it("has correct description", () => {
      expect(SchemaAST.resolveDescription(Email.ast)).toBe(
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

      const decode = Schema.decodeUnknownResult(FormSchema)

      const validResult = decode({ email: "user@example.com", name: "John" })
      expect(Result.isSuccess(validResult)).toBe(true)

      const invalidResult = decode({ email: "invalid", name: "John" })
      expect(Result.isFailure(invalidResult)).toBe(true)
    })

    it("supports EmailField helper annotations", () => {
      const field = EmailField({ label: "Email" })

      expect(Reflect.get(SchemaAST.resolve(field.ast) ?? {}, FormLabel)).toBe(
        "Email",
      )
      expect(
        Reflect.get(SchemaAST.resolve(field.ast) ?? {}, FormAutoComplete),
      ).toBe("email")
      expect(
        Result.isSuccess(Schema.decodeUnknownResult(field)("user@example.com")),
      ).toBe(true)
    })
  })
})
