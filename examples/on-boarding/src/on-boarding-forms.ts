// Public executable definitions; runtime callbacks stay in the process module.
import { Schema as ES } from "effect"

export const sendWelcomePackForm = ES.Struct({
  first_name: ES.String,
  last_name: ES.String,
  start_date: ES.DateTimeUtcFromString,
})

export const backgroundCheckForm = ES.Struct({})

export const createAccountForm = ES.Struct({})

export const provisionLaptopForm = ES.Struct({})

export const assignDeskForm = ES.Struct({})

export const assignIDBadgeForm = ES.Struct({})

export const onboardingChecklistForm = ES.Struct({})

export const orientationSessionForm = ES.Struct({})

export const provideLaptopAndBadgeForm = ES.Struct({})

export const review306090DayPlanForm = ES.Struct({})

export const complianceTrainingForm = ES.Struct({})

export const meetWithEmployeeForm = ES.Struct({})

export const formalPerformanceReviewForm = ES.Struct({
  passed: ES.Boolean,
})

export const passedForm = ES.Struct({})

export const probationFailedForm = ES.Struct({
  // TODO: needs to become one selection, starts separate process
  start_offboarding: ES.Boolean,
  start_improvement_process: ES.Boolean,
})
