import type { ProcessDocType } from "@/lib/collections/process"

export interface MobileProcessCatalogItem {
  id: string
  title: string
  description: string
  startHref: string
}

type MobileProcessCatalogSource = Pick<
  ProcessDocType,
  "id" | "name" | "purpose" | "startStepPath"
>

const collapseWhitespace = (value: string) => value.replace(/\s+/g, " ").trim()

export const createMobileProcessCatalog = (
  processes: ReadonlyArray<MobileProcessCatalogSource>,
): MobileProcessCatalogItem[] => {
  return [...processes]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((process) => ({
      id: process.id,
      title: collapseWhitespace(process.name),
      description: collapseWhitespace(process.purpose),
      startHref: `/processes/start/${process.startStepPath}`,
    }))
}
