// Public executable definitions; runtime callbacks stay in the process module.
import { Schema as ES } from "effect"

export const startForm = ES.Struct({})

export const immediateForm = ES.Struct({})

export const scheduledForm = ES.Struct({})
