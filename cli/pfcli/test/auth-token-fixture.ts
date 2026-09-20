import { generateKeyPairSync, sign } from "node:crypto"

const { privateKey } = generateKeyPairSync("ed25519")

export const signedAuthToken = (expiresAt: number): string => {
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: "JWT" }),
  ).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({ sub: "test-user", exp: expiresAt / 1000 }),
  ).toString("base64url")
  const input = `${header}.${payload}`
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`
}
