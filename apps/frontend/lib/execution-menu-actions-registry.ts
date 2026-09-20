"use client"

import {
  type ExecutionMenuActionRegistration,
  type RegistrationDisposer,
  createRegistrationRegistry,
} from "@pf/frontend-plugin-host"

/**
 * Generic registry for org-owned execution-list menu actions.
 * Frontend stays org-agnostic; packages register actions via frontend plugins.
 */

export type { ExecutionMenuActionRegistration } from "@pf/frontend-plugin-host"

const executionMenuActions =
  createRegistrationRegistry<ExecutionMenuActionRegistration>(
    (action) => action.id,
  )

export const registerExecutionMenuAction = (
  action: ExecutionMenuActionRegistration,
): RegistrationDisposer => executionMenuActions.register(action)

export const listExecutionMenuActions =
  (): readonly ExecutionMenuActionRegistration[] => executionMenuActions.list()
