import { Effect } from "effect"

/**
 * Hash a secret using Argon2id algorithm.
 * Uses Bun's built-in password hashing API for production-grade security.
 *
 * @param secret - The plaintext secret to hash
 * @returns Effect containing the hashed secret
 */
export const hashSecret = (secret: string): Effect.Effect<string> =>
  Effect.promise(() => Bun.password.hash(secret, { algorithm: "argon2id" }))

/**
 * Verify a plaintext secret against a hashed secret.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @param secret - The plaintext secret to verify
 * @param hash - The stored hash to verify against
 * @returns Effect containing true if the secret matches, false otherwise
 */
export const verifySecret = (
  secret: string,
  hash: string,
): Effect.Effect<boolean> =>
  Effect.promise(() => Bun.password.verify(secret, hash))
