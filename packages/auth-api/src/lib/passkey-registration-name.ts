/**
 * Display-only model/provider hints, never authenticator trust or identity proof.
 * AAGUIDs may be hidden (all zeroes), spoofed, or shared across several models.
 * Source: passkeydeveloper/passkey-authenticator-aaguids, combined_aaguid.json
 * revision eb87f8f5e9a69ad36f2c5bd73e5883e68cb71bd2. Keep this lookup offline.
 */
const authenticatorNames = new Map<string, string>([
  ["fa2b99dc-9e39-4257-8f92-4a30d23c4118", "YubiKey 5 Series with NFC"],
  ["2fc0579f-8113-47ea-b116-bb5a8db9202a", "YubiKey 5 Series with NFC"],
  ["a25342c0-3cdc-4414-8e46-f4807fca511c", "YubiKey 5 Series with NFC"],
  ["d7781e5d-e353-46aa-afe2-3ca49f13332a", "YubiKey 5 Series with NFC"],
  ["f4ce5fc0-57d3-46f5-a736-efb7d5bc63b5", "YubiKey 5 Series with NFC"],
  ["ee882879-721c-4913-9775-3dfcce97072a", "YubiKey 5 Series"],
  ["cb69481e-8ff7-4039-93ec-0a2729a154a8", "YubiKey 5 Series"],
  ["19083c3d-8383-4b18-bc03-8f1c9ab2fd1b", "YubiKey 5 Series"],
  ["ff4dac45-ede8-4ec2-aced-cf66103f4335", "YubiKey 5 Series"],
  ["0a357157-9b18-4c8a-920e-d156e972b2f8", "YubiKey 5 Series"],
  ["c5ef55ff-ad9a-4b9f-b580-adebafe026d0", "YubiKey 5 Series with Lightning"],
  ["a02167b9-ae71-4ac7-9a07-06432ebb6f1c", "YubiKey 5 Series with Lightning"],
  ["24673149-6c86-42e7-98d9-433fb5b73296", "YubiKey 5 Series with Lightning"],
  ["d8522d9f-575b-4866-88a9-ba99fa02f35b", "YubiKey Bio Series"],
  ["dd86a2da-86a0-4cbe-b462-4bd31f57bc6f", "YubiKey Bio Series"],
  ["7409272d-1ff9-4e10-9fc9-ac0019c124fd", "YubiKey Bio Series"],
  ["f8a011f3-8c0a-4d15-8006-17111f9edc7d", "Security Key by Yubico"],
  ["b92c3f9a-c014-4056-887f-140a2501163b", "Security Key by Yubico"],
  ["149a2021-8ef6-4133-96b8-81f8d5b7f1f5", "Security Key NFC by Yubico"],
  ["6d44ba9b-f6ec-2e49-b930-0c8fe920cb73", "Security Key NFC by Yubico"],
  ["a4e9fc6d-4cbe-4758-b8ba-37598bb5bbaa", "Security Key NFC by Yubico"],
  ["b7d3f68e-88a6-471e-9ecf-2df26d041ede", "Security Key NFC by Yubico"],
  ["e77e3c64-05e3-428b-8824-0cbeb04b829d", "Security Key NFC by Yubico"],
  ["ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4", "Google Password Manager"],
  ["fbfc3007-154e-4ecc-8c0b-6e020557d7bd", "Apple Passwords"],
  ["dd4ec289-e01d-41c9-bb89-70fa845d4bf2", "iCloud Keychain (Managed)"],
  ["53414d53-554e-4700-0000-000000000000", "Samsung Pass"],
  ["bada5566-a7aa-401f-bd96-45619a55120d", "1Password"],
  ["d548826e-79b4-db40-a3d8-11116f7e8349", "Bitwarden"],
  ["531126d6-e717-415c-9320-3d9aa6981239", "Dashlane"],
  ["50726f74-6f6e-5061-7373-50726f746f6e", "Proton Pass"],
  ["fdb141b2-5d84-443e-8a35-4698c205a502", "KeePassXC"],
  ["08987058-cadc-4b81-b6e1-30de50dcbe96", "Windows Hello"],
  ["9ddd1817-af5a-4672-a2b9-3e3dd95000a9", "Windows Hello"],
  ["6028b017-b1d4-4c02-b4b3-afcdafc96bb2", "Windows Hello"],
  ["adce0002-35bc-c60a-648b-0b25f1f05503", "Chrome on Mac"],
])

/** Initial editable name; explicit user names always take precedence. */
export const passkeyRegistrationName = (credential: {
  readonly aaguid?: string
  readonly deviceType?: "singleDevice" | "multiDevice"
  readonly transports?: readonly string[]
}): string | undefined => {
  const model = authenticatorNames.get(credential.aaguid?.toLowerCase() ?? "")
  if (model) return model

  // Backup eligibility distinguishes sync-capable credentials from physical keys.
  // It does not identify a phone, provider, or where a credential is currently held.
  if (credential.deviceType === "multiDevice") return "Sync-capable passkey"

  const transports = credential.transports ?? []
  if (
    credential.deviceType === "singleDevice" &&
    transports.length > 0 &&
    transports.every((transport) => transport === "usb" || transport === "nfc")
  ) {
    if (transports.includes("usb") && transports.includes("nfc")) {
      return "USB/NFC security key"
    }
    return transports.includes("usb") ? "USB security key" : "NFC security key"
  }

  // Hybrid, internal, BLE, missing or conflicting hints cannot identify a model.
  return undefined
}
