import type { DocumentStore } from "./document-store"
import type { Form } from "./form"
import type { Invitation } from "./invitation"
import type { List } from "./list"
import type { OrgUnit } from "./org-unit"
import type { Organisation } from "./organisation"
import type { Process } from "./process"
import type { Role } from "./role"
import type { StatsView } from "./stats-view"
import type { Step } from "./step"

const hasBrand = (value: unknown, brand: string): boolean =>
  typeof value === "object" &&
  value !== null &&
  brand in value &&
  (value as Record<string, unknown>)[brand] === true

export const isDocumentStore = (value: unknown): value is DocumentStore =>
  hasBrand(value, "isDocumentStore")
export const isForm = (value: unknown): value is Form =>
  hasBrand(value, "isForm")
export const isInvitation = (value: unknown): value is Invitation =>
  hasBrand(value, "isInvitation")
export const isList = (value: unknown): value is List =>
  hasBrand(value, "isList")
export const isOrgUnit = (value: unknown): value is OrgUnit =>
  hasBrand(value, "isOrgUnit")
export const isOrganisation = (value: unknown): value is Organisation =>
  hasBrand(value, "isOrganisation")
export const isProcess = (value: unknown): value is Process =>
  hasBrand(value, "isProcess")
export const isRole = (value: unknown): value is Role =>
  hasBrand(value, "isRole")
export const isStatsView = (value: unknown): value is StatsView =>
  hasBrand(value, "isStatsView")
export const isStep = (value: unknown): value is Step =>
  hasBrand(value, "isStep")
