import type { LookupItem } from "./form-schema"

const normalize = (text: string): string =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim()

/** Apply the lookup search contract to a complete eligible datasource, before limiting. */
export function searchLookupItems(
  items: readonly LookupItem[],
  filter: string,
  limit: number,
): LookupItem[] {
  const query = normalize(filter)
  if (!query) return items.slice(0, limit)
  const words = query.split(/\s+/u)
  const exact: LookupItem[] = []
  const prefix: LookupItem[] = []
  const remaining: LookupItem[] = []
  for (const item of items) {
    const label = normalize(item.label)
    const text = `${label} ${normalize(item.searchText ?? "")}`
    if (!words.every((word) => text.includes(word))) continue
    if (label === query) exact.push(item)
    else if (label.startsWith(query)) prefix.push(item)
    else remaining.push(item)
  }
  return [...exact, ...prefix, ...remaining].slice(0, limit)
}
