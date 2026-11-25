// Public executable definitions; runtime callbacks stay in the process module.
import { Schema as ES } from "effect"

export const submitVendorForm = ES.Struct({
  vendor_name: ES.String,
})

export const approveVendorForm = ES.Struct({})
