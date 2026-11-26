// Public executable definitions; runtime callbacks stay in the process module.
import { Schema as ES } from "effect"

export const reportIncidentForm = ES.Struct({
  incident: ES.String,
})

export const coordinateResponseForm = ES.Struct({})
